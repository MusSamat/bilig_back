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
  grade: z.number().int().min(1).max(12).nullable(),
  /** Language of the КТП and of the generated plans. */
  lang: LangSchema,
  teacherName: z.string().max(200),
  schoolName: z.string().max(300),
  /** School year start (`2026` = 2026–2027), when found. */
  year: z.number().int().min(2000).max(2100).nullable(),
  classes: z.array(KtpClassSchema),
  /** v0.8.0: which of the teacher's classes each КТП class column is (matched by name, editable). */
  classLinks: z.record(KtpClassSchema, z.string().uuid().nullable()).optional(),
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
  /** v0.8.0 */
  classLinks: z.record(KtpClassSchema, z.string().uuid().nullable()).optional(),
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

// ---------------------------------------------------------------------------
// v0.9.2: a preliminary КТП from a textbook's contents («Мазмуну»)
// ---------------------------------------------------------------------------

/** Page range as printed in the book. */
export const DraftPagesSchema = z.object({ from: z.number().int().min(1).max(2000), to: z.number().int().min(1).max(2000) }).refine((p) => p.to >= p.from, { message: 'to < from', path: ['to'] });

/** One line of the contents: a § / lesson, a chapter test («тесттик тапшырмалар», «текшерүү»), or an extra (lab work, appendix). */
export const DraftLessonSchema = z.object({
  /** As printed: «4», «4.1»; empty for a test or an unnumbered line. */
  number: z.string().max(20),
  kind: z.enum(['lesson', 'review', 'extra']),
  title: z.string().trim().min(1).max(500),
  pages: DraftPagesSchema.optional(),
  /** Bilig topic of the lesson (from the catalog textbook, or matched by title on the server). */
  topicKey: KeySchema.nullable().optional(),
});
export type DraftLesson = z.infer<typeof DraftLessonSchema>;

export const DraftChapterSchema = z.object({
  /** As printed: «1», «I», «Лаб.»; a chapter of lab works only is spread over the chapters of their topics. */
  number: z.string().max(20),
  title: z.string().trim().min(1).max(300),
  lessons: z.array(DraftLessonSchema).min(1).max(200),
});
export type DraftChapter = z.infer<typeof DraftChapterSchema>;

/** A book's contents in one language, as the teacher checked it (editable before the КТП is made). */
export const TextbookDraftSchema = z.object({
  title: z.string().trim().min(1).max(300),
  grade: z.number().int().min(1).max(12).nullable(),
  lang: LangSchema,
  subjectKey: KeySchema.nullable(),
  chapters: z.array(DraftChapterSchema).min(1).max(60),
});
export type TextbookDraft = z.infer<typeof TextbookDraftSchema>;

/** Max pages sent as images for the contents search (the first and the last pages of a book). */
export const CONTENTS_MAX_IMAGES = 24;
/** Max bytes of one page image (JPEG / PNG / WebP). */
export const CONTENTS_MAX_IMAGE_BYTES = 1_500_000;

// POST /ktp/contents — read the contents of a book: page images (a scan or photos; the AI assistant reads
// them), the text of the pages (a PDF with a text layer) or a .docx. Text and .docx are parsed without
// the model when the lines look like contents; images always need the online assistant.
export const KtpContentsRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    /** Page images as data URLs or bare base64 (JPEG / PNG / WebP), in page order. */
    images: z.array(z.string().min(1).max(Math.ceil((CONTENTS_MAX_IMAGE_BYTES * 4) / 3) + 64)).max(CONTENTS_MAX_IMAGES).optional(),
    /** Printed page numbers of the images when known (PDF page → book page differs). */
    imagePages: z.array(z.number().int().min(1).max(5000)).max(CONTENTS_MAX_IMAGES).optional(),
    /** Plain text of the pages (one page per item), e.g. from a PDF text layer. */
    pages: z.array(z.string().max(20_000)).max(60).optional(),
    /** A .docx, base64. */
    docx: z.string().min(1).max(Math.ceil((KTP_MAX_BYTES * 4) / 3) + 8).optional(),
    /** The book's language when known; detected otherwise. */
    lang: LangSchema.optional(),
    /** Subject and grade when the teacher knows them (they help the topic matching). */
    subjectKey: KeySchema.optional(),
    grade: z.number().int().min(1).max(12).optional(),
  })
  .refine((b) => [b.images?.length, b.pages?.length, b.docx ? 1 : 0].filter((n) => n).length === 1, { message: 'Send exactly one of images, pages or docx', path: ['images'] });
export type KtpContentsRequest = z.input<typeof KtpContentsRequestSchema>;

export const KtpContentsResponseSchema = z.object({
  draft: TextbookDraftSchema,
  /** How the contents were read: the text parser or the AI assistant (images / text it could not parse). */
  source: z.enum(['text', 'assistant']),
  /** 0-based indexes of the images (or text pages) that held the contents. */
  contentsPages: z.array(z.number().int().min(0)),
  /** Lines to check: «§ 12 has no page», «pages go back at § 30». */
  warnings: z.array(z.object({ code: z.enum(['no_pages', 'pages_order', 'no_lessons', 'unmatched']), chapter: z.number().int().min(0).optional(), lesson: z.number().int().min(0).optional() })),
});
export type KtpContentsResponse = z.infer<typeof KtpContentsResponseSchema>;

/** Weeks of lessons in a school year (Kyrgyzstan: 34). */
export const SCHOOL_WEEKS = 34;

// POST /ktp/from-textbook — make a preliminary КТП (a TeachingPlan, editable like an uploaded one) from a
// catalog textbook or a checked contents draft. No dates: every teacher's timetable differs — the plan has
// the lessons in book order, their § and pages, hours, types and Bilig topics; the number of lessons is
// hours a week × weeks. Download it with GET /ktp/:id/docx.
export const KtpFromTextbookRequestSchema = z
  .object({
    /** A textbook of the catalog… */
    textbookKey: KeySchema.optional(),
    /** …or the contents the teacher checked (POST /ktp/contents). */
    draft: TextbookDraftSchema.optional(),
    /** Chapters of this subject only (an integrated book spans several). */
    subjectKey: KeySchema.optional(),
    lang: LangSchema.optional(),
    /** Lessons a week of the subject (the curriculum's hours). */
    hoursPerWeek: z.number().int().min(1).max(10),
    /** Weeks of lessons (default SCHOOL_WEEKS). */
    weeks: z.number().int().min(10).max(40).optional(),
    /** School year start (2026 = 2026–2027), for the title; default: the current school year. */
    year: z.number().int().min(2020).max(2100).optional(),
    /** Class labels for the КТП header («7а», «7б»); dates stay empty for the teacher to fill in. */
    classes: z.array(KtpClassSchema).max(8).optional(),
  })
  .refine((b) => !!b.textbookKey !== !!b.draft, { message: 'Send textbookKey or draft', path: ['textbookKey'] });
export type KtpFromTextbookRequest = z.input<typeof KtpFromTextbookRequestSchema>;
