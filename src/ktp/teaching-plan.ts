/**
 * TeachingPlan documents: build one from a parsed КТП, apply a teacher's
 * PATCH (re-validate, never re-parse), and map to the contract DTOs. Pure.
 */
import type { Lang } from '@bilig/content-model';
import { normalizeClassName, type KtpPatchRequest, type KtpRow, type TeachingPlan, type TeachingPlanSummary } from '@bilig/content-model/api';
import type { TeachingPlanRec } from '../repo/types.js';
import { lessonType } from './lesson-type.js';
import { applyMatches, type TopicIndex } from './match.js';
import { legacyRowUid, newRowUid } from './row-uid.js';
import { subjectKeyOf, type InvalidDates, type ParsedKtp } from './parse.js';
import { totalHours, validate } from './validate.js';

/** Stored `TeachingPlanRec.doc`: the DTO body plus the raw text of impossible dates. */
export type PlanDoc = Omit<TeachingPlan, 'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'version'> & {
  invalidDates: InvalidDates;
};

export interface MatchSources {
  index: TopicIndex;
  /** Subject keys of the catalog (a КТП subject maps to a key only when it exists). */
  subjectKeys: ReadonlySet<string>;
}

const baseName = (f: string) => f.replace(/\.[^.]{1,5}$/, '').trim();

/** v0.10.0: every row with a uid (rows stored before 0.10.0 get the deterministic one; others untouched). */
export function withRowUids<D extends Pick<PlanDoc, 'rows'>>(doc: D, planId: string): D {
  if (doc.rows.every((r) => r.uid)) return doc;
  return { ...doc, rows: doc.rows.map((r, i) => (r.uid ? r : { ...r, uid: legacyRowUid(planId, i + 1) })) };
}

/** Totals and issues of a plan body (v0.9.2: also for a КТП made from a textbook). */
export const recheck = (doc: Omit<PlanDoc, 'issues' | 'totalHours'>): PlanDoc => ({
  ...doc,
  totalHours: totalHours(doc.rows),
  issues: validate(doc.rows, { classes: doc.classes, year: doc.year, declaredHours: doc.declaredHours, ...(doc.schedule ? { schedule: doc.schedule } : {}) }, doc.invalidDates),
});

export function createPlanDoc(parsed: ParsedKtp, opts: { sourceName: string; lang?: Lang } & MatchSources): PlanDoc {
  const { meta } = parsed;
  const subjectKey = meta.subjectKey && opts.subjectKeys.has(meta.subjectKey) ? meta.subjectKey : null;
  const rows: KtpRow[] = applyMatches(
    parsed.rows.map((r) => ({ ...r, topicKey: null })),
    opts.index,
    { subjectKey, grade: meta.grade },
  );
  return recheck({
    title: (meta.title || baseName(opts.sourceName)).slice(0, 500),
    subjectName: meta.subjectName,
    subjectKey,
    grade: meta.grade,
    lang: opts.lang ?? meta.lang,
    teacherName: meta.teacherName,
    schoolName: meta.schoolName,
    year: meta.year,
    classes: parsed.classes,
    declaredHours: meta.declaredHours,
    rows,
    sourceName: opts.sourceName.slice(0, 200),
    invalidDates: parsed.invalidDates,
  });
}

/** `conflict`: a row patch named a uid that is not the row at its index any more (409). */
export type PatchError = { error: string; conflict?: true };

/**
 * Apply a PATCH: meta fields, then row patches by `index` in order. Issues are
 * recomputed. A teacher's `topicKey` (also `null`) is kept as `match.auto = false`
 * and never re-matched; auto links are re-matched for edited titles and for
 * every row when the subject changes.
 *
 * v0.10.0: `rows[].uid` guards a row patch (another tab re-numbered the plan → conflict); then `remove`
 * (by uid) and `insert` (after a uid, null = at the start) apply, and the rows are re-indexed 1..n.
 */
export function patchPlanDoc(doc: PlanDoc, body: KtpPatchRequest, src: MatchSources): PlanDoc | PatchError {
  const next: PlanDoc = structuredClone(doc);
  if (body.title !== undefined) next.title = body.title;
  if (body.teacherName !== undefined) next.teacherName = body.teacherName;
  if (body.schoolName !== undefined) next.schoolName = body.schoolName;
  if (body.lang !== undefined) next.lang = body.lang;
  if (body.subjectName !== undefined) {
    next.subjectName = body.subjectName;
    if (body.subjectKey === undefined) {
      const k = subjectKeyOf(body.subjectName);
      next.subjectKey = k && src.subjectKeys.has(k) ? k : null;
    }
  }
  if (body.subjectKey !== undefined) {
    if (body.subjectKey !== null && !src.subjectKeys.has(body.subjectKey)) return { error: 'subjectKey' };
    next.subjectKey = body.subjectKey;
  }

  const rematch = new Set<number>();
  if (next.subjectKey !== doc.subjectKey) for (const r of next.rows) rematch.add(r.index);
  const byIndex = new Map(next.rows.map((r, i) => [r.index, i]));
  for (const [n, p] of (body.rows ?? []).entries()) {
    const at = byIndex.get(p.index);
    if (at === undefined) return { error: `rows[${n}].index` };
    const row = next.rows[at];
    if (p.uid !== undefined && p.uid !== row.uid) return { error: `rows[${n}].uid`, conflict: true };
    if (p.title !== undefined && p.title !== row.title) {
      row.title = p.title;
      if (p.type === undefined) row.type = lessonType(p.title);
      rematch.add(row.index);
    }
    if (p.type !== undefined) row.type = p.type;
    if (p.hours !== undefined) row.hours = p.hours;
    if (p.homework !== undefined) row.homework = p.homework;
    if (p.dates !== undefined) {
      for (const [cls, d] of Object.entries(p.dates)) {
        if (!next.classes.includes(cls)) return { error: `rows[${n}].dates.${cls}` };
        row.dates[cls] = d;
        const inv = next.invalidDates[String(row.index)];
        if (inv) {
          delete inv[cls];
          if (!Object.keys(inv).length) delete next.invalidDates[String(row.index)];
        }
      }
    }
    if (p.topicKey !== undefined) {
      if (p.topicKey !== null && !src.index.keys.has(p.topicKey)) return { error: `rows[${n}].topicKey` };
      row.topicKey = p.topicKey;
      row.match = { auto: false, score: p.topicKey === null ? 0 : 1 };
      rematch.delete(row.index);
    }
  }
  if (rematch.size) next.rows = applyMatches(next.rows, src.index, { subjectKey: next.subjectKey, grade: next.grade }, rematch);

  if (body.remove?.length || body.insert?.length) {
    const removed = new Set(body.remove ?? []);
    for (const [n, uid] of [...removed].entries()) if (!next.rows.some((r) => r.uid === uid)) return { error: `remove[${n}]` };
    // Impossible dates are kept by row index: carry them over to the new indexes.
    const invalidByUid = new Map(next.rows.map((r) => [r.uid, next.invalidDates[String(r.index)]] as const).filter((e) => e[1]));
    let rows = next.rows.filter((r) => !removed.has(r.uid));
    const added = new Set<string>();
    for (const [n, ins] of (body.insert ?? []).entries()) {
      const at = ins.afterUid === null ? 0 : rows.findIndex((r) => r.uid === ins.afterUid) + 1;
      if (at === 0 && ins.afterUid !== null) return { error: `insert[${n}].afterUid` };
      for (const cls of Object.keys(ins.dates ?? {})) if (!next.classes.includes(cls)) return { error: `insert[${n}].dates.${cls}` };
      if (ins.topicKey && !src.index.keys.has(ins.topicKey)) return { error: `insert[${n}].topicKey` };
      const prev = rows[at - 1] ?? null;
      const section = ins.section ?? prev?.section ?? rows[at]?.section;
      const row: KtpRow = {
        uid: newRowUid(),
        index: 0,
        number: 0,
        ...(section ? { section: { ...section } } : {}),
        title: ins.title,
        hours: ins.hours ?? 1,
        type: ins.type ?? lessonType(ins.title),
        dates: Object.fromEntries(next.classes.map((c) => [c, ins.dates?.[c] ?? null])),
        homework: ins.homework ?? '',
        note: '',
        topicKey: ins.topicKey ?? null,
        ...(ins.topicKey !== undefined ? { match: { auto: false, score: ins.topicKey === null ? 0 : 1 } } : {}),
      };
      const matched = ins.topicKey === undefined ? applyMatches([row], src.index, { subjectKey: next.subjectKey, grade: next.grade })[0] : row;
      rows.splice(at, 0, matched);
      added.add(row.uid);
    }
    // Re-index; a new row's printed number follows the row before it in its table.
    rows = rows.map((r, i) => ({ ...r, index: i + 1 }));
    for (let i = 0; i < rows.length; i++) if (added.has(rows[i].uid)) rows[i].number = i > 0 ? rows[i - 1].number + 1 : 1;
    next.invalidDates = Object.fromEntries(rows.filter((r) => invalidByUid.has(r.uid)).map((r) => [String(r.index), invalidByUid.get(r.uid)!]));
    next.rows = rows;
  }
  const { issues: _i, totalHours: _t, ...rest } = next;
  return recheck(rest);
}

/** A КТП class label as Bilig shows it: capitals, no spaces («8б» → «8Б», «8 «В»» was read as «8В»). */
export const ktpClass = (label: string) => normalizeClassName(label).replace(/\s+/g, '');

/**
 * v0.9.3: the class labels of a stored plan in capitals — the class columns, the date keys, the class
 * links and the impossible dates (plans saved before kept them as typed). Issues are rechecked.
 */
export function normalizePlanClasses(stored: PlanDoc): PlanDoc {
  // Plans made from a book before the fix kept a row section with an empty title (a chapter without a name),
  // which the contract refuses: such a section is dropped.
  const doc = stored.rows.some((r) => r.section && !r.section.title.trim()) ? { ...stored, rows: stored.rows.map(({ section, ...r }) => (section && !section.title.trim() ? r : { ...r, section })) } : stored;
  if (doc.classes.every((c) => ktpClass(c) === c)) return doc;
  const keys = <T,>(o: Record<string, T> | undefined) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [ktpClass(k), v])) : o);
  return recheck({
    ...doc,
    classes: [...new Set(doc.classes.map(ktpClass))],
    rows: doc.rows.map((r) => ({ ...r, dates: keys(r.dates)! })),
    ...(doc.classLinks ? { classLinks: keys(doc.classLinks) } : {}),
    ...(doc.schedule ? { schedule: keys(doc.schedule) } : {}),
    invalidDates: Object.fromEntries(Object.entries(doc.invalidDates ?? {}).map(([i, m]) => [i, keys(m)!])),
  });
}

/** The stored body of a plan as every route uses it: class labels in capitals, every row with a uid. */
export const planDocOf = (rec: Pick<TeachingPlanRec, 'id' | 'doc'>): PlanDoc => withRowUids(normalizePlanClasses(rec.doc as PlanDoc), rec.id);

export function toTeachingPlan(rec: TeachingPlanRec): TeachingPlan {
  const { invalidDates: _inv, ...d } = planDocOf(rec);
  return {
    ...d,
    id: rec.id,
    ownerId: rec.ownerId,
    title: rec.title,
    createdAt: rec.createdAt.toISOString(),
    updatedAt: rec.updatedAt.toISOString(),
    version: rec.version,
  };
}

export function toSummary(rec: TeachingPlanRec): TeachingPlanSummary {
  const d = planDocOf(rec);
  return {
    id: rec.id,
    title: rec.title,
    subjectName: d.subjectName,
    subjectKey: d.subjectKey,
    grade: d.grade,
    lang: d.lang,
    classes: d.classes,
    totalHours: d.totalHours,
    updatedAt: rec.updatedAt.toISOString(),
    version: rec.version,
    lessons: d.rows.length,
    errors: d.issues.filter((i) => i.severity === 'error').length,
    warnings: d.issues.filter((i) => i.severity === 'warning').length,
  };
}
