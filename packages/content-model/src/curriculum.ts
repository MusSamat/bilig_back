/**
 * Subjects and program structure (TZ §8 «Контент»: Subject → Course → Unit →
 * Objective). Subjects, groups and their colors are data, not layout (W-02, W-03).
 */
import { z } from 'zod';
import { HueSchema, KeySchema } from './common.js';
import { LocalizedSchema } from './i18n.js';

/** Catalog group (W-02: естественные, точные, Земля и космос). */
export const SubjectGroupSchema = z.object({
  key: KeySchema,
  title: LocalizedSchema,
  order: z.number().int(),
});
export type SubjectGroup = z.infer<typeof SubjectGroupSchema>;

export const SUBJECT_STATUSES = ['soon', 'live'] as const;
export const SubjectStatusSchema = z.enum(SUBJECT_STATUSES);
export type SubjectStatus = z.infer<typeof SubjectStatusSchema>;

export const SubjectSchema = z.object({
  key: KeySchema,
  title: LocalizedSchema,
  /** Icon id from the UI sprite set (never a brand/subject-specific component). */
  icon: z.string().min(1),
  /** Single hue 0–359; all interface tokens derive from it (W-03). */
  hue: HueSchema,
  /** SubjectGroup key. */
  group: KeySchema,
  order: z.number().int(),
  /** «Скоро» (locked card) / «Доступен». */
  status: SubjectStatusSchema,
});
export type Subject = z.infer<typeof SubjectSchema>;

export const CourseSchema = z.object({
  key: KeySchema,
  subjectKey: KeySchema,
  /** School grade 1–12 (v0.8.0: Kyrgyzstan moves to 12-year schooling). URL segment is `g${grade}`. */
  grade: z.number().int().min(1).max(12),
  /** Curriculum id, e.g. `kg-2024`. */
  curriculum: z.string().min(1),
  title: LocalizedSchema,
});
export type Course = z.infer<typeof CourseSchema>;

export const UnitSchema = z.object({
  key: KeySchema,
  courseKey: KeySchema,
  order: z.number().int(),
  title: LocalizedSchema,
});
export type Unit = z.infer<typeof UnitSchema>;

/** Learning objective with a KR program code (W-10, A-03). */
export const ObjectiveSchema = z.object({
  key: KeySchema,
  /** e.g. `BIO-7.2.1` */
  code: z.string().min(1),
  unitKey: KeySchema,
  text: LocalizedSchema,
});
export type Objective = z.infer<typeof ObjectiveSchema>;

/** URL path segment for a grade (W-05: `/ky/bio/g7/animal-cell`). */
export const gradeSegment = (grade: number): string => `g${grade}`;
export function parseGradeSegment(seg: string): number | null {
  const m = /^g(\d{1,2})$/.exec(seg);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}
