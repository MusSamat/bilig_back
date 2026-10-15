/**
 * Admin: review comments (A-14) — a comment on a field (`path`) or on a point
 * of the 3D model (`anchor3d`) of a topic or a dictionary entry. Anyone who
 * may edit drafts of the target's subject reads, writes and resolves them;
 * only the author edits the text. Rejecting a topic also stores its reason as
 * a comment (services/workflow.ts).
 */
import type { FastifyInstance } from 'fastify';
import { can } from '@bilig/permissions';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { pageArray, pageOf } from '../../repo/paging.js';
import type { ReviewCommentRec } from '../../repo/types.js';
import { authorizeSubject, iso, reg, type AnyCtx } from './util.js';

type TargetType = ReviewCommentRec['targetType'];

export const toCommentDto = (c: ReviewCommentRec) => ({
  id: c.id,
  targetType: c.targetType,
  targetId: c.targetId,
  path: c.path,
  ...(c.anchor3d ? { anchor3d: c.anchor3d } : {}),
  body: c.body,
  ...(c.resolvedAt ? { resolvedAt: iso(c.resolvedAt) } : {}),
  authorId: c.authorId,
  createdAt: iso(c.createdAt),
  ...(c.resolvedBy ? { resolvedBy: c.resolvedBy } : {}),
  ...(c.topicVersion ? { topicVersion: c.topicVersion } : {}),
});

export function registerReviewAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit } = deps;

  /** The target's owning subject and (topics) latest version; null when it does not exist. */
  async function target(type: TargetType, id: string): Promise<{ subjectKey: string | null; latest?: string } | null> {
    if (type === 'topic') {
      const t = await repo.getTopic(id);
      if (!t) return null;
      const v = t.latestVersionId ? await repo.getTopicVersion(t.latestVersionId) : null;
      return { subjectKey: t.subjectKey, ...(v ? { latest: v.version } : {}) };
    }
    const rec = await repo.content(type).getById(id);
    return rec ? { subjectKey: rec.subjectKey } : null;
  }
  async function loadTarget(ctx: AnyCtx, type: TargetType, id: string) {
    const t = await target(type, id);
    if (!t) fail('not_found', { detail: type });
    authorizeSubject(ctx, 'content.draft.edit', t.subjectKey);
    return t;
  }

  reg(app, deps, 'adminReviewCommentList', async (ctx) => {
    const q = ctx.query as { targetType?: TargetType; targetId?: string; resolved?: boolean; authorId?: string; cursor?: string; limit?: number };
    const filter = { targetType: q.targetType, targetId: q.targetId, resolved: q.resolved, authorId: q.authorId };
    if (q.targetId) {
      if (!q.targetType) fail('validation_failed', { detail: 'targetType is required with targetId' });
      await loadTarget(ctx, q.targetType, q.targetId);
      const res = await repo.listReviewComments(filter, pageOf(q));
      return { items: res.items.map(toCommentDto), nextCursor: res.nextCursor };
    }
    // Across targets: only comments on entities the caller may edit.
    const rows = (await repo.listReviewComments(filter, { limit: 100_000 })).items;
    const allowed = new Map<string, boolean>();
    const visible: ReviewCommentRec[] = [];
    for (const c of rows) {
      const k = `${c.targetType}:${c.targetId}`;
      if (!allowed.has(k)) {
        const t = await target(c.targetType, c.targetId);
        allowed.set(k, !!t && can(ctx.auth.principal, 'content.draft.edit', t.subjectKey ? { subjectId: t.subjectKey } : {}));
      }
      if (allowed.get(k)) visible.push(c);
    }
    const res = pageArray(visible, pageOf(q), (c) => c.id);
    return { items: res.items.map(toCommentDto), nextCursor: res.nextCursor };
  });

  reg(app, deps, 'adminReviewCommentCreate', async (ctx) => {
    const b = ctx.body as { targetType: TargetType; targetId: string; path: string; anchor3d?: [number, number, number]; body: string; topicVersion?: string };
    const t = await loadTarget(ctx, b.targetType, b.targetId);
    if (b.topicVersion && b.targetType !== 'topic') fail('validation_failed', { detail: 'topicVersion is for topic comments' });
    const rec: ReviewCommentRec = {
      id: newId(),
      targetType: b.targetType,
      targetId: b.targetId,
      path: b.path,
      body: b.body,
      authorId: ctx.auth.user!.id,
      createdAt: clock.now(),
      resolvedAt: null,
      anchor3d: b.anchor3d ?? null,
      resolvedBy: null,
      topicVersion: b.targetType === 'topic' ? (b.topicVersion ?? t.latest ?? null) : null,
    };
    await repo.createReviewComment(rec);
    await audit.log(ctx.auth.user!.id, 'review.comment_created', { type: b.targetType, id: b.targetId }, { ip: ctx.ip, diff: { commentId: rec.id, path: b.path } });
    return toCommentDto(rec);
  });

  reg(app, deps, 'adminReviewCommentPatch', async (ctx) => {
    const c = await repo.getReviewComment(ctx.params.id);
    if (!c) fail('not_found', { detail: 'comment' });
    await loadTarget(ctx, c.targetType, c.targetId);
    const b = ctx.body as { resolved?: boolean; body?: string };
    if (b.body !== undefined && c.authorId !== ctx.auth.user!.id) fail('forbidden', { detail: 'author_only' });
    const now = clock.now();
    const patch = {
      ...(b.body !== undefined ? { body: b.body } : {}),
      ...(b.resolved === true && !c.resolvedAt ? { resolvedAt: now, resolvedBy: ctx.auth.user!.id } : {}),
      ...(b.resolved === false ? { resolvedAt: null, resolvedBy: null } : {}),
    };
    const next = await repo.updateReviewComment(c.id, patch);
    await audit.log(ctx.auth.user!.id, 'review.comment_updated', { type: c.targetType, id: c.targetId }, { ip: ctx.ip, diff: { commentId: c.id, ...(b.resolved !== undefined ? { resolved: b.resolved } : {}), edited: b.body !== undefined } });
    return toCommentDto(next!);
  });
}
