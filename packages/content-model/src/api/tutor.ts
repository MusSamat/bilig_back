/**
 * Tutor (TZ W-32, §9 POST /tutor/ask). Default response is an SSE stream of
 * `TutorStreamEvent`s; with `Accept: application/json` the server returns a
 * single `TutorAskResponse`. 503 `tutor_unavailable` → client uses its offline
 * MiniSearch index.
 */
import { z } from 'zod';
import { KeySchema } from '../common.js';
import { StemFieldSchema } from '../concept.js';
import { LangSchema } from '../i18n.js';
import { IdSchema } from './common.js';

// ---------------------------------------------------------------------------
// v0.4.0 (additive): the context envelope. Where the teacher is in the topic,
// so a short follow-up («а сколько там атомов?») is understood without
// restating the subject. The server only uses keys that exist in the
// published package; the quote is user content, never instructions.
// ---------------------------------------------------------------------------

export const TUTOR_MODES = ['explore', 'lesson', 'process', 'compare', 'quiz'] as const;
export const TutorModeSchema = z.enum(TUTOR_MODES);
export type TutorMode = z.infer<typeof TutorModeSchema>;

/** Where a quoted selection came from on the page. */
export const QUOTE_SOURCES = ['topic', 'concept', 'example', 'process', 'lesson', 'answer'] as const;
export const QuoteSourceSchema = z.enum(QUOTE_SOURCES);
export type QuoteSource = z.infer<typeof QuoteSourceSchema>;

/** Longest selection the client sends; longer selections are cut at a word boundary. */
export const QUOTE_MAX = 500;

export const TutorContextSchema = z.object({
  mode: TutorModeSchema.optional(),
  /** Sample shown on the stage (topic.samples[].key). */
  sampleKey: KeySchema.optional(),
  processKey: KeySchema.optional(),
  /** 0-based step of `processKey` or of the lesson tour. */
  stepIndex: z.number().int().min(0).max(500).optional(),
  /** Text the teacher selected on the page. */
  quote: z
    .object({
      text: z.string().trim().min(1).max(QUOTE_MAX),
      source: QuoteSourceSchema.optional(),
      conceptKey: KeySchema.optional(),
    })
    .optional(),
});
export type TutorContext = z.infer<typeof TutorContextSchema>;

/**
 * What the teacher asked for: a free question (`ask`), or a quick action on a
 * selection — explain it, say it more simply, give an everyday example.
 * The question text is still sent (it is what the chat shows).
 */
export const TUTOR_INTENTS = ['ask', 'explain', 'simpler', 'example'] as const;
export const TutorIntentSchema = z.enum(TUTOR_INTENTS);
export type TutorIntent = z.infer<typeof TutorIntentSchema>;

export const TutorAskRequestSchema = z.object({
  topicKey: KeySchema,
  question: z.string().trim().min(1).max(2000),
  lang: LangSchema,
  /** Currently focused structure, for grounding. */
  conceptKey: KeySchema.optional(),
  threadId: IdSchema.optional(),
  /** Short client-side history (no names/ids — TZ §6). */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }))
    .max(20)
    .optional(),
  /** v0.4.0 */
  context: TutorContextSchema.optional(),
  /** v0.4.0; default `ask`. */
  intent: TutorIntentSchema.optional(),
});
export type TutorAskRequest = z.infer<typeof TutorAskRequestSchema>;

export const TutorStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  /** A concept the answer cites — the client highlights it in 3D. */
  z.object({ type: z.literal('citation'), conceptKey: KeySchema, label: z.string().optional() }),
  /**
   * v0.4.0: follow-up questions about the current topic, in the request language.
   * Sent after an off-topic or unanswerable question to steer back to the topic.
   * Older clients skip unknown frames.
   */
  z.object({ type: z.literal('suggestions'), items: z.array(z.string().min(1).max(200)).max(5) }),
  z.object({
    type: z.literal('done'),
    threadId: IdSchema.optional(),
    usage: z
      .object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) })
      .optional(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    i18nKey: z.string(),
    message: z.string().optional(),
  }),
]);
export type TutorStreamEvent = z.infer<typeof TutorStreamEventSchema>;

export const TutorAskResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(KeySchema),
  threadId: IdSchema.optional(),
  /** v0.4.0: see the `suggestions` stream event. */
  suggestions: z.array(z.string()).optional(),
});
export type TutorAskResponse = z.infer<typeof TutorAskResponseSchema>;

/** Encode one SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function encodeSseEvent(ev: TutorStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Parse SSE frames from a buffer. Returns parsed events plus the unconsumed
 * remainder (an incomplete trailing frame) to prepend to the next chunk.
 * Invalid frames are skipped.
 */
export function parseSseEvents(buffer: string): { events: TutorStreamEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: TutorStreamEvent[] = [];
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const parsed = TutorStreamEventSchema.safeParse(JSON.parse(data));
      if (parsed.success) events.push(parsed.data);
    } catch {
      /* skip malformed frame */
    }
  }
  return { events, rest };
}

/** Fold a list of stream events into the JSON-mode response shape. */
export function collectTutorStream(events: readonly TutorStreamEvent[]): TutorAskResponse {
  let answer = '';
  const citations: string[] = [];
  let threadId: string | undefined;
  let suggestions: string[] | undefined;
  for (const ev of events) {
    if (ev.type === 'token') answer += ev.text;
    else if (ev.type === 'suggestions') suggestions = ev.items;
    else if (ev.type === 'citation' && !citations.includes(ev.conceptKey)) citations.push(ev.conceptKey);
    else if (ev.type === 'done') threadId = ev.threadId;
  }
  return { answer, citations, ...(threadId ? { threadId } : {}), ...(suggestions ? { suggestions } : {}) };
}

// ---------------------------------------------------------------------------
// v0.4.0 (additive): «Ещё примеры» / «Ещё вопросы» — POST /tutor/generate.
//
// Generated content is always labelled as AI-made on screen. It is grounded in
// the published package, validated on the server (a quiz answer must be one of
// its options, cited concepts must exist) and cached per topic + concept +
// kind + language, so repeat requests are served from the pool. Items an
// editor approved are served first; items teachers reported are not served.
// Practice only: nothing about answering them is stored.
// ---------------------------------------------------------------------------

export const GENERATE_KINDS = ['simple', 'stem', 'quiz'] as const;
export const GenerateKindSchema = z.enum(GENERATE_KINDS);
export type GenerateKind = z.infer<typeof GenerateKindSchema>;

export const GENERATE_MAX = 5;

export const TutorGenerateRequestSchema = z.object({
  topicKey: KeySchema,
  lang: LangSchema,
  kind: GenerateKindSchema,
  /** Focus concept; absent = the whole topic. */
  conceptKey: KeySchema.optional(),
  count: z.number().int().min(1).max(GENERATE_MAX).default(3),
  /** Ids already on screen: not returned again. */
  exclude: z.array(IdSchema).max(200).default([]),
});
export type TutorGenerateRequest = z.input<typeof TutorGenerateRequestSchema>;

/** v0.9.1: the school grades a generated item suits («6–8 класс»). */
export const GradeRangeSchema = z
  .object({ from: z.number().int().min(1).max(12), to: z.number().int().min(1).max(12) })
  .refine((r) => r.from <= r.to, { message: 'from > to', path: ['to'] });
export type GradeRangeDto = z.infer<typeof GradeRangeSchema>;

export const GeneratedExampleSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(1000),
  /** STEM field (S/T/E/M), for `stem` examples. */
  field: StemFieldSchema.optional(),
  conceptKey: KeySchema.optional(),
  /** An editor reviewed it (served before unreviewed ones). */
  reviewed: z.boolean().optional(),
  /** v0.9.1: grades it suits; the pool shares it with every topic of these grades on the same concept. */
  grades: GradeRangeSchema.optional(),
});
export type GeneratedExample = z.infer<typeof GeneratedExampleSchema>;

export const GeneratedQuizItemSchema = z
  .object({
    id: IdSchema,
    prompt: z.string().trim().min(1).max(500),
    options: z
      .array(z.object({ key: KeySchema, text: z.string().trim().min(1).max(200) }))
      .min(2)
      .max(5),
    answer: KeySchema,
    explanation: z.string().trim().min(1).max(1000),
    conceptKey: KeySchema.optional(),
    reviewed: z.boolean().optional(),
    grades: GradeRangeSchema.optional(),
  })
  .refine((q) => q.options.some((o) => o.key === q.answer), { message: 'answer must be one of the options', path: ['answer'] })
  .refine((q) => new Set(q.options.map((o) => o.key)).size === q.options.length, { message: 'option keys must be unique', path: ['options'] });
export type GeneratedQuizItem = z.infer<typeof GeneratedQuizItemSchema>;

export const TutorGenerateResponseSchema = z.object({
  kind: GenerateKindSchema,
  lang: LangSchema,
  /** `simple` / `stem` results (empty for `quiz`). */
  examples: z.array(GeneratedExampleSchema),
  /** `quiz` results (empty otherwise). */
  quiz: z.array(GeneratedQuizItemSchema),
  /** Fewer than `count` when the pool and the model ran out of new material. */
  exhausted: z.boolean(),
});
export type TutorGenerateResponse = z.infer<typeof TutorGenerateResponseSchema>;

// v0.9.1 (additive): what this teacher already got — GET /tutor/generated. Generated items
// are remembered per user: a card shows them again after a reload, «Ещё» brings an item
// the user has not seen yet from the pool and asks the model for a new one only when
// every pooled item was seen. The client asks for one item per click (`count: 1`).
export const TutorGeneratedSeenQuerySchema = z.object({
  topicKey: KeySchema,
  lang: LangSchema,
  kind: GenerateKindSchema,
  conceptKey: KeySchema.optional(),
});
export type TutorGeneratedSeenQuery = z.input<typeof TutorGeneratedSeenQuerySchema>;

export const TutorGeneratedSeenResponseSchema = z.object({
  kind: GenerateKindSchema,
  lang: LangSchema,
  /** In the order the user first got them. */
  examples: z.array(GeneratedExampleSchema),
  quiz: z.array(GeneratedQuizItemSchema),
  /** The pool still has items this user has not seen (the next «Ещё» is free). */
  unseen: z.number().int().min(0),
});
export type TutorGeneratedSeenResponse = z.infer<typeof TutorGeneratedSeenResponseSchema>;

/** A teacher's verdict on one generated item: «хороший пример» or a report. */
export const GENERATED_REPORT_REASONS = ['wrong', 'unclear', 'inappropriate', 'off_topic'] as const;
export const GeneratedReportReasonSchema = z.enum(GENERATED_REPORT_REASONS);
export type GeneratedReportReason = z.infer<typeof GeneratedReportReasonSchema>;

export const GeneratedFeedbackRequestSchema = z.discriminatedUnion('vote', [
  z.object({ vote: z.literal('good') }),
  z.object({ vote: z.literal('bad'), reason: GeneratedReportReasonSchema }),
]);
export type GeneratedFeedbackRequest = z.infer<typeof GeneratedFeedbackRequestSchema>;
