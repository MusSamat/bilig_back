/**
 * v0.5.0: «КТП → сабак планы». A teacher uploads their календарно-тематический
 * план (КТП, .docx); the server parses and checks it, links each lesson to a
 * Bilig topic, and generates the official 45-minute lesson plan (.docx) for a
 * lesson or a range of lessons on demand. Owner-only, like presentations.
 */
import { z } from 'zod';
import { KeySchema } from '../common.js';
import { LangSchema } from '../i18n.js';

/** Calendar date `YYYY-MM-DD`. */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Lesson type; sets the stage timings of the plan (always 45 minutes). */
export const KTP_LESSON_TYPES = ['new', 'practice', 'test', 'analysis'] as const;
export const KtpLessonTypeSchema = z.enum(KTP_LESSON_TYPES);
export type KtpLessonType = z.infer<typeof KtpLessonTypeSchema>;

/** Class label as printed in the КТП header, spaces removed (`8б`, `10А`). */
export const KtpClassSchema = z.string().min(1).max(12);

export const KTP_ISSUE_CODES = [
  'no_lessons', // no КТП table found
  'title_missing', // a lesson row without a title
  'date_missing', // no date for a class
  'date_invalid', // impossible date (31.04)
  'date_order', // earlier than the previous lesson of the class
  'date_same_day', // two lessons of a class on one day (double lesson) — info
  'date_sunday', // a lesson on Sunday
  'date_holiday', // a KG public holiday
  'date_out_of_year', // outside 1 Sep – 30 Jun of the plan's school year
  'hours_mismatch', // declared total ≠ sum of lesson hours
  'section_hours_mismatch', // «Сан (10 саат)» but the section has another number of lessons
] as const;
export const KtpIssueCodeSchema = z.enum(KTP_ISSUE_CODES);
export type KtpIssueCode = z.infer<typeof KtpIssueCodeSchema>;

export const KtpIssueSchema = z.object({
  code: KtpIssueCodeSchema,
  severity: z.enum(['error', 'warning', 'info']),
  /** Lesson index (`KtpRow.index`) when the issue is about one lesson. */
  row: z.number().int().min(1).optional(),
  class: KtpClassSchema.optional(),
  /** Values for the localized message (`{ date: '31.04.27', declared: 136, actual: 138 }`). */
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type KtpIssue = z.infer<typeof KtpIssueSchema>;

export const KtpSectionSchema = z.object({
  title: z.string().min(1).max(300),
  /** Hours the section header declares («(10 саат)»). */
  hours: z.number().int().min(0).optional(),
});
export type KtpSection = z.infer<typeof KtpSectionSchema>;

export const KtpRowSchema = z.object({
  /** 1-based position in the whole plan (lesson numbers restart per table; this does not). */
  index: z.number().int().min(1),
  /** Number as printed in the КТП. */
  number: z.number().int().min(0),
  section: KtpSectionSchema.optional(),
  title: z.string().max(500),
  hours: z.number().int().min(0).max(10),
  type: KtpLessonTypeSchema,
  /** Date per class; null = missing or impossible (see issues). */
  dates: z.record(KtpClassSchema, IsoDateSchema.nullable()),
  homework: z.string().max(1000),
  note: z.string().max(1000),
  /** Linked Bilig topic (teacher's choice or the automatic match); null = none. */
  topicKey: KeySchema.nullable(),
  /** How the link was made: automatic match with its score, or set by the teacher. */
  match: z.object({ auto: z.boolean(), score: z.number().min(0).max(1) }).optional(),
});
export type KtpRow = z.infer<typeof KtpRowSchema>;

export const TeachingPlanSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  title: z.string().max(500),
  /** Subject as written in the КТП («алгебра»). */
  subjectName: z.string().max(200),
  /** Matched Bilig subject, when there is one. */
  subjectKey: KeySchema.nullable(),
  grade: z.number().int().min(1).max(11).nullable(),
  /** Language of the КТП and of the generated plans. */
  lang: LangSchema,
  teacherName: z.string().max(200),
  schoolName: z.string().max(300),
  /** School year start (`2026` = 2026–2027), when found. */
  year: z.number().int().min(2000).max(2100).nullable(),
  classes: z.array(KtpClassSchema),
  declaredHours: z.number().int().min(0).nullable(),
  totalHours: z.number().int().min(0),
  rows: z.array(KtpRowSchema),
  issues: z.array(KtpIssueSchema),
  sourceName: z.string().max(200),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().min(1),
});
export type TeachingPlan = z.infer<typeof TeachingPlanSchema>;

export const TeachingPlanSummarySchema = TeachingPlanSchema.pick({
  id: true,
  title: true,
  subjectName: true,
  subjectKey: true,
  grade: true,
  lang: true,
  classes: true,
  totalHours: true,
  updatedAt: true,
  version: true,
}).extend({
  lessons: z.number().int().min(0),
  errors: z.number().int().min(0),
  warnings: z.number().int().min(0),
});
export type TeachingPlanSummary = z.infer<typeof TeachingPlanSummarySchema>;

export const TeachingPlanListSchema = z.object({
  items: z.array(TeachingPlanSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TeachingPlanList = z.infer<typeof TeachingPlanListSchema>;

/** Max size of an uploaded КТП file (bytes). */
export const KTP_MAX_BYTES = 4 * 1024 * 1024;

// POST /ktp — upload a КТП .docx as base64.
export const KtpUploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** The .docx bytes, base64 (≤ KTP_MAX_BYTES decoded). */
  data: z.string().min(1).max(Math.ceil((KTP_MAX_BYTES * 4) / 3) + 8),
  /** Language of the КТП; detected from the text when absent. */
  lang: LangSchema.optional(),
});
export type KtpUploadRequest = z.infer<typeof KtpUploadRequestSchema>;

// PATCH /ktp/:id — fix what the parser got wrong, link topics. Issues are recomputed.
export const KtpRowPatchSchema = z.object({
  index: z.number().int().min(1),
  title: z.string().max(500).optional(),
  type: KtpLessonTypeSchema.optional(),
  hours: z.number().int().min(0).max(10).optional(),
  homework: z.string().max(1000).optional(),
  dates: z.record(KtpClassSchema, IsoDateSchema.nullable()).optional(),
  topicKey: KeySchema.nullable().optional(),
});
export type KtpRowPatch = z.infer<typeof KtpRowPatchSchema>;

export const KtpPatchRequestSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().max(500).optional(),
  subjectName: z.string().max(200).optional(),
  subjectKey: KeySchema.nullable().optional(),
  teacherName: z.string().max(200).optional(),
  schoolName: z.string().max(300).optional(),
  lang: LangSchema.optional(),
  rows: z.array(KtpRowPatchSchema).max(400).optional(),
});
export type KtpPatchRequest = z.infer<typeof KtpPatchRequestSchema>;

// GET /ktp/:id/lessons/:index/plan?class=8б — one lesson plan (.docx)
export const KtpLessonPlanQuerySchema = z.object({
  class: KtpClassSchema,
  lang: LangSchema.optional(),
});
export type KtpLessonPlanQuery = z.infer<typeof KtpLessonPlanQuerySchema>;

/** Max lessons in one range download. */
export const KTP_MAX_RANGE = 10;

// GET /ktp/:id/plans?class=8б&from=1&to=5 — lessons `from..to` (by index) in one .docx, a plan per page
export const KtpLessonPlansQuerySchema = z
  .object({
    class: KtpClassSchema,
    from: z.coerce.number().int().min(1),
    to: z.coerce.number().int().min(1),
    lang: LangSchema.optional(),
  })
  .refine((q) => q.to >= q.from && q.to - q.from < KTP_MAX_RANGE, { message: `to must be ≥ from and the range ≤ ${KTP_MAX_RANGE} lessons`, path: ['to'] });
export type KtpLessonPlansQuery = z.infer<typeof KtpLessonPlansQuerySchema>;

export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
