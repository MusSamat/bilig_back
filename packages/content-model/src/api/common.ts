/**
 * API conventions (TZ §9): REST under /api/v1, JSON, problem+json errors
 * (RFC 9457), cursor pagination, If-Match versions, Idempotency-Key for sync.
 */
import { z } from 'zod';

export const API_PREFIX = '/api/v1';

export const HEADERS = {
  idempotencyKey: 'Idempotency-Key',
  ifMatch: 'If-Match',
  acceptLanguage: 'Accept-Language',
  authorization: 'Authorization',
} as const;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const SSE_CONTENT_TYPE = 'text/event-stream';

/** UUID (v7 in production). */
export const IdSchema = z.string().uuid();
export const DateTimeSchema = z.string().datetime({ offset: true });

/** Stable error codes; `i18nKey` is `errors.<code>` unless stated otherwise. */
export const ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'version_mismatch',
  'idempotency_conflict',
  'rate_limited',
  'invalid_credentials',
  'class_code_invalid',
  'pin_locked',
  'tutor_unavailable',
  'payload_too_large',
  'internal',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** application/problem+json body (RFC 9457) + Bilig extensions. */
export const ProblemSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: ErrorCodeSchema,
  /** Client-side localization key for the message. */
  i18nKey: z.string().min(1),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Field-level validation issues. */
  issues: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
    .optional(),
  /** Seconds until retry (rate limit / lockout). */
  retryAfter: z.number().int().min(0).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_mismatch: 409,
  idempotency_conflict: 409,
  payload_too_large: 413,
  class_code_invalid: 404,
  pin_locked: 423,
  rate_limited: 429,
  internal: 500,
  tutor_unavailable: 503,
};

/** Build a problem body with defaults for `type`, `title`, `status`, `i18nKey`. */
export function problem(
  code: ErrorCode,
  extra: Partial<Omit<Problem, 'code'>> = {},
): Problem {
  return {
    type: `https://bilig.kg/problems/${code}`,
    title: code.replace(/_/g, ' '),
    status: DEFAULT_STATUS[code],
    i18nKey: `errors.${code}`,
    ...extra,
    code,
  };
}

export const PageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** Cursor-paginated list `{ items, nextCursor }` (null = last page). */
export const cursorPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const EmptySchema = z.object({}).strict();
export const OkSchema = z.object({ ok: z.literal(true) });

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  /** CONTRACT_VERSION the server was built with. */
  contract: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Optimistic-lock version used with If-Match (admin, presentations). */
export const VersionTagSchema = z.number().int().min(0);
