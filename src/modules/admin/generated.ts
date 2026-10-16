/**
 * Review queue for AI-generated examples and practice questions (contract
 * 0.4.0): GET /admin/generated, PATCH /admin/generated/:id.
 *
 * Editors see what teachers were shown, how often, and how teachers rated
 * it. Approving puts an item first in the pool; dismissing stops serving it;
 * «promoted» records that an editor copied it into the content (item bank or
 * concept examples, through the normal editors and publishing workflow).
 * Access follows the topic's subject, like any other content edit.
 */
import type { FastifyInstance } from 'fastify';
import { can } from '@bilig/permissions';
import type { AdminGenerated, AdminGeneratedListQuery, AdminGeneratedPatch } from '@bilig/content-model/api';
import type { DraftExample, DraftQuizItem } from '@bilig/content-model';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { pageArray, pageOf, sortedPage } from '../../repo/paging.js';
import type { GeneratedRec } from '../../repo/types.js';
import { iso, reg, type AnyCtx } from './util.js';

export function toAdminGenerated(g: GeneratedRec): AdminGenerated {
  const base = {
    id: g.id,
    kind: g.kind,
    topicKey: g.topicKey,
    ...(g.conceptKey ? { conceptKey: g.conceptKey } : {}),
    lang: g.lang,
    status: g.status,
    good: g.good,
    bad: g.bad,
    reasons: g.reasons as AdminGenerated['reasons'],
    served: g.served,
    createdAt: iso(g.createdAt),
    ...(g.reviewedAt ? { reviewedAt: iso(g.reviewedAt) } : {}),
    ...(g.reviewedBy ? { reviewedBy: g.reviewedBy } : {}),
    ...(g.promotedTo ? { promotedTo: g.promotedTo } : {}),
  };
  if (g.kind === 'quiz') return { ...base, quiz: { id: g.id, ...(g.payload as DraftQuizItem) } };
  return { ...base, example: { id: g.id, ...(g.payload as DraftExample) } };
}

export function registerGeneratedAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit } = deps;

  /** topicKey → subjectKey for the caller's scope check (deleted topics drop out). */
  async function subjects(): Promise<Map<string, string>> {
    const topics = (await repo.listTopics({}, { limit: 100_000 })).items;
    return new Map(topics.filter((t) => !t.deletedAt).map((t) => [t.key, t.subjectKey]));
  }
  const mayEdit = (ctx: AnyCtx, subjectKey: string | undefined) => !!subjectKey && can(ctx.auth.principal, 'content.draft.edit', { subjectId: subjectKey });

  reg(app, deps, 'adminGeneratedList', async (ctx) => {
    const q = ctx.query as AdminGeneratedListQuery & { reported?: boolean };
    const bySubject = await subjects();
    const rows = (
      await repo.listGenerated({ ...(q.topicKey ? { topicKey: q.topicKey } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.lang ? { lang: q.lang } : {}), ...(q.status ? { status: q.status } : {}) }, { limit: 100_000 })
    ).items.filter((g) => mayEdit(ctx, bySubject.get(g.topicKey)) && (q.reported === undefined || (g.bad > 0) === q.reported));
    const page = pageOf(q);
    const res =
      !q.sort && q.order !== 'desc'
        ? pageArray(rows, page, (g) => g.id)
        : sortedPage(rows, { value: (g) => (q.sort && q.sort !== 'createdAt' ? g[q.sort] : iso(g.createdAt)), tie: (g) => g.id, order: q.order }, page);
    return { items: res.items.map(toAdminGenerated), nextCursor: res.nextCursor };
  });

  reg(app, deps, 'adminGeneratedPatch', async (ctx) => {
    const body = ctx.body as AdminGeneratedPatch;
    const g = await repo.getGenerated(ctx.params.id);
    const subjectKey = g ? (await subjects()).get(g.topicKey) : undefined;
    if (!g || !mayEdit(ctx, subjectKey)) fail('not_found', { detail: 'generated' });
    if (body.status === 'promoted' && !body.promotedTo) fail('validation_failed', { detail: 'promotedTo is required for promoted', issues: [{ path: ['promotedTo'], message: 'Required' }] });
    const userId = ctx.auth.user!.id;
    const next = await repo.updateGenerated(g.id, {
      status: body.status,
      reviewedAt: body.status === 'new' ? null : clock.now(),
      reviewedBy: body.status === 'new' ? null : userId,
      promotedTo: body.status === 'promoted' ? body.promotedTo! : null,
    });
    if (!next) fail('not_found', { detail: 'generated' });
    await audit.log(userId, `generated.${body.status}`, { type: 'generated', id: g.id }, { ip: ctx.ip, diff: { from: g.status, to: body.status, topicKey: g.topicKey, ...(body.promotedTo ? { promotedTo: body.promotedTo } : {}) } });
    return toAdminGenerated(next);
  });
}
