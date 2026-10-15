/**
 * bilig_back HTTP server (Fastify). Routes are thin; all authorization goes
 * through @bilig/permissions (TZ §2: "права проверяются только на backend").
 * `buildServer()` is exported without listening so tests drive it via inject().
 */
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  can,
  type Permission,
  type Principal,
  type ResourceContext,
} from '@bilig/permissions';
import { principalFromAuth } from './principal.js';
import { getCatalog, getPackageBySlug } from './content-repo.js';
import { askTutor, TutorUnavailable } from './tutor.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

const TutorBody = z.object({
  question: z.string().min(1).max(2000),
  lang: z.enum(['ky', 'ru', 'en']),
  topicTitle: z.string().max(200).optional(),
  conceptTitle: z.string().max(200).optional(),
  context: z.string().max(8000).optional(),
});

/** Reply 403 and return false when the principal lacks the permission. */
function ensure(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  resource: ResourceContext = {},
): boolean {
  if (can(req.principal, permission, resource)) return true;
  reply.code(403).send({ error: 'forbidden', permission });
  return false;
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  });

  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req) => {
    req.principal = principalFromAuth(req.headers.authorization);
  });

  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }));

  // Catalog & packages: guests may see demo content (TZ §2 demo.view).
  app.get('/api/catalog', async (req, reply) => {
    if (!ensure(req, reply, 'demo.view')) return;
    return getCatalog();
  });

  app.get('/api/packages/:slug', async (req, reply) => {
    if (!ensure(req, reply, 'demo.view')) return;
    const { slug } = req.params as { slug: string };
    const pkg = getPackageBySlug(slug);
    if (!pkg) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    return pkg;
  });

  // AI tutor (TZ W-32). Guests allowed with a rate limit ('limit' grant); the
  // actual quota is enforced here in a later iteration. 503 => client offline fallback.
  app.post('/api/tutor', async (req, reply) => {
    if (!ensure(req, reply, 'assistant.ask.online')) return;
    const parsed = TutorBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const answer = await askTutor(parsed.data);
      return { answer };
    } catch (err) {
      if (err instanceof TutorUnavailable) {
        reply.code(503).send({ error: 'tutor_unavailable', reason: err.message });
        return;
      }
      req.log.error(err);
      reply.code(500).send({ error: 'internal' });
      return;
    }
  });

  return app;
}
