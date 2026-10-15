/** Admin: builds (§8 Build) — list and (re)build a version without moving the published pointer. */
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { pageOf } from '../../repo/paging.js';
import type { BuildRec } from '../../repo/types.js';
import { authorizeSubject, iso, reg } from './util.js';

export const toBuildDto = (b: BuildRec) => ({
  id: b.id,
  topicKey: b.topicKey,
  topicVersionId: b.topicVersionId,
  version: b.version,
  status: b.status,
  ...(b.hash ? { hash: b.hash } : {}),
  ...(b.packageUrl ? { packageUrl: b.packageUrl } : {}),
  log: b.log,
  createdAt: iso(b.createdAt),
});

export function registerBuildAdmin(app: FastifyInstance, deps: Deps) {
  const { repo } = deps;

  reg(app, deps, 'adminBuildList', async (ctx) => {
    const q = ctx.query as { topicKey?: string; status?: BuildRec['status']; order?: 'asc' | 'desc'; cursor?: string; limit?: number };
    const res = await repo.listBuilds({ topicKey: q.topicKey, status: q.status }, pageOf(q), q.order ?? 'asc');
    return { items: res.items.map(toBuildDto), nextCursor: res.nextCursor };
  });

  reg(app, deps, 'adminBuildCreate', async (ctx) => {
    const ver = await repo.getTopicVersion(ctx.params.topicVersionId);
    const topic = ver ? await repo.getTopic(ver.topicId) : null;
    if (!ver || !topic) fail('not_found', { detail: 'topic_version' });
    authorizeSubject(ctx, 'content.publish', topic.subjectKey);
    const { build } = await deps.content.publishing.build(topic, ver);
    return toBuildDto(build);
  });
}
