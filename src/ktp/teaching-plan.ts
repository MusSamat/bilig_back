/**
 * TeachingPlan documents: build one from a parsed КТП, apply a teacher's
 * PATCH (re-validate, never re-parse), and map to the contract DTOs. Pure.
 */
import type { Lang } from '@bilig/content-model';
import type { KtpPatchRequest, KtpRow, TeachingPlan, TeachingPlanSummary } from '@bilig/content-model/api';
import type { TeachingPlanRec } from '../repo/types.js';
import { lessonType } from './lesson-type.js';
import { applyMatches, type TopicIndex } from './match.js';
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

/** Totals and issues of a plan body (v0.9.2: also for a КТП made from a textbook). */
export const recheck = (doc: Omit<PlanDoc, 'issues' | 'totalHours'>): PlanDoc => ({
  ...doc,
  totalHours: totalHours(doc.rows),
  issues: validate(doc.rows, { classes: doc.classes, year: doc.year, declaredHours: doc.declaredHours }, doc.invalidDates),
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

export type PatchError = { error: string };

/**
 * Apply a PATCH: meta fields, then row patches by `index` in order. Issues are
 * recomputed. A teacher's `topicKey` (also `null`) is kept as `match.auto = false`
 * and never re-matched; auto links are re-matched for edited titles and for
 * every row when the subject changes.
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
  const { issues: _i, totalHours: _t, ...rest } = next;
  return recheck(rest);
}

export function toTeachingPlan(rec: TeachingPlanRec): TeachingPlan {
  const { invalidDates: _inv, ...d } = rec.doc as PlanDoc;
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
  const d = rec.doc as PlanDoc;
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
