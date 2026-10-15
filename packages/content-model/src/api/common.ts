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
  /** Token audience for auth calls: `client` (default) or `admin` (TZ §6). */
  audience: 'X-Bilig-Audience',
  /** Trace id echoed on every response (TZ §10 «логи JSON с trace-id»). */
  requestId: 'X-Request-Id',
} as const;

/** JWT `aud` values: the admin app gets its own audience (TZ §6). */
export const AUDIENCES = ['client', 'admin'] as const;
export const AudienceSchema = z.enum(AUDIENCES);
export type Audience = z.infer<typeof AudienceSchema>;

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
  // v0.2.1 (additive)
  /** Admin login for a 2FA role needs a TOTP code (retry with `totp`). */
  'totp_required',
  'email_not_verified',
  /** Password shorter than 10 chars or found in the leaked-password list. */
  'password_weak',
  /** If-Match header missing on a versioned write. */
  'precondition_required',
  /** Entity is referenced elsewhere (e.g. a concept used by topics) and cannot be deleted. */
  'in_use',
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
  totp_required: 401,
  email_not_verified: 403,
  password_weak: 400,
  precondition_required: 428,
  in_use: 409,
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

/** Query-string boolean: only `true`/`1` are true (z.coerce.boolean() would turn "false" into true). */
export const QueryBoolSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

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

// GET /ready — dependencies reachable (DB, cache)
export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.string(), z.enum(['ok', 'fail', 'skipped'])),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

// GET /version
export const VersionResponseSchema = z.object({
  version: z.string(),
  contract: z.string(),
  commit: z.string().optional(),
  node: z.string(),
});
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

/** Binary responses (PDF, PPTX, CSV, XLIFF): the endpoint declares `produces`. */
export const BinaryResponseSchema = z.custom<Uint8Array | string>(
  (v) => typeof v === 'string' || v instanceof Uint8Array,
);

/** Optimistic-lock version used with If-Match (admin, presentations). */
export const VersionTagSchema = z.number().int().min(0);
