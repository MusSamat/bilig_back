/**
 * Admin: program structure and dictionary CRUD (A-02, A-03, A-04, A-08,
 * A-10, A-12) — subject groups, subjects, courses, units, objectives,
 * concepts, processes, items, glossary. Table-driven over `repo.content(kind)`.
 *
 *  - Writes are scoped to the entry's owning subject (`subjectKeyFor`):
 *    authors/editors only inside their subject; shared entries (no subject)
 *    only with a platform grant. Subjects and groups need `platform.manage`.
 *    Glossary and textbook writes need `content.publish` (any subject's editor) — they are shared.
 *  - PATCH = partial merge onto the stored doc, re-validated with the full
 *    schema; If-Match (and `body.version`) must equal the stored version.
 *  - Author sub-roles: the changed paths are classified into field groups
 *    (strings = Localized values, assets = asset/thumb/icon, structure = the
 *    rest) and checked with `canEditField` — a translator may only touch strings.
 *  - DELETE refuses (409 `in_use`) while the entry is referenced.
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  ConceptSchema,
  CourseSchema,
  GlossaryTermSchema,
  ItemSchema,
  ObjectiveSchema,
  ProcessSchema,
  SubjectGroupSchema,
  SubjectSchema,
  TextbookSchema,
  UnitSchema,
} from '@bilig/content-model';
import type { EndpointName } from '@bilig/content-model/api';
import type { Permission } from '@bilig/permissions';
import type { Deps } from '../../deps.js';
import { fail, zodIssues } from '../../http/errors.js';
import { pageOf, sortedPage } from '../../repo/paging.js';
import type { ContentKind, ContentRec } from '../../repo/types.js';
import { toWrite } from '../../services/content-writes.js';
import { assertFields, authorFilter, authorizeSubject, checkBodyVersion, iso, reg, sortScalar, toRecord, topicsWhere, type AnyCtx } from './util.js';

interface ListQuery {
  q?: string;
  subjectKey?: string;
  status?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  unitKey?: string;
  authorId?: string;
  mine?: boolean;
  kind?: string;
  type?: string;
  objectiveKey?: string;
  cursor?: string;
  limit?: number;
}

interface KindDef {
  schema: z.ZodTypeAny;
  keyField: 'key' | 'id';
  write: Permission;
  /** Scope writes to the owning subject (false: coarse permission only). */
  scoped: boolean;
  list?: EndpointName;
  get?: EndpointName;
  create?: EndpointName;
  patch?: EndpointName;
  del?: EndpointName;
  /** PATCH body is `{ data, version }` (full replace) instead of a partial doc. */
  patchIsFull?: boolean;
}

export const KINDS: Record<ContentKind, KindDef> = {
  group: { schema: SubjectGroupSchema, keyField: 'key', write: 'platform.manage', scoped: false, list: 'adminGroupList', get: 'adminGroupGet', create: 'adminGroupCreate', patch: 'adminGroupPatch', del: 'adminGroupDelete' },
  subject: { schema: SubjectSchema, keyField: 'key', write: 'platform.manage', scoped: false, list: 'adminSubjectList', get: 'adminSubjectGet', create: 'adminSubjectCreate', patch: 'adminSubjectPatch', del: 'adminSubjectDelete' },
  course: { schema: CourseSchema, keyField: 'key', write: 'content.draft.edit', scoped: true, list: 'adminCourseList', get: 'adminCourseGet', create: 'adminCourseCreate', patch: 'adminCoursePatch', del: 'adminCourseDelete' },
  unit: { schema: UnitSchema, keyField: 'key', write: 'content.draft.edit', scoped: true, list: 'adminUnitList', get: 'adminUnitGet', create: 'adminUnitCreate', patch: 'adminUnitPatch', del: 'adminUnitDelete' },
  objective: { schema: ObjectiveSchema, keyField: 'key', write: 'content.draft.edit', scoped: true, list: 'adminObjectiveList', get: 'adminObjectiveGet', create: 'adminObjectiveCreate', patch: 'adminObjectivePatch', del: 'adminObjectiveDelete' },
  concept: { schema: ConceptSchema, keyField: 'key', write: 'content.draft.edit', scoped: true, list: 'adminConceptList', get: 'adminConceptGet', create: 'adminConceptCreate', patch: 'adminConceptPatch', del: 'adminConceptDelete' },
  process: { schema: ProcessSchema, keyField: 'key', write: 'content.draft.edit', scoped: true, list: 'adminProcessList', get: 'adminProcessGet', create: 'adminProcessCreate', patch: 'adminProcessPatch', del: 'adminProcessDelete' },
  item: { schema: ItemSchema, keyField: 'key', write: 'content.draft.edit', scoped: true, list: 'adminItemList', get: 'adminItemGet', create: 'adminItemCreate', patch: 'adminItemPatch', del: 'adminItemDelete', patchIsFull: true },
  glossary: { schema: GlossaryTermSchema, keyField: 'id', write: 'content.publish', scoped: false, list: 'adminGlossaryList', get: 'adminGlossaryGet', create: 'adminGlossaryCreate', patch: 'adminGlossaryPatch', del: 'adminGlossaryDelete' },
  // v0.5.0: textbooks are shared across subjects (content.publish, like the glossary).
  textbook: { schema: TextbookSchema, keyField: 'key', write: 'content.publish', scoped: false, list: 'adminTextbookList', get: 'adminTextbookGet', create: 'adminTextbookCreate', patch: 'adminTextbookPatch', del: 'adminTextbookDelete' },
};

/** What still references a dictionary entry (empty = deletable). */
export async function usageOf(deps: Deps, kind: ContentKind, key: string): Promise<string[]> {
  const { repo } = deps;
  const all = async <K extends ContentKind>(k: K) => (await repo.content(k).list({}, { limit: 100_000 })).items;
  switch (kind) {
    case 'group':
      return (await all('subject')).filter((s) => s.data.group === key).map((s) => `subject:${s.key}`);
    case 'subject':
      return [
        ...(await all('course')).filter((c) => c.data.subjectKey === key).map((c) => `course:${c.key}`),
        ...(await repo.listTopics({ subjectKey: key }, { limit: 1000 })).items.map((t) => `topic:${t.key}`),
      ];
    case 'course':
      return (await all('unit')).filter((u) => u.data.courseKey === key).map((u) => `unit:${u.key}`);
    case 'unit':
      return [
        ...(await all('objective')).filter((o) => o.data.unitKey === key).map((o) => `objective:${o.key}`),
        ...(await topicsWhere(deps, (d) => d.unitKey === key)).map((t) => `topic:${t}`),
        ...(await repo.listTopics({}, { limit: 100_000 })).items.filter((t) => t.unitKey === key).map((t) => `topic:${t.key}`),
      ].filter((v, i, a) => a.indexOf(v) === i);
    case 'objective':
      return [
        ...(await topicsWhere(deps, (d) => d.objectiveKeys.includes(key))).map((t) => `topic:${t}`),
        ...(await all('item')).filter((i) => i.data.objectiveKeys.includes(key)).map((i) => `item:${i.key}`),
      ];
    case 'concept':
      return [
        ...(await repo.topicsUsingConcept(key)).map((t) => `topic:${t}`),
        ...(await all('process')).filter((p) => p.data.steps.some((s) => s.conceptKey === key)).map((p) => `process:${p.key}`),
        ...(await all('concept')).filter((c) => c.key !== key && c.data.related.includes(key)).map((c) => `concept:${c.key}`),
      ];
    case 'process':
      return (await topicsWhere(deps, (d) => d.activities.processKeys.includes(key))).map((t) => `topic:${t}`);
    case 'item':
      return (await topicsWhere(deps, (d) => !!d.activities.quiz?.itemKeys.includes(key))).map((t) => `topic:${t}`);
    default:
      return [];
  }
}

export function registerContentAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, audit } = deps;

  for (const [kind, def] of Object.entries(KINDS) as [ContentKind, KindDef][]) {
    const store = repo.content(kind);
    const authWrite = async (ctx: AnyCtx, subjectKey: string | null) => {
      if (def.scoped) authorizeSubject(ctx, def.write, subjectKey);
      else if (def.write === 'platform.manage') ctx.authorize('platform.manage');
      // content.publish on shared glossary / textbooks: the route's coarse check suffices.
    };
    const parse = (data: unknown) => {
      const r = def.schema.safeParse(data);
      if (!r.success) fail('validation_failed', { issues: zodIssues(r.error) });
      return r.data;
    };
    const load = async (key: string) => {
      const rec = await store.get(key);
      if (!rec) fail('not_found', { detail: kind });
      return rec;
    };

    if (def.list)
      reg(app, deps, def.list, async (ctx) => {
        const q = ctx.query as ListQuery;
        const author = authorFilter(ctx, q);
        if (kind === 'subject' && q.status && q.status !== 'soon' && q.status !== 'live') fail('validation_failed', { detail: 'status' });
        const status = kind === 'subject' ? q.status : undefined;
        const filtered = !!(q.unitKey || author || q.kind || q.type || q.objectiveKey || status);
        if (!filtered && !q.sort && q.order !== 'desc') {
          const res = await store.list({ q: q.q, subjectKey: q.subjectKey }, pageOf(q));
          return { items: res.items.map(toRecord), nextCursor: res.nextCursor };
        }
        // v0.3.0 filters / sort: evaluated over the (filtered) list, keyset-paged on (value, key).
        const field = (r: ContentRec<unknown>, f: string) => (r.data as Record<string, unknown>)[f];
        const rows = (await store.list({ q: q.q, subjectKey: q.subjectKey }, { limit: 100_000 })).items.filter(
          (r) =>
            (!q.unitKey || field(r, 'unitKey') === q.unitKey) &&
            (!author || r.updatedBy === author) &&
            (!q.kind || field(r, 'kind') === q.kind) &&
            (!q.type || field(r, 'type') === q.type) &&
            (!q.objectiveKey || (field(r, 'objectiveKeys') as string[] | undefined)?.includes(q.objectiveKey)) &&
            (!status || field(r, 'status') === status),
        );
        const value = (r: ContentRec<unknown>) => {
          switch (q.sort ?? 'key') {
            case 'key':
              return r.key;
            case 'updatedAt':
              return iso(r.updatedAt);
            case 'createdAt':
              return iso(r.createdAt);
            default:
              return sortScalar(field(r, q.sort!), ctx.lang);
          }
        };
        const res = sortedPage(rows, { value, tie: (r) => r.key, order: q.order }, pageOf(q));
        return { items: res.items.map(toRecord), nextCursor: res.nextCursor };
      });

    if (def.get) reg(app, deps, def.get, async (ctx) => toRecord(await load(ctx.params[def.keyField === 'id' ? 'id' : 'key'])));

    if (def.create)
      reg(app, deps, def.create, async (ctx) => {
        const data = parse(ctx.body) as { key?: string; id?: string };
        const key = def.keyField === 'id' ? data.id! : data.key!;
        const w = await toWrite(repo, kind, key, data as never);
        await authWrite(ctx, w.subjectKey);
        const created = await store.create(key, w, ctx.auth.user!.id);
        if (created === 'conflict') fail('conflict', { detail: `${kind} exists` });
        await audit.log(ctx.auth.user!.id, 'content.created', { type: kind, id: key }, { ip: ctx.ip });
        deps.content.invalidate();
        return toRecord(created);
      });

    if (def.patch)
      reg(app, deps, def.patch, async (ctx) => {
        checkBodyVersion(ctx);
        const key = ctx.params[def.keyField === 'id' ? 'id' : 'key'];
        const cur = await load(key);
        const { version: _v, ...rest } = ctx.body as { version: number; data?: unknown };
        const merged: Record<string, unknown> = def.patchIsFull
          ? { ...(rest.data as object), key }
          : { ...(cur.data as object), ...rest, [def.keyField]: key };
        // v0.3.0: `null` removes an optional field (the patch schemas only allow null on optional fields).
        if (!def.patchIsFull) for (const [k, v] of Object.entries(rest)) if (v === null) delete merged[k];
        const next = parse(merged);
        const before = cur.subjectKey;
        await authWrite(ctx, before);
        const w = await toWrite(repo, kind, key, next as never);
        if (w.subjectKey !== before) await authWrite(ctx, w.subjectKey);
        if (def.scoped) assertFields(ctx, cur.data, next, before);
        const r = await store.update(key, w, ctx.ifMatch, ctx.auth.user!.id);
        if (r === 'not_found') fail('not_found');
        if (r === 'version_mismatch') fail('version_mismatch');
        await audit.log(ctx.auth.user!.id, 'content.updated', { type: kind, id: key }, { ip: ctx.ip, diff: { version: r.version } });
        deps.content.invalidate();
        return toRecord(r);
      });

    if (def.del)
      reg(app, deps, def.del, async (ctx) => {
        const key = ctx.params[def.keyField === 'id' ? 'id' : 'key'];
        const cur = await load(key);
        await authWrite(ctx, cur.subjectKey);
        if (cur.version !== ctx.ifMatch) fail('version_mismatch');
        const used = await usageOf(deps, kind, key);
        if (used.length) fail('in_use', { detail: used.slice(0, 20).join(', ') });
        const r = await store.delete(key, ctx.ifMatch);
        if (r === 'not_found') fail('not_found');
        if (r === 'version_mismatch') fail('version_mismatch');
        await audit.log(ctx.auth.user!.id, 'content.deleted', { type: kind, id: key }, { ip: ctx.ip });
        deps.content.invalidate();
        return { ok: true as const };
      });
  }

  reg(app, deps, 'adminConceptUsage', async (ctx) => {
    if (!(await repo.content('concept').get(ctx.params.key))) fail('not_found');
    const usedBy = await usageOf(deps, 'concept', ctx.params.key);
    return {
      conceptKey: ctx.params.key,
      topicKeys: usedBy.filter((u) => u.startsWith('topic:')).map((u) => u.slice('topic:'.length)),
      usedBy,
    };
  });

  reg(app, deps, 'adminItemStats', async (ctx) => {
    const key = ctx.params.key;
    if (!(await repo.content('item').get(key))) fail('not_found');
    const answers = await repo.listAnswers({ itemKey: key });
    const wrong = new Map<string, number>();
    for (const a of answers) {
      if (a.correct) continue;
      const v = a.response.value;
      const keys = Array.isArray(v) ? v.map(String) : typeof v === 'object' && v ? [] : [String(v)];
      for (const k of keys) wrong.set(k, (wrong.get(k) ?? 0) + 1);
    }
    const common = [...wrong.entries()].sort((x, y) => y[1] - x[1])[0];
    return {
      itemKey: key,
      answers: answers.length,
      correctRate: answers.length ? answers.filter((a) => a.correct).length / answers.length : null,
      ...(common ? { commonWrong: common[0] } : {}),
      avgTimeMs: answers.length ? answers.reduce((n, a) => n + a.timeMs, 0) / answers.length : null,
    };
  });

}
