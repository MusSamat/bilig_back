/**
 * Tutor (TZ W-32, §9 POST /tutor/ask). Default response is an SSE stream of
 * `TutorStreamEvent`s; with `Accept: application/json` the server returns a
 * single `TutorAskResponse`. 503 `tutor_unavailable` → client uses its offline
 * MiniSearch index.
 */
import { z } from 'zod';
import { KeySchema } from '../common.js';
import { LangSchema } from '../i18n.js';
import { IdSchema } from './common.js';

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
});
export type TutorAskRequest = z.infer<typeof TutorAskRequestSchema>;

export const TutorStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  /** A concept the answer cites — the client highlights it in 3D. */
  z.object({ type: z.literal('citation'), conceptKey: KeySchema, label: z.string().optional() }),
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
  for (const ev of events) {
    if (ev.type === 'token') answer += ev.text;
    else if (ev.type === 'citation' && !citations.includes(ev.conceptKey)) citations.push(ev.conceptKey);
    else if (ev.type === 'done') threadId = ev.threadId;
  }
  return { answer, citations, ...(threadId ? { threadId } : {}) };
}
