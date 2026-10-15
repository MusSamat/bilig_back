/** Typed HTTP errors → application/problem+json (RFC 9457) with i18n keys. */
import type { FastifyReply } from 'fastify';
import { PROBLEM_CONTENT_TYPE, problem, type ErrorCode, type Problem } from '@bilig/content-model/api';
import type { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: Partial<Omit<Problem, 'code'>> = {},
  ) {
    super(extra.detail ?? code);
    this.name = 'HttpError';
  }
}

export function fail(code: ErrorCode, extra: Partial<Omit<Problem, 'code'>> = {}): never {
  throw new HttpError(code, extra);
}

export const zodIssues = (e: ZodError) => e.issues.map((i) => ({ path: i.path, message: i.message }));

export function sendProblem(reply: FastifyReply, code: ErrorCode, extra: Partial<Omit<Problem, 'code'>> = {}) {
  const body = problem(code, { instance: reply.request?.id ? `urn:request:${reply.request.id}` : undefined, ...extra });
  if (body.retryAfter !== undefined) reply.header('Retry-After', String(body.retryAfter));
  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}
