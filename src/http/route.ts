/**
 * Typed route registration from the shared ENDPOINTS table. Every route:
 *  1. checks the endpoint's coarse permission (`auth`) via @bilig/permissions;
 *  2. parses query and body with the contract schemas (400 problem on failure);
 *  3. enforces If-Match (428 when missing) and Idempotency-Key where declared;
 *  4. serialises the handler's result through the response schema, so the
 *     server can never drift from the contract (a mismatch is a 500 + log).
 * Scope checks ("своё") happen inside handlers via `ctx.authorize`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_PREFIX,
  ENDPOINTS,
  HEADERS,
  IdempotencyKeySchema,
  type EndpointName,
} from '@bilig/content-model/api';
import type { Lang } from '@bilig/content-model';
import { can, grantFor, isGuest, type Permission, type ResourceContext } from '@bilig/permissions';
import type { Deps } from '../deps.js';
import { negotiateLang } from '../domain/lang.js';
import type { AuthCtx } from './auth-context.js';
import { HttpError, fail, zodIssues } from './errors.js';

type Def<N extends EndpointName> = (typeof ENDPOINTS)[N];
export type BodyOf<N extends EndpointName> = Def<N> extends { body: infer B extends z.ZodTypeAny } ? z.output<B> : undefined;
export type QueryOf<N extends EndpointName> = Def<N> extends { query: infer Q extends z.ZodTypeAny } ? z.output<Q> : undefined;
export type ResultOf<N extends EndpointName> = Def<N> extends { produces: string } ? BinaryResult : z.input<Def<N>['response']>;

export interface BinaryResult {
  body: Buffer | string;
  contentType: string;
  filename?: string;
}

export interface Ctx<N extends EndpointName> {
  req: FastifyRequest;
  reply: FastifyReply;
  deps: Deps;
  auth: AuthCtx;
  body: BodyOf<N>;
  query: QueryOf<N>;
  params: Record<string, string>;
  /** Language from Accept-Language (or ?lang) — ky → ru → en fallback. */
  lang: Lang;
  /** If-Match version (numeric), present when the endpoint declares ifMatch; -1 when an optional If-Match was not sent. */
  ifMatch: number;
  idempotencyKey: string;
  ip: string;
  /** Throws 401/403 unless the principal may do `permission` on `resource` (scope-aware). */
  authorize(permission: Permission, resource?: ResourceContext): void;
  /** The signed-in user id, or 401. */
  userId(): string;
}

export interface RouteOptions {
  bodyLimit?: number;
}

/** Parse `If-Match: "3"`, `W/"3"` or `3` into a version number. */
export function parseIfMatch(v: string | undefined): number | null | 'invalid' {
  if (v === undefined || v === '') return null;
  const m = /^(?:W\/)?"?(\d{1,10})"?$/.exec(v.trim());
  return m ? Number(m[1]) : 'invalid';
}

export function route<N extends EndpointName>(
  app: FastifyInstance,
  deps: Deps,
  name: N,
  handler: (ctx: Ctx<N>) => Promise<ResultOf<N>> | ResultOf<N>,
  opts: RouteOptions = {},
): void {
  const def = ENDPOINTS[name] as unknown as {
    method: string;
    path: string;
    auth: Permission | 'session' | null;
    body?: z.ZodTypeAny;
    query?: z.ZodTypeAny;
    response: z.ZodTypeAny;
    idempotent?: boolean;
    ifMatch?: boolean;
    ifMatchOptional?: boolean;
    produces?: string;
  };

  app.route({
    method: def.method as 'GET',
    url: API_PREFIX + def.path,
    ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
    handler: async (req, reply) => {
      const auth = req.auth;
      const principal = auth.principal;

      // 1. coarse permission
      if (def.auth === 'session') {
        if (!auth.user) fail('unauthorized');
      } else if (def.auth) {
        if (grantFor(principal, def.auth) === false) fail(isGuest(principal) ? 'unauthorized' : 'forbidden', { detail: def.auth });
      }

      // 2. query & body
      let query: unknown = undefined;
      if (def.query) {
        const r = def.query.safeParse(req.query ?? {});
        if (!r.success) fail('validation_failed', { issues: zodIssues(r.error), detail: 'query' });
        else query = r.data;
      }
      let body: unknown = undefined;
      if (def.body) {
        const r = def.body.safeParse(req.body ?? {});
        if (!r.success) fail('validation_failed', { issues: zodIssues(r.error), detail: 'body' });
        else body = r.data;
      }

      // 3. If-Match / Idempotency-Key
      let ifMatch = -1;
      if (def.ifMatch) {
        const v = parseIfMatch(req.headers['if-match'] as string | undefined);
        if (v === null) fail('precondition_required', { detail: HEADERS.ifMatch });
        else if (v === 'invalid') fail('validation_failed', { detail: HEADERS.ifMatch });
        else ifMatch = v;
      } else if (def.ifMatchOptional) {
        const v = parseIfMatch(req.headers['if-match'] as string | undefined);
        if (v === 'invalid') fail('validation_failed', { detail: HEADERS.ifMatch });
        else if (v !== null) ifMatch = v;
      }
      let idempotencyKey = '';
      if (def.idempotent) {
        const r = IdempotencyKeySchema.safeParse(req.headers['idempotency-key']);
        if (!r.success) fail('validation_failed', { detail: `${HEADERS.idempotencyKey} header (UUID) is required` });
        else idempotencyKey = r.data;
      }

      const q = req.query as Record<string, unknown> | undefined;
      const ctx: Ctx<N> = {
        req,
        reply,
        deps,
        auth,
        body: body as BodyOf<N>,
        query: query as QueryOf<N>,
        params: (req.params ?? {}) as Record<string, string>,
        lang: negotiateLang(typeof q?.lang === 'string' ? q.lang : req.headers['accept-language'], auth.user?.locale ?? 'ky'),
        ifMatch,
        idempotencyKey,
        ip: req.ip,
        authorize(permission, resource = {}) {
          if (!can(principal, permission, resource)) fail(isGuest(principal) ? 'unauthorized' : 'forbidden', { detail: permission });
        },
        userId() {
          if (!auth.user) fail('unauthorized');
          return auth.user!.id;
        },
      };

      const result = await handler(ctx);
      if (reply.sent) return reply;

      // 4. serialise
      if (def.produces) {
        const bin = result as BinaryResult;
        reply.type(bin.contentType);
        if (bin.filename) reply.header('Content-Disposition', `attachment; filename="${bin.filename.replace(/[^\w.-]/g, '_')}"`);
        return reply.send(bin.body);
      }
      const out = def.response.safeParse(result);
      if (!out.success) {
        req.log.error({ endpoint: name, issues: zodIssues(out.error).slice(0, 10) }, 'response does not match contract');
        throw new HttpError('internal', { detail: 'response_contract' });
      }
      const data = out.data as { version?: unknown };
      if (data && typeof data === 'object' && typeof data.version === 'number') reply.header('ETag', `"${data.version}"`);
      return reply.send(out.data);
    },
  });
}
