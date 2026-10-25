/**
 * КТП → lesson plans (contract 0.5.0 §6). A teacher uploads a КТП (.docx,
 * base64); it is parsed, checked and linked to Bilig topics, then stored as a
 * TeachingPlan. Lesson plans (.docx) are generated on request for one lesson
 * or a range. Owner-only: another user's plan is 404. Writes need If-Match.
 */
import type { FastifyInstance } from 'fastify';
import type { Lang } from '@bilig/content-model';
import { DEFAULT_LESSON_MODEL, lessonModel, t, type Textbook } from '@bilig/content-model';
import { CONTENTS_MAX_IMAGE_BYTES, DOCX_MEDIA_TYPE, KTP_MAX_BYTES, SCHOOL_WEEKS, type KtpContentsResponse, type KtpRow, type TextbookDraft } from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { fail } from '../http/errors.js';
import { route } from '../http/route.js';
import { newId } from '../ids.js';
import { pageOf } from '../repo/paging.js';
import type { TeachingPlanRec } from '../repo/types.js';
import { DocxError, readDocx } from '../ktp/docx-read.js';
import { CONTENTS_SCHEMA, contentsPrompt, finishDraft, fromModel, looksParsed, parseContentsText } from '../ktp/contents.js';
import { draftKtpFromTextbook } from '../ktp/from-textbook.js';
import { ktpDocx } from '../ktp/ktp-docx.js';
import { buildTopicIndex, matchTitle } from '../ktp/match.js';
import { parseKtp, subjectKeyOf } from '../ktp/parse.js';
import { detectLang } from '../domain/lang.js';
import { getTutorSettings } from '../services/tutor-settings.js';
import { usageCostUsd } from '../config.js';
import { budgetKey } from './tutor.js';
import { bookAsTextbook } from '../services/books.js';
import { buildPlanContent, type PlanContent } from '../ktp/plan-content.js';
import { renderPlansDocx } from '../ktp/plan-docx.js';
import { lessonBodyOf } from '../ktp/lesson-content.js';
import { lessonPlanContent } from '../ktp/lesson-plan.js';
import { createPlanDoc, ktpClass, patchPlanDoc, planDocOf, recheck, toSummary, toTeachingPlan, type MatchSources, type PlanDoc } from '../ktp/teaching-plan.js';
import { taughtClasses } from '../services/profile.js';

export const KTP_UPLOADS_PER_HOUR = 20;
/** v0.9.2: contents readings per teacher and hour (images cost model tokens). */
export const KTP_CONTENTS_PER_HOUR = 15;
/** Body limit for POST /ktp/contents: up to 24 page images. */
export const KTP_CONTENTS_BODY_LIMIT = 24 * (Math.ceil((CONTENTS_MAX_IMAGE_BYTES * 4) / 3) + 64) + 64 * 1024;

/** The school year a date falls in (2026 for 1 Jul 2026 … 30 Jun 2027). */
export const schoolYearOf = (d: Date) => (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);

/** Text of a .docx for the contents reader: paragraphs, and table rows as «cell cell … page». */
function docxText(buf: Buffer): string {
  const doc = readDocx(buf);
  return doc.blocks
    .flatMap((b) => (b.kind === 'p' ? [b.text] : b.table.rows.map((r) => r.map((c) => c.text).filter(Boolean).join(' '))))
    .join('\n');
}
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

/** v0.8.0: a class label for matching («8 Б», «8-б», «8б» are the same class). */
export const normClassName = (s: string) => s.toLocaleLowerCase('ru').replace(/[\s\-–—«»"'.]/g, '');

/** v0.8.0: link each КТП class column to the teacher's class of the same name (or null). */
export function matchClassLinks(columns: readonly string[], classes: readonly { id: string; name: string }[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const col of columns) {
    const hits = classes.filter((c) => normClassName(c.name) === normClassName(col));
    out[col] = hits.length === 1 ? hits[0].id : null;
  }
  return out;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 60) || 'class';

/**
 * v0.9.2: a preliminary КТП from a book's chapters (v0.10.0: also the chapters drafted from the subject
 * standard): the lesson list fitted to the hours, without dates, stored as a new plan of the teacher.
 */
export async function createBookPlan(
  deps: Pick<Deps, 'repo' | 'content' | 'clock'>,
  a: {
    ownerId: string;
    teacherName: string;
    book: Pick<Textbook, 'chapters'> & { grade: number | null };
    lang: Lang;
    subjectKey: string | null;
    sourceName: string;
    hoursPerWeek: number;
    weeks?: number;
    year?: number;
    classes?: string[];
    /** Only the chapters of this subject (an integrated book). */
    onlySubject?: string;
    /** v0.10.0: lessons to fit instead of hours a week × weeks. */
    lessons?: number;
    origin: NonNullable<PlanDoc['origin']>;
  },
): Promise<TeachingPlanRec> {
  const { repo, content, clock } = deps;
  const src = await content.ktpSources();
  const catalog = await content.catalog(a.lang);
  const { book, lang, subjectKey, sourceName } = a;
  const grade = book.grade;
  const subjectTitle = (subjectKey && catalog.subjects.find((s) => s.key === subjectKey)?.title) || sourceName;
  const subjectName = typeof subjectTitle === 'string' ? subjectTitle : t(subjectTitle, lang);
  const classes = a.classes?.length ? [...new Set(a.classes.map(ktpClass))] : grade ? [String(grade)] : [];
  const draft = draftKtpFromTextbook(book, subjectName, { lang, hoursPerWeek: a.hoursPerWeek, weeks: a.weeks ?? SCHOOL_WEEKS, classes, ...(a.onlySubject ? { subjectKey: a.onlySubject } : {}), ...(a.lessons ? { lessons: a.lessons } : {}) });
  const year = a.year ?? schoolYearOf(clock.now());
  const doc = recheck({
    title: draft.title,
    subjectName,
    subjectKey: subjectKey && src.subjectKeys.has(subjectKey) ? subjectKey : null,
    grade,
    lang,
    teacherName: a.teacherName,
    schoolName: '',
    year,
    classes: draft.classes,
    declaredHours: draft.rows.length,
    rows: draft.rows,
    sourceName: sourceName.slice(0, 200),
    origin: a.origin,
    invalidDates: {},
  });
  doc.classLinks = matchClassLinks(doc.classes, await taughtClasses(repo, a.ownerId));
  const now = clock.now();
  const rec: TeachingPlanRec = { id: newId(), ownerId: a.ownerId, title: doc.title, doc, version: 1, createdAt: now, updatedAt: now };
  await repo.createTeachingPlan(rec);
  return rec;
}

export function registerKtp(app: FastifyInstance, deps: Deps) {
  const { repo, clock, content, limiter, audit, config } = deps;

  async function own(uid: string, id: string): Promise<TeachingPlanRec> {
    const p = await repo.getTeachingPlan(id);
    if (!p || p.ownerId !== uid) fail('not_found', { detail: 'teaching_plan' });
    // Class labels in capitals and a uid on every row for every use (a plan saved before keeps «8б» and
    // rows without uids in storage until its next save).
    return { ...p, doc: planDocOf(p) };
  }

  async function sources(): Promise<MatchSources> {
    const src = await content.ktpSources();
    return { index: buildTopicIndex(src.packages, src.textbooks), subjectKeys: src.subjectKeys };
  }

  async function plansDocx(rec: TeachingPlanRec, rows: KtpRow[], asked: string, lang: Lang | undefined): Promise<Buffer> {
    const doc = rec.doc as PlanDoc;
    const cls = ktpClass(asked); // «?class=8б» from an old link still finds «8Б»
    if (!doc.classes.includes(cls)) fail('validation_failed', { detail: `class must be one of: ${doc.classes.join(', ')}` });
    const src = await content.ktpSources();
    const byKey = new Map(src.packages.map((p) => [p.topic.key, p]));
    const planLang = lang ?? doc.lang;
    // v0.10.0: lessons with a saved lesson page are filled from it (its model, else the owner's default).
    const saved = new Map((await repo.listLessonContents({ planIds: [rec.id], uids: rows.map((r) => r.uid) })).map((c) => [c.uid, c]));
    const ownerModel = saved.size ? ((await repo.getUser(rec.ownerId))?.defaultLessonModel ?? null) : null;
    const contents: PlanContent[] = rows.map((row) => {
      const pkg = row.topicKey ? byKey.get(row.topicKey) : undefined;
      const prev = doc.rows.find((r) => r.index === row.index - 1) ?? null;
      const base = buildPlanContent({
        plan: { subjectName: doc.subjectName, subjectKey: doc.subjectKey, grade: doc.grade, teacherName: doc.teacherName },
        row,
        prev,
        cls,
        lang: planLang,
        topic: pkg ? { pkg, textbooks: src.textbooks } : null,
      });
      const c = saved.get(row.uid);
      if (!c) return base;
      const body = lessonBodyOf(c);
      return lessonPlanContent({ base, row, body, model: lessonModel(body.modelId ?? ownerModel ?? DEFAULT_LESSON_MODEL), lang: planLang });
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
      doc.origin = 'upload';
      doc.classLinks = matchClassLinks(doc.classes, await taughtClasses(repo, uid));
      const now = clock.now();
      const rec: TeachingPlanRec = { id: newId(), ownerId: uid, title: doc.title, doc, version: 1, createdAt: now, updatedAt: now };
      await repo.createTeachingPlan(rec);
      await audit.log(uid, 'ktp.created', { type: 'teaching_plan', id: rec.id, label: rec.title }, { ip, diff: { lessons: doc.rows.length, classes: doc.classes.length, linked: Object.values(doc.classLinks).filter(Boolean).length } });
      return toTeachingPlan(rec);
    },
    { bodyLimit: KTP_BODY_LIMIT },
  );

  route(app, deps, 'ktpGet', async ({ userId, params }) => toTeachingPlan(await own(userId(), params.id)));

  route(app, deps, 'ktpPatch', async ({ userId, params, body, ifMatch, ip }) => {
    const uid = userId();
    const cur = await own(uid, params.id);
    if (ifMatch !== body.version || cur.version !== ifMatch) fail('version_mismatch', { detail: `current version is ${cur.version}` });
    const next = patchPlanDoc(cur.doc as PlanDoc, body, await sources());
    // v0.10.0: a row patch for a row that moved (another tab inserted or removed lessons) is a conflict.
    if ('error' in next) fail(next.conflict ? 'version_mismatch' : 'validation_failed', { detail: next.error });
    // v0.8.0: class links — a КТП class column → one of the teacher's classes (or null).
    if (body.classLinks) {
      const mine = new Set((await taughtClasses(repo, uid)).map((c) => c.id));
      const links = { ...(next.classLinks ?? matchClassLinks(next.classes, [])) };
      for (const [col, classId] of Object.entries(body.classLinks)) {
        if (!next.classes.includes(col)) fail('validation_failed', { detail: `classLinks.${col}`, issues: [{ path: ['classLinks', col], message: `Not a class of this КТП (${next.classes.join(', ')})` }] });
        if (classId !== null && !mine.has(classId)) fail('validation_failed', { detail: `classLinks.${col}`, issues: [{ path: ['classLinks', col], message: 'Not one of your classes' }] });
        links[col] = classId;
      }
      next.classLinks = links;
    }
    const res = await repo.updateTeachingPlan(cur.id, { doc: next, title: next.title }, ifMatch);
    if (res === 'not_found') fail('not_found', { detail: 'teaching_plan' });
    if (res === 'version_mismatch') fail('version_mismatch');
    // v0.10.0: a removed lesson's content goes with it.
    if (body.remove?.length) await repo.deleteLessonContents(cur.id, body.remove);
    const { version: _v, rows, remove, insert, ...fields } = body;
    await audit.log(uid, 'ktp.updated', { type: 'teaching_plan', id: cur.id, label: res.title }, {
      ip,
      after: { ...fields, ...(rows ? { rows: rows.length } : {}), ...(remove ? { remove: remove.length } : {}), ...(insert ? { insert: insert.length } : {}), version: res.version },
    });
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
    const date = row.dates[ktpClass(query.class)] ?? 'no-date';
    return { body, contentType: DOCX_MEDIA_TYPE, filename: `plan_${safeName(ktpClass(query.class))}_${date}_${row.index}.docx` };
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
    return { body, contentType: DOCX_MEDIA_TYPE, filename: `plans_${safeName(ktpClass(query.class))}_${first}-${last}.docx` };
  });

  // --- v0.9.2: a preliminary КТП from a textbook ---------------------------------------------

  route(
    app,
    deps,
    'ktpContents',
    async ({ req, userId, body }) => {
      const uid = userId();
      const r = await limiter.hit(`ktp-contents:${uid}`, KTP_CONTENTS_PER_HOUR, 3600);
      if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
      const text = body.pages ? body.pages.join('\n') : body.docx ? (() => {
        try {
          return docxText(decodeKtpUpload(body.docx));
        } catch (e) {
          if (e instanceof DocxError) fail('validation_failed', { detail: `invalid .docx: ${e.code}` });
          throw e;
        }
      })() : '';
      let chapters = text ? parseContentsText(text) : [];
      let source: KtpContentsResponse['source'] = 'text';
      let contentsPages: number[] = [];
      let modelTitle = '';
      let modelGrade: number | null = null;
      // Images, or text the parser could not read as contents: the model reads them.
      if (body.images?.length || !looksParsed(chapters)) {
        const settings = await getTutorSettings(repo, config);
        const provider = deps.tutor;
        if (!provider || !settings.enabled || provider.name === 'dev') fail('tutor_unavailable', { detail: 'offline' });
        if ((await limiter.get(budgetKey(clock.now()))) >= settings.dailyTokenBudget) fail('tutor_unavailable', { detail: 'budget_exhausted' });
        const images = (body.images ?? []).map((u) => (u.startsWith('data:') ? u : `data:image/jpeg;base64,${u}`));
        if (images.some((u) => !/^data:image\/(jpeg|png|webp);base64,/.test(u))) fail('validation_failed', { detail: 'images must be JPEG, PNG or WebP' });
        try {
          const res = await provider.generate({
            model: settings.model,
            system: 'You read school textbooks for teachers in Kyrgyzstan and copy their table of contents exactly.',
            prompt: images.length ? contentsPrompt(images.length, body.lang) : `${contentsPrompt(0, body.lang).replace(/^These are 0 page images[^\n]*\n/, 'Here is the text of the first and last pages of a school textbook.\n')}\n\n<pages>\n${text.slice(0, 60_000)}\n</pages>`,
            schema: CONTENTS_SCHEMA,
            maxTokens: 8000,
            ...(images.length ? { images } : {}),
          });
          await limiter.add(budgetKey(clock.now()), res.usage.inputTokens + res.usage.outputTokens, 2 * 86400);
          req.log.info({ purpose: 'ktp.contents', images: images.length, inputTokens: res.usage.inputTokens, cachedInputTokens: res.usage.cachedInputTokens ?? 0, outputTokens: res.usage.outputTokens, costUsd: Number(usageCostUsd(res.usage, config.tutorPrices).toFixed(6)) }, 'tutor.usage');
          const m = fromModel(res.data);
          if (m.chapters.length) [chapters, contentsPages, modelTitle, modelGrade, source] = [m.chapters, m.contentsImages, m.title, m.grade, 'assistant'];
        } catch (err) {
          req.log.warn({ err }, 'ktp.contents: provider failed');
          if (!chapters.length) fail('tutor_unavailable', { detail: 'provider_error' });
        }
      }
      const all = [text, modelTitle, ...chapters.flatMap((c) => [c.title, ...c.lessons.map((l) => l.title)])].join('\n');
      const lang = body.lang ?? detectLang(all, 'ky');
      const firstLine = text.split(/\n/).map((x) => x.trim()).find((x) => x && !/^(мазмуну|содержание|оглавление|contents)/i.test(x)) ?? '';
      const title = modelTitle || firstLine.slice(0, 120) || body.fileName.replace(/\.[^.]{1,5}$/, '');
      const grade = body.grade ?? modelGrade ?? (() => {
        const g = /(?<!\d)(1[0-2]|[1-9])\s*[-‑–]?\s*(?:класс|class|кл\b|grade)/iu.exec(`${title} ${body.fileName}`) ?? /(?:grade|класс)\s*(1[0-2]|[1-9])(?!\d)/iu.exec(`${title} ${body.fileName}`);
        return g ? Number(g[1]) : null;
      })();
      const src = await sources();
      const guessed = body.subjectKey ?? subjectKeyOf(`${title} ${body.fileName}`);
      const subjectKey = guessed && src.subjectKeys.has(guessed) ? guessed : null;
      const { draft, warnings } = finishDraft(chapters, { title, grade, lang, subjectKey });
      // Link every § to a Bilig topic of the book's subject and grade (the same matcher as an uploaded КТП).
      for (const c of draft.chapters)
        for (const l of c.lessons) {
          if (l.kind !== 'lesson') continue;
          const hit = matchTitle(src.index, l.title, { subjectKey, grade });
          l.topicKey = hit?.topicKey ?? null;
        }
      return { draft, source, contentsPages, warnings };
    },
    { bodyLimit: KTP_CONTENTS_BODY_LIMIT },
  );

  route(app, deps, 'ktpFromTextbook', async ({ auth, userId, body, ip }) => {
    const uid = userId();
    const r = await limiter.hit(`ktp-upload:${uid}`, KTP_UPLOADS_PER_HOUR, 3600);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
    const src = await content.ktpSources();
    let book: Pick<Textbook, 'chapters'> & { grade: number | null };
    let bookLang: Lang;
    let subjectKey: string | null;
    let sourceName: string;
    if (body.bookId) {
      // v0.9.3: a published book of the library (its § with pages and topics).
      const b = /^[0-9a-f-]{36}$/i.test(body.bookId) ? await repo.getBook(body.bookId) : null;
      if (!b || b.status !== 'published') fail('not_found', { detail: 'book' });
      book = bookAsTextbook(b, await repo.listBookSections(b.id)) as never;
      bookLang = b.lang;
      subjectKey = body.subjectKey ?? b.subjectKey;
      sourceName = b.title;
    } else if (body.textbookKey) {
      const tb = src.textbooks.find((x) => x.key === body.textbookKey);
      if (!tb) fail('not_found', { detail: 'textbook' });
      book = tb;
      bookLang = tb.lang;
      subjectKey = body.subjectKey ?? tb.chapters[0]?.subjectKey ?? null;
      sourceName = t(tb.title, body.lang ?? tb.lang);
    } else {
      const d = body.draft as TextbookDraft;
      const index = buildTopicIndex(src.packages, src.textbooks);
      subjectKey = body.subjectKey ?? d.subjectKey;
      const L = (s: string) => ({ ky: s, ru: s, en: s });
      // The teacher's draft → the textbook shape: one language for every title, topics as checked (or matched).
      book = {
        grade: d.grade,
        chapters: d.chapters.map((c, ci) => ({
          key: `c${ci}`,
          number: c.number || '',
          title: L(c.title),
          subjectKey: subjectKey ?? 'x',
          lessons: c.lessons.map((l, li) => ({
            key: `c${ci}.l${li}`,
            number: l.number,
            kind: l.kind,
            title: L(l.title),
            ...(l.pages ? { pages: l.pages } : {}),
            topicKeys: l.topicKey === undefined ? (l.kind === 'lesson' ? [matchTitle(index, l.title, { subjectKey, grade: d.grade })?.topicKey].filter((k): k is string => !!k) : []) : l.topicKey ? [l.topicKey] : [],
          })),
        })),
      };
      bookLang = d.lang;
      sourceName = d.title;
    }
    const rec = await createBookPlan(deps, {
      ownerId: uid,
      teacherName: auth.user?.displayName ?? '',
      book,
      lang: body.lang ?? bookLang,
      subjectKey,
      sourceName,
      hoursPerWeek: body.hoursPerWeek,
      weeks: body.weeks,
      year: body.year,
      classes: body.classes,
      ...(body.textbookKey && body.subjectKey ? { onlySubject: body.subjectKey } : {}),
      origin: 'textbook',
    });
    await audit.log(uid, 'ktp.created', { type: 'teaching_plan', id: rec.id, label: rec.title }, { ip, diff: { from: body.textbookKey ? `textbook:${body.textbookKey}` : 'contents', lessons: (rec.doc as PlanDoc).rows.length, hoursPerWeek: body.hoursPerWeek } });
    return toTeachingPlan(rec);
  });

  route(app, deps, 'ktpDocx', async ({ userId, params }) => {
    const uid = userId();
    const rec = await own(uid, params.id);
    await downloadLimit(uid);
    const doc = rec.doc as PlanDoc;
    const src = await content.ktpSources();
    const byKey = new Map(src.packages.map((p) => [p.topic.key, p]));
    const hoursPerWeek = Math.round(doc.totalHours / SCHOOL_WEEKS) || undefined;
    const body = ktpDocx({
      // v0.10.0: «(алдын ала)» only while a plan from a textbook / the standard is not scheduled (uploads never).
      draft: doc.origin !== 'upload' && !Object.keys(doc.schedule ?? {}).length,
      title: doc.title,
      subjectName: doc.subjectName,
      grade: doc.grade,
      year: doc.year,
      lang: doc.lang,
      teacherName: doc.teacherName,
      schoolName: doc.schoolName,
      classes: doc.classes,
      rows: doc.rows,
      topicTitle: (k) => {
        const p = byKey.get(k);
        return p ? t(p.topic.title, doc.lang) : undefined;
      },
      ...(hoursPerWeek && hoursPerWeek * SCHOOL_WEEKS === doc.totalHours ? { hoursPerWeek } : {}),
    });
    return { body, contentType: DOCX_MEDIA_TYPE, filename: `KTP_${safeName(doc.title)}.docx` };
  });
}
