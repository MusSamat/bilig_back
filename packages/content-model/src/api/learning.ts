/**
 * Learning DTOs (TZ §9 Learning, §8 Attempt/Answer/Progress/LearningEvent).
 *
 * Offline sync semantics: every attempt carries a client-generated `clientId`
 * (UUID) and every POST /sync carries an `Idempotency-Key` header (UUID).
 *  - Same Idempotency-Key + same body → the server replays the stored response.
 *  - Same Idempotency-Key + different body → 409 `idempotency_conflict`.
 *  - An attempt whose `clientId` already exists is reported as `duplicate`
 *    and never creates a second row; events are de-duplicated by `id`.
 * Hence re-sending a queued batch never creates duplicates.
 */
import { z } from 'zod';
import { KeySchema, SemverSchema } from '../common.js';
import { LocalizedSchema } from '../i18n.js';
import { ItemResponseSchema } from '../item.js';
import { DateTimeSchema, IdSchema } from './common.js';

/** Activity keys: `tour`, `quiz`, `comparison`, `process:<key>`. */
export const ActivityKeySchema = z
  .string()
  .regex(/^(tour|quiz|comparison|process:[a-z0-9]+(?:[._-][a-z0-9]+)*)$/);
export type ActivityKey = z.infer<typeof ActivityKeySchema>;

/** Progress per topic (W-11; server for signed-in users, IndexedDB for guests). */
export const ProgressSchema = z.object({
  topicKey: KeySchema,
  visitedConcepts: z.array(KeySchema),
  completedActivities: z.array(ActivityKeySchema),
  updatedAt: DateTimeSchema,
});
export type Progress = z.infer<typeof ProgressSchema>;

// GET /progress/:topicKey → Progress ; PUT /progress/:topicKey (merge = union)
export const ProgressPutRequestSchema = ProgressSchema.omit({ topicKey: true });
export type ProgressPutRequest = z.infer<typeof ProgressPutRequestSchema>;

// POST /attempts
export const AttemptCreateRequestSchema = z.object({
  clientId: IdSchema,
  topicKey: KeySchema,
  topicVersion: SemverSchema,
  assignmentId: IdSchema.optional(),
  /** Seed used for `sampleItems` so client and server draw the same items. */
  seed: z.string().min(1).max(64),
});
export type AttemptCreateRequest = z.infer<typeof AttemptCreateRequestSchema>;

export const AttemptSchema = z.object({
  id: IdSchema,
  clientId: IdSchema,
  topicKey: KeySchema,
  topicVersion: SemverSchema,
  assignmentId: IdSchema.optional(),
  itemKeys: z.array(KeySchema),
  startedAt: DateTimeSchema,
  finishedAt: DateTimeSchema.optional(),
  score: z.number().min(0).max(1).optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

// POST /attempts/:id/answers
export const AnswerSubmitRequestSchema = z.object({
  itemKey: KeySchema,
  response: ItemResponseSchema,
  timeMs: z.number().int().min(0),
});
export type AnswerSubmitRequest = z.infer<typeof AnswerSubmitRequestSchema>;

export const AnswerResultSchema = z.object({
  itemKey: KeySchema,
  correct: z.boolean(),
  score: z.number().min(0).max(1),
  explanation: LocalizedSchema.optional(),
});
export type AnswerResult = z.infer<typeof AnswerResultSchema>;

// POST /attempts/:id/finish
export const AttemptFinishRequestSchema = z.object({ finishedAt: DateTimeSchema.optional() });
export const AttemptResultSchema = z.object({
  attempt: AttemptSchema,
  correctCount: z.number().int().min(0),
  total: z.number().int().min(0),
  answers: z.array(AnswerResultSchema),
});
export type AttemptResult = z.infer<typeof AttemptResultSchema>;

/** xAPI-style learning event (actor is a server-side pseudonym — never sent by the client). */
export const XAPI_VERBS = [
  'experienced',
  'interacted',
  'selected',
  'played',
  'attempted',
  'answered',
  'completed',
  'asked',
] as const;
export const LearningEventSchema = z.object({
  /** Client UUID — the de-duplication key. */
  id: IdSchema,
  verb: z.enum(XAPI_VERBS),
  object: z.object({
    type: z.enum(['topic', 'concept', 'process', 'item', 'tour', 'comparison', 'tutor']),
    key: z.string().min(1),
  }),
  topicKey: KeySchema.optional(),
  result: z
    .object({
      score: z.number().min(0).max(1).optional(),
      success: z.boolean().optional(),
      durationMs: z.number().int().min(0).optional(),
    })
    .optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  ts: DateTimeSchema,
});
export type LearningEvent = z.infer<typeof LearningEventSchema>;

// POST /events
export const EventsBatchRequestSchema = z.object({
  events: z.array(LearningEventSchema).min(1).max(500),
});
export type EventsBatchRequest = z.infer<typeof EventsBatchRequestSchema>;
export const EventsBatchResponseSchema = z.object({
  accepted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
});
export type EventsBatchResponse = z.infer<typeof EventsBatchResponseSchema>;

// POST /sync  (header Idempotency-Key required)
export const OfflineAnswerSchema = AnswerSubmitRequestSchema.extend({ answeredAt: DateTimeSchema });
export const OfflineAttemptSchema = z.object({
  clientId: IdSchema,
  topicKey: KeySchema,
  topicVersion: SemverSchema,
  assignmentId: IdSchema.optional(),
  seed: z.string().min(1).max(64),
  itemKeys: z.array(KeySchema),
  startedAt: DateTimeSchema,
  finishedAt: DateTimeSchema.optional(),
  answers: z.array(OfflineAnswerSchema),
});
export type OfflineAttempt = z.infer<typeof OfflineAttemptSchema>;

export const SyncRequestSchema = z.object({
  attempts: z.array(OfflineAttemptSchema).max(200),
  progress: z.array(ProgressSchema).max(500),
  events: z.array(LearningEventSchema).max(2000),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const SyncResponseSchema = z.object({
  attempts: z.array(
    z.object({
      clientId: IdSchema,
      status: z.enum(['created', 'duplicate', 'rejected']),
      id: IdSchema.optional(),
      score: z.number().min(0).max(1).optional(),
      reason: z.string().optional(),
    }),
  ),
  /** Server-merged progress after the union. */
  progress: z.array(ProgressSchema),
  events: EventsBatchResponseSchema,
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

/** Header value for POST /sync. */
export const IdempotencyKeySchema = IdSchema;
