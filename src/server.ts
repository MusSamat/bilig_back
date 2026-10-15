/**
 * bilig_back HTTP server (Fastify). Routes, paths and payloads come from the
 * shared contract (@bilig/content-model/api ENDPOINTS); authorization goes
 * through @bilig/permissions (TZ §2: "права проверяются только на backend").
 * Errors are application/problem+json (TZ §9). `buildServer()` does not listen,
 * so tests drive it via inject().
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type { ZodError } from 'zod';
import { CONTRACT_VERSION } from '@bilig/content-model';
import {
  ENDPOINTS,
  PROBLEM_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  TutorAskRequestSchema,
  encodeSseEvent,
  problem,
  routePath,
  type ErrorCode,
  type HealthResponse,
  type MeResponse,
  type Problem,
  type SubjectsResponse,
  type TopicManifestResponse,
} from '@bilig/content-model/api';
import {
  can,
  grantedPermissions,
  isGuest,
  type Permission,
  type Principal,
  type ResourceContext,
} from '@bilig/permissions';
import { principalFromAuth } from './principal.js';
import { loadContentRepo, type ContentRepo } from './content-repo.js';
import { askTutor, TutorUnavailable } from './tutor.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

function sendProblem(reply: FastifyReply, code: ErrorCode, extra: Partial<Omit<Problem, 'code'>> = {}): void {
  const body = problem(code, extra);
  reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

const zodIssues = (e: ZodError) => e.issues.map((i) => ({ path: i.path, message: i.message }));

/** Reply 403/401 problem and return false when the principal lacks the permission. */
function ensure(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  resource: ResourceContext = {},
): boolean {
  if (can(req.principal, permission, resource)) return true;
  sendProblem(reply, isGuest(req.principal) ? 'unauthorized' : 'forbidden', { detail: permission });
  return false;
}

export interface ServerOptions {
  repo?: ContentRepo;
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const repo = opts.repo ?? loadContentRepo();

  app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  });

  app.decorateRequest('principal', null as unknown as Principal);
  app.addHook('preHandler', async (req) => {
    req.principal = principalFromAuth(req.headers.authorization);
  });

  app.setNotFoundHandler((_req, reply) => sendProblem(reply, 'not_found'));
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 400) sendProblem(reply, 'validation_failed', { detail: (err as Error).message });
    else sendProblem(reply, 'internal');
  });

  app.get(routePath('health'), async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: '0.2.0',
    contract: CONTRACT_VERSION,
  }));

  app.get(routePath('me'), async (req, reply) => {
    if (isGuest(req.principal) || !req.principal.userId) return sendProblem(reply, 'unauthorized');
    const me: MeResponse = {
      id: req.principal.userId,
      kind: req.principal.grants.some((g) => g.role === 'student') ? 'student' : 'adult',
      displayName: 'dev',
      locale: 'ky',
      grants: req.principal.grants,
      permissions: grantedPermissions(req.principal),
    };
    return me;
  });

  // Catalog (guests may see demo content, TZ §2 demo.view).
  app.get(routePath('catalog'), async (req, reply) => {
    if (!ensure(req, reply, ENDPOINTS.catalog.auth)) return;
    return repo.catalog();
  });

  app.get(routePath('subjects'), async (req, reply) => {
    if (!ensure(req, reply, ENDPOINTS.subjects.auth)) return;
    const { groups, subjects } = repo.catalog();
    const body: SubjectsResponse = { groups, subjects };
    return body;
  });

  app.get(routePath('topicManifest'), async (req, reply) => {
    if (!ensure(req, reply, ENDPOINTS.topicManifest.auth)) return;
    const { key } = req.params as { key: string };
    const manifest = repo.getManifest(key);
    if (!manifest) return sendProblem(reply, 'not_found', { detail: key });
    const body: TopicManifestResponse = {
      manifest,
      packageUrl: routePath('topicPackage').replace(':key', encodeURIComponent(key)),
      filesBaseUrl: `/cdn/${manifest.hash}/`,
    };
    return body;
  });

  // Dev stand-in for the CDN package URL.
  app.get(routePath('topicPackage'), async (req, reply) => {
    if (!ensure(req, reply, ENDPOINTS.topicPackage.auth)) return;
    const { key } = req.params as { key: string };
    const pkg = repo.getPackage(key);
    if (!pkg) return sendProblem(reply, 'not_found', { detail: key });
    return pkg;
  });

  // Tutor (W-32). SSE by default; `Accept: application/json` → single JSON body.
  // Guests are allowed with a 'limit' grant; the quota is enforced in a later iteration.
  app.post(routePath('tutorAsk'), async (req, reply) => {
    if (!ensure(req, reply, ENDPOINTS.tutorAsk.auth)) return;
    const parsed = TutorAskRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendProblem(reply, 'validation_failed', { issues: zodIssues(parsed.error) });
    const pkg = repo.getPackage(parsed.data.topicKey);
    if (!pkg) return sendProblem(reply, 'not_found', { detail: parsed.data.topicKey });
    try {
      const result = await askTutor(parsed.data, pkg);
      if ((req.headers.accept ?? '').includes('application/json')) return result;
      const frames = [
        encodeSseEvent({ type: 'token', text: result.answer }),
        ...result.citations.map((conceptKey) => encodeSseEvent({ type: 'citation', conceptKey })),
        encodeSseEvent({ type: 'done', ...(result.threadId ? { threadId: result.threadId } : {}) }),
      ];
      reply.type(SSE_CONTENT_TYPE).header('Cache-Control', 'no-cache');
      return frames.join('');
    } catch (err) {
      if (err instanceof TutorUnavailable) return sendProblem(reply, 'tutor_unavailable', { detail: err.message });
      req.log.error(err);
      return sendProblem(reply, 'internal');
    }
  });

  return app;
}
