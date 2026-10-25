/**
 * v0.10.0: the teacher cabinet v3 — a lesson page per КТП lesson (model stages, goals, materials, the AI
 * assistant), the «Сегодня» agenda, scheduling a КТП on the teacher's lesson days and a КТП made from
 * Bilig's subject standard when there is no textbook. Owner-only, like КТП.
 */
import { z } from 'zod';
import { KeySchema } from '../common.js';
import { LangSchema } from '../i18n.js';
import { LESSON_MODEL_IDS } from '../lesson-models.js';
import { WeekdaysSchema } from './calendar.js';
import { DateTimeSchema, IdSchema } from './common.js';
import {
  IsoDateSchema,
  KtpClassSchema,
  KtpLessonTypeSchema,
  KtpRowUidSchema,
} from './ktp.js';

export const LessonModelIdSchema = z.enum(LESSON_MODEL_IDS);

// ---------------------------------------------------------------------------
// Lesson content: GET / PUT /ktp/:id/lessons/:uid
// ---------------------------------------------------------------------------

export const LESSON_MATERIAL_KINDS = [
  'examples',
  'stem',
  'tests',
  'slides',
] as const;
export const LessonMaterialKindSchema = z.enum(LESSON_MATERIAL_KINDS);
export type LessonMaterialKind = z.infer<typeof LessonMaterialKindSchema>;

/** A material of the lesson: an example, a STEM task, a test question or a slide. */
export const LessonMaterialSchema = z.object({
  /** Client-made id, unique within the lesson. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  kind: LessonMaterialKindSchema,
  text: z.string().trim().min(1).max(2000),
  /** Ticked: goes into the plan .docx and the presentation. */
  on: z.boolean(),
  source: z.enum(['ai', 'teacher']),
});
export type LessonMaterial = z.infer<typeof LessonMaterialSchema>;

/** A stage of the model as the teacher filled it; empty fields go into the .docx with the model's hints. */
export const LessonStageContentSchema = z.object({
  teacher: z.string().max(4000),
  pupil: z.string().max(4000),
  /** Minutes; null = the model's suggestion. */
  minutes: z.number().int().min(0).max(90).nullable(),
  /** Materials attached to this stage (`LessonMaterial.id`). */
  attachments: z.array(z.string().max(40)).max(30),
});
export type LessonStageContent = z.infer<typeof LessonStageContentSchema>;

export const LessonGoalSchema = z.object({
  goal: z.string().max(2000),
  result: z.string().max(2000),
});
export const LessonGoalsSchema = z.object({
  /** Билим берүүчүлүк */
  knowledge: LessonGoalSchema,
  /** Өнүктүрүүчүлүк */
  development: LessonGoalSchema,
  /** Тарбиялык */
  upbringing: LessonGoalSchema,
});
export type LessonGoals = z.infer<typeof LessonGoalsSchema>;

/** The editable part of a lesson. */
export const LessonContentBodySchema = z.object({
  /** null = the teacher's default model (Me.defaultLessonModel). */
  modelId: LessonModelIdSchema.nullable(),
  /** Keyed `<modelId>:<stageKey>` (`stageContentKey`), so switching the model keeps each model's text. */
  stages: z.record(
    z.string().regex(/^[A-Za-z0-9]{1,8}:[a-z]{1,20}$/),
    LessonStageContentSchema,
  ),
  goals: LessonGoalsSchema,
  materials: z.array(LessonMaterialSchema).max(120),
});
export type LessonContentBody = z.infer<typeof LessonContentBodySchema>;

export const LessonContentSchema = LessonContentBodySchema.extend({
  planId: IdSchema,
  uid: KtpRowUidSchema,
  /** Classes (КТП column) where the lesson was taught, with when the teacher marked it. */
  conducted: z.record(KtpClassSchema, DateTimeSchema),
  /** 0 = nothing saved yet (the defaults above). */
  version: z.number().int().min(0),
  updatedAt: DateTimeSchema.nullable(),
});
export type LessonContent = z.infer<typeof LessonContentSchema>;

/** PUT body: the whole editable part; `version` = the version read (optional check, last write wins without it). */
export const LessonContentPutSchema = LessonContentBodySchema.extend({
  version: z.number().int().min(0).optional(),
});
export type LessonContentPut = z.infer<typeof LessonContentPutSchema>;

export const emptyLessonGoals = (): LessonGoals => ({
  knowledge: { goal: '', result: '' },
  development: { goal: '', result: '' },
  upbringing: { goal: '', result: '' },
});

// POST /ktp/:id/lessons/:uid/conducted — «Урок отмечен как проведённый» (or unmarked).
export const LessonConductedRequestSchema = z.object({
  class: KtpClassSchema,
  conducted: z.boolean(),
});

// ---------------------------------------------------------------------------
// The assistant of a lesson: POST /ktp/:id/lessons/:uid/assist
// ---------------------------------------------------------------------------

export const ASSIST_MAX_ITEMS = 5;

export const LessonAssistRequestSchema = z.discriminatedUnion('task', [
  /** New materials of a kind for the lesson's topic (never repeating `exclude`). */
  z.object({
    task: z.literal('materials'),
    kind: LessonMaterialKindSchema,
    count: z.number().int().min(1).max(ASSIST_MAX_ITEMS),
    exclude: z.array(z.string().max(2000)).max(120).optional(),
    lang: LangSchema.optional(),
  }),
  /** A question about teaching the lesson; `history` = the last turns of this chat. */
  z.object({
    task: z.literal('ask'),
    question: z.string().trim().min(1).max(1000),
    history: z
      .array(
        z.object({
          role: z.enum(['teacher', 'assistant']),
          text: z.string().max(4000),
        }),
      )
      .max(12)
      .optional(),
    lang: LangSchema.optional(),
  }),
  /** Fill the empty stage fields and goals of the lesson for its model. */
  z.object({
    task: z.literal('draft'),
    modelId: LessonModelIdSchema,
    lang: LangSchema.optional(),
  }),
]);
export type LessonAssistRequest = z.infer<typeof LessonAssistRequestSchema>;

export const LessonAssistResponseSchema = z.discriminatedUnion('task', [
  z.object({
    task: z.literal('materials'),
    kind: LessonMaterialKindSchema,
    items: z.array(z.string().max(2000)).max(ASSIST_MAX_ITEMS),
  }),
  z.object({ task: z.literal('ask'), answer: z.string().max(4000) }),
  z.object({
    task: z.literal('draft'),
    stages: z.record(
      z.string(),
      z.object({ teacher: z.string().max(4000), pupil: z.string().max(4000) }),
    ),
    goals: LessonGoalsSchema,
  }),
]);
export type LessonAssistResponse = z.infer<typeof LessonAssistResponseSchema>;

// ---------------------------------------------------------------------------
// Scheduling: POST /ktp/:id/schedule
// ---------------------------------------------------------------------------

export const KtpScheduleRequestSchema = z.object({
  version: z.number().int().min(1),
  /** The КТП class column to schedule. */
  class: KtpClassSchema,
  weekdays: WeekdaysSchema,
  /** `empty`: keep the dates there are, fill the missing ones; `all`: place every lesson anew. */
  mode: z.enum(['empty', 'all']),
  /** Place lessons from this date on (default: the start of the school year). */
  from: IsoDateSchema.optional(),
  /**
   * Add «СОР» lessons inside long quarters and a «СОЧ» at the end of every quarter, and split big topics
   * in two when the year has more hours than lessons (a КТП from a textbook or the standard). Default false.
   */
  assessments: z.boolean().optional(),
});
export type KtpScheduleRequest = z.infer<typeof KtpScheduleRequestSchema>;

// ---------------------------------------------------------------------------
// A КТП from the subject standard: POST /ktp/from-standard
// ---------------------------------------------------------------------------

export const KtpFromStandardRequestSchema = z.object({
  subjectKey: KeySchema,
  grade: z.number().int().min(1).max(12),
  lang: LangSchema.optional(),
  hoursPerWeek: z.number().int().min(1).max(10),
  weeks: z.number().int().min(10).max(40).optional(),
  year: z.number().int().min(2020).max(2100).optional(),
  classes: z.array(KtpClassSchema).max(8).optional(),
});
export type KtpFromStandardRequest = z.infer<
  typeof KtpFromStandardRequestSchema
>;

// ---------------------------------------------------------------------------
// «Сегодня»: GET /teacher/agenda?from=&to=
// ---------------------------------------------------------------------------

export const AGENDA_MAX_DAYS = 31;

export const AgendaQuerySchema = z
  .object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() })
  .refine((q) => !q.from || !q.to || q.to >= q.from, {
    message: 'to < from',
    path: ['to'],
  });

export const AgendaLessonSchema = z.object({
  planId: IdSchema,
  uid: KtpRowUidSchema,
  index: z.number().int().min(1),
  /** КТП class column and the linked class of the cabinet (null when unlinked). */
  class: KtpClassSchema,
  classId: IdSchema.nullable(),
  subjectKey: KeySchema.nullable(),
  subjectName: z.string(),
  title: z.string(),
  date: IsoDateSchema,
  type: KtpLessonTypeSchema,
  hours: z.number().int().min(0),
  topicKey: KeySchema.nullable(),
  /** «§13» etc. when the row came from a textbook. */
  section: z.string().nullable(),
  conducted: z.boolean(),
});
export type AgendaLesson = z.infer<typeof AgendaLessonSchema>;

export const AttentionItemSchema = z.discriminatedUnion('kind', [
  /** A КТП with errors to fix. */
  z.object({
    kind: z.literal('ktp_issues'),
    planId: IdSchema,
    classId: IdSchema.nullable(),
    class: KtpClassSchema.nullable(),
    subjectKey: KeySchema.nullable(),
    subjectName: z.string(),
    errors: z.number().int().min(1),
    warnings: z.number().int().min(0),
  }),
  /** A subject of a class without a КТП. */
  z.object({
    kind: z.literal('no_ktp'),
    classId: IdSchema,
    className: z.string(),
    subjectKey: KeySchema,
  }),
  /** An assignment due within 3 days that not everyone has done. */
  z.object({
    kind: z.literal('assignment_due'),
    assignmentId: IdSchema,
    classId: IdSchema,
    className: z.string(),
    title: z.string(),
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    dueAt: DateTimeSchema,
  }),
]);
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const AgendaResponseSchema = z.object({
  /** The server's today in the school's time zone (Asia/Bishkek). */
  today: IsoDateSchema,
  from: IsoDateSchema,
  to: IsoDateSchema,
  /** Lessons of the teacher's КТП between from and to, by date then КТП order. */
  lessons: z.array(AgendaLessonSchema),
  attention: z.array(AttentionItemSchema),
});
export type AgendaResponse = z.infer<typeof AgendaResponseSchema>;
