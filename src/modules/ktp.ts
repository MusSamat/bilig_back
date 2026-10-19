/**
 * КТП → lesson plans (contract 0.5.0 §6). A teacher uploads a КТП (.docx,
 * base64); it is parsed, checked and linked to Bilig topics, then stored as a
 * TeachingPlan. Lesson plans (.docx) are generated on request for one lesson
 * or a range. Owner-only: another user's plan is 404. Writes need If-Match.
 */
import type { FastifyInstance } from 'fastify';
import type { Lang } from '@bilig/content-model';
import { DOCX_MEDIA_TYPE, KTP_MAX_BYTES, type KtpRow } from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { fail } from '../http/errors.js';
import { route } from '../http/route.js';
import { newId } from '../ids.js';
import { pageOf } from '../repo/paging.js';
import type { TeachingPlanRec } from '../repo/types.js';
import { DocxError, readDocx } from '../ktp/docx-read.js';
import { buildTopicIndex } from '../ktp/match.js';
import { parseKtp } from '../ktp/parse.js';
import { buildPlanContent, type PlanContent } from '../ktp/plan-content.js';
import { renderPlansDocx } from '../ktp/plan-docx.js';
import { createPlanDoc, patchPlanDoc, toSummary, toTeachingPlan, type MatchSources, type PlanDoc } from '../ktp/teaching-plan.js';

export const KTP_UPLOADS_PER_HOUR = 20;
export const KTP_PLAN_DOWNLOADS_PER_HOUR = 300;
/** Body limit for POST /ktp: the contract's base64 limit (4/3 · KTP_MAX_BYTES + 8) plus room for the JSON envelope. */
export const KTP_BODY_LIMIT = Math.ceil((KTP_MAX_BYTES * 4) / 3) + 8 + 64 * 1024;

const B64_RE = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;

/** Decode the uploaded base64 (a `data:` prefix is tolerated) with the size cap. */
export function decodeKtpUpload(data: string): Buffer {
  const b64 = data.replace(/^data:[\w.+/-]+;base64,/, '');
  if (!B64_RE.test(b64)) fail('validation_failed', { detail: 'data must be base64' });
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > KTP_MAX_BYTES) fail('payload_too_large', { detail: `file > ${KTP_MAX_BYTES} bytes` });
  if (!buf.length) fail('validation_failed', { detail: 'empty file' });
  return buf;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 60) || 'class';

export function registerKtp(app: FastifyInstance, deps: Deps) {
  const { repo, clock, content, limiter, audit } = deps;

  async function own(uid: string, id: string): Promise<TeachingPlanRec> {
    const p = await repo.getTeachingPlan(id);
    if (!p || p.ownerId !== uid) fail('not_found', { detail: 'teaching_plan' });
    return p;
  }

  async function sources(): Promise<MatchSources> {
    const src = await content.ktpSources();
    return { index: buildTopicIndex(src.packages, src.textbooks), subjectKeys: src.subjectKeys };
  }

  async function plansDocx(rec: TeachingPlanRec, rows: KtpRow[], cls: string, lang: Lang | undefined): Promise<Buffer> {
    const doc = rec.doc as PlanDoc;
    if (!doc.classes.includes(cls)) fail('validation_failed', { detail: `class must be one of: ${doc.classes.join(', ')}` });
    const src = await content.ktpSources();
    const byKey = new Map(src.packages.map((p) => [p.topic.key, p]));
    const planLang = lang ?? doc.lang;
    const contents: PlanContent[] = rows.map((row) => {
      const pkg = row.topicKey ? byKey.get(row.topicKey) : undefined;
      const prev = doc.rows.find((r) => r.index === row.index - 1) ?? null;
      return buildPlanContent({
        plan: { subjectName: doc.subjectName, subjectKey: doc.subjectKey, grade: doc.grade, teacherName: doc.teacherName },
        row,
        prev,
        cls,
        lang: planLang,
        topic: pkg ? { pkg, textbooks: src.textbooks } : null,
      });
    });
    return renderPlansDocx(contents);
  }

  async function downloadLimit(uid: string) {
    const r = await limiter.hit(`ktp-doc:${uid}`, KTP_PLAN_DOWNLOADS_PER_HOUR, 3600);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
  }

  route(app, deps, 'ktpList', async ({ userId, query }) => {
    const res = await repo.listTeachingPlans(userId(), pageOf(query));
    return { items: res.items.map(toSummary), nextCursor: res.nextCursor };
  });

  route(
    app,
    deps,
    'ktpCreate',
    async ({ userId, body, ip }) => {
      const uid = userId();
      const r = await limiter.hit(`ktp-upload:${uid}`, KTP_UPLOADS_PER_HOUR, 3600);
      if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
      const buf = decodeKtpUpload(body.data);
      let parsed;
      try {
        parsed = parseKtp(readDocx(buf), { now: clock.now() });
      } catch (e) {
        if (e instanceof DocxError) {
          if (e.code === 'too_large') fail('payload_too_large', { detail: `docx: ${e.message}` });
          fail('validation_failed', { detail: `invalid .docx: ${e.code}` });
        }
        throw e;
      }
      const src = await sources();
      const doc = createPlanDoc(parsed, { sourceName: body.fileName, lang: body.lang, index: src.index, subjectKeys: src.subjectKeys });
      const now = clock.now();
      const rec: TeachingPlanRec = { id: newId(), ownerId: uid, title: doc.title, doc, version: 1, createdAt: now, updatedAt: now };
      await repo.createTeachingPlan(rec);
      await audit.log(uid, 'ktp.created', { type: 'teaching_plan', id: rec.id }, { ip, diff: { lessons: doc.rows.length, classes: doc.classes.length } });
      return toTeachingPlan(rec);
    },
    { bodyLimit: KTP_BODY_LIMIT },
  );

  route(app, deps, 'ktpGet', async ({ userId, params }) => toTeachingPlan(await own(userId(), params.id)));

  route(app, deps, 'ktpPatch', async ({ userId, params, body, ifMatch }) => {
    const cur = await own(userId(), params.id);
    if (ifMatch !== body.version || cur.version !== ifMatch) fail('version_mismatch', { detail: `current version is ${cur.version}` });
    const next = patchPlanDoc(cur.doc as PlanDoc, body, await sources());
    if ('error' in next) fail('validation_failed', { detail: next.error });
    const res = await repo.updateTeachingPlan(cur.id, { doc: next, title: next.title }, ifMatch);
    if (res === 'not_found') fail('not_found', { detail: 'teaching_plan' });
    if (res === 'version_mismatch') fail('version_mismatch');
    return toTeachingPlan(res);
  });

  route(app, deps, 'ktpDelete', async ({ userId, params, ifMatch, ip }) => {
    const uid = userId();
    const cur = await own(uid, params.id);
    const res = await repo.deleteTeachingPlan(cur.id, ifMatch);
    if (res === 'not_found') fail('not_found', { detail: 'teaching_plan' });
    if (res === 'version_mismatch') fail('version_mismatch', { detail: `current version is ${cur.version}` });
    await audit.log(uid, 'ktp.deleted', { type: 'teaching_plan', id: cur.id }, { ip });
    return { ok: true as const };
  });

  route(app, deps, 'ktpLessonPlan', async ({ userId, params, query }) => {
    const uid = userId();
    const rec = await own(uid, params.id);
    const index = /^\d{1,4}$/.test(params.index) ? Number(params.index) : NaN;
    const row = (rec.doc as PlanDoc).rows.find((r) => r.index === index);
    if (!row) fail('not_found', { detail: 'lesson' });
    await downloadLimit(uid);
    const body = await plansDocx(rec, [row], query.class, query.lang);
    const date = row.dates[query.class] ?? 'no-date';
    return { body, contentType: DOCX_MEDIA_TYPE, filename: `plan_${safeName(query.class)}_${date}_${row.index}.docx` };
  });

  route(app, deps, 'ktpLessonPlans', async ({ userId, params, query }) => {
    const uid = userId();
    const rec = await own(uid, params.id);
    const rows = (rec.doc as PlanDoc).rows.filter((r) => r.index >= query.from && r.index <= query.to);
    if (!rows.length) fail('not_found', { detail: 'lessons' });
    await downloadLimit(uid);
    const body = await plansDocx(rec, rows, query.class, query.lang);
    const first = rows[0].index;
    const last = rows[rows.length - 1].index;
    return { body, contentType: DOCX_MEDIA_TYPE, filename: `plans_${safeName(query.class)}_${first}-${last}.docx` };
  });
}
