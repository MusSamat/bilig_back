/**
 * bilig_back HTTP app (Fastify 5). `buildApp(deps)` does not listen, so tests
 * drive it with inject(). Cross-cutting concerns live here: structured JSON
 * logs with a trace id (no PII), helmet CSP without unsafe-inline, CORS for
 * the client origins, body limits, problem+json errors, authentication.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { CONTRACT_VERSION } from '@bilig/content-model';
import { API_PREFIX, HEADERS } from '@bilig/content-model/api';
import type { Deps } from './deps.js';
import { newId } from './ids.js';
import { GUEST_CTX, resolveAuth, type AuthCtx } from './http/auth-context.js';
import { HttpError, sendProblem } from './http/errors.js';
import { route } from './http/route.js';
import { requestContext } from './http/request-context.js';
import { isReadOnlyMethod, isSupportEndPath, isSupportForbidden } from './services/support.js';
import { registerAuth } from './modules/auth.js';
import { registerMe } from './modules/me.js';
import { registerCatalog } from './modules/catalog.js';
import { registerLearning } from './modules/learning.js';
import { registerClasses } from './modules/classes.js';
import { registerTutor } from './modules/tutor.js';
import { registerDecks } from './modules/decks.js';
import { registerKtp } from './modules/ktp.js';
import { registerTopicDeck } from './modules/topic-deck.js';
import { registerAdmin } from './modules/admin/index.js';
import { registerCdn } from './modules/cdn.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthCtx;
  }
}

export const APP_VERSION = '0.3.0';
/** Default JSON body limit; larger per-route limits are declared at registration. */
export const BODY_LIMIT = 1024 * 1024;
const GLOBAL_IP_LIMIT_PER_MIN = 1200;

const TRACE_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: BODY_LIMIT,
    // Trace id: honour X-Request-Id / W3C traceparent from the client or proxy, else UUID v7.
    genReqId: (req) => {
      const h = req.headers[HEADERS.requestId.toLowerCase()];
      if (typeof h === 'string' && TRACE_RE.test(h)) return h;
      const tp = req.headers.traceparent;
      if (typeof tp === 'string') {
        const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(tp);
        if (m) return m[1];
      }
      return newId();
    },
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // No PII in logs: tokens, cookies and bodies are never logged; URLs without query strings.
            redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], remove: true },
            serializers: {
              req: (req) => ({ method: req.method, url: String(req.url).split('?')[0], traceId: req.id }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Accept-Language', HEADERS.idempotencyKey, HEADERS.ifMatch, HEADERS.audience, HEADERS.requestId, 'traceparent'],
    exposedHeaders: [HEADERS.requestId, 'ETag', 'Retry-After', 'Content-Disposition', 'Content-Language'],
    maxAge: 600,
  });
  await app.register(cookie);

  app.decorateRequest('auth', null as unknown as AuthCtx);

  // v0.8.0: per-request context for the journal (request id, IP, user agent, caller).
  app.addHook('onRequest', (req, _reply, done) => {
    const ua = req.headers['user-agent'];
    requestContext.run({ requestId: req.id, ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null }, done);
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header(HEADERS.requestId, req.id);
    const r = await deps.limiter.hit(`ip:${req.ip}`, GLOBAL_IP_LIMIT_PER_MIN, 60);
    if (!r.allowed) throw new HttpError('rate_limited', { retryAfter: r.retryAfter });
    req.auth = GUEST_CTX;
  });
  app.addHook('preHandler', async (req) => {
    req.auth = await resolveAuth(req, deps);
    const store = requestContext.getStore();
    if (store) store.auth = req.auth;
    // v0.8.0 support sessions: closed areas in every mode, read-only view mode.
    const sp = req.auth.support;
    if (sp) {
      if (isSupportForbidden(req.method, req.url)) throw new HttpError('forbidden', { detail: 'support_forbidden', i18nKey: 'errors.support_forbidden' });
      if (sp.session.mode === 'view' && !isReadOnlyMethod(req.method) && !isSupportEndPath(req.url))
        throw new HttpError('forbidden', { detail: 'support_read_only', i18nKey: 'errors.support_read_only' });
    }
  });
  // v0.8.0: every request in a support session that changes data (or is refused) is journaled with both ids.
  app.addHook('onResponse', async (req, reply) => {
    const sp = req.auth?.support;
    if (!sp || (isReadOnlyMethod(req.method) && reply.statusCode !== 403)) return;
    const route = req.routeOptions?.url ?? req.url.split('?')[0];
    const status = reply.statusCode;
    await deps.audit
      .log(sp.session.actorId, status === 403 ? 'support.denied' : 'support.request', { type: 'route', id: `${req.method} ${route}`.slice(0, 200) }, {
        onBehalfOf: sp.session.teacherId,
        supportSessionId: sp.session.id,
        result: status < 400 ? 'ok' : status === 401 || status === 403 ? 'denied' : 'failed',
        diff: { mode: sp.session.mode, status, path: req.url.split('?')[0].slice(0, 300) },
      })
      .catch((err) => req.log.error({ err: String(err) }, 'support journal write failed'));
  });

  app.setNotFoundHandler((_req, reply) => sendProblem(reply, 'not_found'));
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return sendProblem(reply, err.code, err.extra);
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) return sendProblem(reply, 'payload_too_large');
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.statusCode === 415)
      return sendProblem(reply, 'validation_failed', { status: 415, detail: 'unsupported media type' });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)
      return sendProblem(reply, 'validation_failed', { detail: e.code ?? 'bad_request' });
    req.log.error({ err: { name: (err as Error).name, message: e.message, code: e.code } }, 'unhandled error');
    return sendProblem(reply, 'internal');
  });

  // --- system --------------------------------------------------------------------
  route(app, deps, 'health', () => ({ status: 'ok', version: APP_VERSION, contract: CONTRACT_VERSION }));
  route(app, deps, 'version', () => ({
    version: APP_VERSION,
    contract: CONTRACT_VERSION,
    ...(config.commit ? { commit: config.commit } : {}),
    node: process.version,
  }));
  route(app, deps, 'ready', async ({ reply }) => {
    const [db, cache] = await Promise.all([deps.repo.ping().catch(() => false), deps.limiter.ping().catch(() => false)]);
    const checks = {
      database: db ? ('ok' as const) : ('fail' as const),
      cache: deps.limiter.kind === 'memory' ? ('skipped' as const) : cache ? ('ok' as const) : ('fail' as const),
      tutor: deps.tutor ? ('ok' as const) : ('skipped' as const),
    };
    if (!db) reply.code(503);
    return { status: db && checks.cache !== 'fail' ? 'ok' : 'degraded', checks };
  });
  // Unprefixed aliases for orchestrators.
  app.get('/health', async (_req, reply) => reply.redirect(`${API_PREFIX}/health`, 307));

  // Object storage (dev/local): snapshots, exports. Keys are unguessable.
  app.get('/files/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    let obj = null;
    try {
      obj = await deps.storage.get(key);
    } catch {
      obj = null;
    }
    if (!obj) return sendProblem(reply, 'not_found');
    return reply
      .type(obj.contentType)
      .header('Cache-Control', 'private, max-age=86400')
      .header('X-Content-Type-Options', 'nosniff')
      .send(obj.body);
  });

  registerAuth(app, deps);
  registerMe(app, deps);
  registerCatalog(app, deps);
  registerLearning(app, deps);
  registerClasses(app, deps);
  registerTutor(app, deps);
  registerDecks(app, deps);
  registerKtp(app, deps);
  registerTopicDeck(app, deps);
  registerAdmin(app, deps);
  registerCdn(app, deps);

  return app;
}
