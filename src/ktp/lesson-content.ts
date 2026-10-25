/**
 * v0.10.0: the content of a КТП lesson (pure): the defaults of a lesson nothing was saved for, the DTO of
 * a stored one, and the checks of a PUT (stage keys of a known model, attachments of the lesson's own
 * materials).
 */
import { LESSON_MODELS } from '@bilig/content-model';
import { LessonContentBodySchema, emptyLessonGoals, type LessonContent, type LessonContentBody } from '@bilig/content-model/api';
import type { LessonContentRec } from '../repo/types.js';

export const emptyLessonBody = (): LessonContentBody => ({ modelId: null, stages: {}, goals: emptyLessonGoals(), materials: [] });

/** Every `<modelId>:<stageKey>` of the lesson models. */
export const STAGE_KEYS: ReadonlySet<string> = new Set(LESSON_MODELS.flatMap((m) => m.stages.map((s) => `${m.id}:${s.key}`)));

/** The stored body (a stored doc the contract no longer accepts reads as the defaults). */
export function lessonBodyOf(rec: Pick<LessonContentRec, 'doc'> | null): LessonContentBody {
  if (!rec) return emptyLessonBody();
  const r = LessonContentBodySchema.safeParse(rec.doc);
  return r.success ? r.data : emptyLessonBody();
}

export function toLessonContent(planId: string, uid: string, rec: LessonContentRec | null): LessonContent {
  return {
    ...lessonBodyOf(rec),
    planId,
    uid,
    conducted: rec ? { ...rec.conducted } : {},
    version: rec?.version ?? 0,
    updatedAt: rec ? rec.updatedAt.toISOString() : null,
  };
}

export interface BodyIssue {
  path: (string | number)[];
  message: string;
}

/** Problems of a PUT body: unknown stage keys, attachments of no material, duplicate material ids. */
export function lessonBodyIssues(body: LessonContentBody): BodyIssue[] {
  const issues: BodyIssue[] = [];
  const ids = new Set<string>();
  body.materials.forEach((m, i) => {
    if (ids.has(m.id)) issues.push({ path: ['materials', i, 'id'], message: `Duplicate material id ${m.id}` });
    ids.add(m.id);
  });
  for (const [key, st] of Object.entries(body.stages)) {
    if (!STAGE_KEYS.has(key)) issues.push({ path: ['stages', key], message: 'Not a stage of a lesson model' });
    st.attachments.forEach((a, i) => {
      if (!ids.has(a)) issues.push({ path: ['stages', key, 'attachments', i], message: `No material ${a}` });
    });
  }
  return issues;
}
