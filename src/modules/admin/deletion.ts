/**
 * Contract 0.8.0 §5: deletion requests. A manager (deletion.request) asks to
 * delete a teacher or content with a reason; SuperAdmin (deletion.approve)
 * approves with TOTP — the deletion runs then — or rejects with a note.
 * Execution: teacher → soft delete + sessions revoked; topic → archived;
 * concept / item / asset → the regular delete with its usage check (409
 * `in_use` while referenced; the request stays pending). Every step is journaled.
 */
import type { FastifyInstance } from 'fastify';
import { grantFor } from '@bilig/permissions';
import type { DeletionRequest } from '@bilig/content-model/api';
import type { Deps } from '../../deps.js';
import { fail, HttpError } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { pageOf } from '../../repo/paging.js';
import type { DeletionKind, DeletionRequestRec, DeletionStatus } from '../../repo/types.js';
import { isStaff, verifyStaffTotp } from '../../services/staff.js';
import { runWorkflow } from '../../services/workflow.js';
import { usageOf } from './content.js';
import { iso, reg, topicsWhere, type AnyCtx } from './util.js';

export function registerDeletionAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit } = deps;

  /** The target's canonical id and label; 404 when it does not exist. */
  async function resolveTarget(kind: DeletionKind, targetId: string): Promise<{ id: string; label: string }> {
    switch (kind) {
      case 'teacher': {
        const u = await repo.getUser(targetId).catch(() => null);
        const grants = u ? await repo.listGrants(u.id) : [];
        if (!u || u.deletedAt || !grants.some((g) => g.role === 'teacher')) fail('not_found', { detail: 'teacher' });
        if (isStaff(grants)) fail('forbidden', { detail: 'staff_account' });
        return { id: u!.id, label: u!.displayName };
      }
      case 'topic': {
        const t = (/^[0-9a-f-]{36}$/i.test(targetId) ? await repo.getTopic(targetId) : null) ?? (await repo.getTopicByKey(targetId));
        if (!t || t.deletedAt) fail('not_found', { detail: 'topic' });
        return { id: t!.id, label: t!.key };
      }
      case 'concept':
      case 'item': {
        const c = await repo.content(kind).get(targetId);
        if (!c) fail('not_found', { detail: kind });
        return { id: c!.key, label: c!.key };
      }
      case 'asset': {
        const a = await repo.getAsset(targetId).catch(() => null);
        if (!a) fail('not_found', { detail: 'asset' });
        return { id: a!.id, label: `${a!.key} (${a!.filename})` };
      }
    }
  }

  async function toDto(r: DeletionRequestRec): Promise<DeletionRequest> {
    const users = new Map((await repo.getUsers([r.requestedBy, ...(r.decidedBy ? [r.decidedBy] : [])])).map((u) => [u.id, u.displayName]));
    return {
      id: r.id,
      kind: r.kind,
      targetId: r.targetId,
      targetLabel: r.targetLabel,
      reason: r.reason,
      status: r.status,
      requestedBy: { id: r.requestedBy, displayName: users.get(r.requestedBy) ?? '' },
      requestedAt: iso(r.requestedAt),
      decidedBy: r.decidedBy ? { id: r.decidedBy, displayName: users.get(r.decidedBy) ?? '' } : null,
      decidedAt: r.decidedAt ? iso(r.decidedAt) : null,
      decisionNote: r.decisionNote,
    };
  }

  /** Run the deletion as the approving SuperAdmin. */
  async function execute(ctx: AnyCtx, r: DeletionRequestRec): Promise<void> {
    const actor = ctx.auth.user!.id;
    const now = clock.now();
    const meta = { ip: ctx.ip, reason: r.reason, after: { deletionRequestId: r.id } };
    switch (r.kind) {
      case 'teacher': {
        const u = await repo.getUser(r.targetId);
        if (!u) fail('not_found', { detail: 'teacher' });
        if (u!.deletedAt) return;
        await repo.updateUser(u!.id, { deletedAt: now, status: 'blocked' });
        const revoked = await repo.revokeUserSessions(u!.id, now);
        await audit.log(actor, 'teacher.deleted', { type: 'user', id: u!.id, label: u!.displayName }, { ...meta, after: { deletionRequestId: r.id, revoked } });
        return;
      }
      case 'topic': {
        const t = await repo.getTopic(r.targetId);
        if (!t) fail('not_found', { detail: 'topic' });
        if (t!.status === 'archived') return;
        await runWorkflow(deps, t!, 'archive', { actorId: actor, ip: ctx.ip, reason: `deletion request ${r.id}: ${r.reason}`.slice(0, 500) });
        return;
      }
      case 'concept':
      case 'item': {
        const store = repo.content(r.kind);
        if (!(await store.get(r.targetId))) fail('not_found', { detail: r.kind });
        const used = await usageOf(deps, r.kind, r.targetId);
        if (used.length) fail('in_use', { detail: used.slice(0, 20).join(', ') });
        if ((await store.delete(r.targetId, null)) !== 'ok') fail('not_found', { detail: r.kind });
        deps.content.invalidate();
        await audit.log(actor, 'content.deleted', { type: r.kind, id: r.targetId, label: r.targetLabel }, meta);
        return;
      }
      case 'asset': {
        const a = await repo.getAsset(r.targetId);
        if (!a) fail('not_found', { detail: 'asset' });
        const used = await topicsWhere(deps, (d) => !!d.scene.asset?.includes(a!.key) || !!d.rights?.some((x) => x.covers === a!.key));
        if (used.length) fail('in_use', { detail: used.slice(0, 20).map((k) => `topic:${k}`).join(', ') });
        await repo.deleteAsset(a!.id);
        await audit.log(actor, 'asset.deleted', { type: 'asset', id: a!.id, label: r.targetLabel }, meta);
        return;
      }
    }
  }

  async function loadPending(ctx: AnyCtx): Promise<DeletionRequestRec> {
    const r = await repo.getDeletionRequest(ctx.params.id);
    if (!r) fail('not_found', { detail: 'deletion_request' });
    if (r!.status !== 'pending') fail('conflict', { detail: `already_${r!.status}` });
    return r!;
  }

  reg(app, deps, 'deletionList', async (ctx) => {
    const q = ctx.query as { status?: DeletionStatus; cursor?: string; limit?: number };
    // Managers see their own requests; SuperAdmin (who decides) sees all.
    const all = grantFor(ctx.auth.principal, 'deletion.approve') !== false;
    const page = await repo.listDeletionRequests({ status: q.status, ...(all ? {} : { requestedBy: ctx.auth.user!.id }) }, pageOf(q));
    return { items: await Promise.all(page.items.map(toDto)), nextCursor: page.nextCursor };
  });

  reg(app, deps, 'deletionCreate', async (ctx) => {
    const b = ctx.body as { kind: DeletionKind; targetId: string; reason: string };
    const target = await resolveTarget(b.kind, b.targetId);
    const pending = await repo.listDeletionRequests({ status: 'pending' }, { limit: 10_000 });
    if (pending.items.some((r) => r.kind === b.kind && r.targetId === target.id)) fail('conflict', { detail: 'already_requested' });
    const rec: DeletionRequestRec = {
      id: newId(),
      kind: b.kind,
      targetId: target.id,
      targetLabel: target.label,
      reason: b.reason,
      status: 'pending',
      requestedBy: ctx.auth.user!.id,
      requestedAt: clock.now(),
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    };
    await repo.createDeletionRequest(rec);
    await audit.log(rec.requestedBy, 'deletion.requested', { type: b.kind, id: target.id, label: target.label }, { ip: ctx.ip, reason: b.reason, after: { deletionRequestId: rec.id } });
    return toDto(rec);
  });

  reg(app, deps, 'deletionApprove', async (ctx) => {
    const b = ctx.body as { note?: string; totp: string };
    const r = await loadPending(ctx);
    await verifyStaffTotp(deps, ctx.auth.user!.id, b.totp);
    try {
      await execute(ctx, r);
    } catch (e) {
      // The request stays pending (e.g. still referenced); the attempt is journaled.
      const detail = e instanceof HttpError ? `${e.code}${e.extra.detail ? `: ${e.extra.detail}` : ''}` : 'internal';
      await audit.log(ctx.auth.user!.id, 'deletion.failed', { type: r.kind, id: r.targetId, label: r.targetLabel }, { ip: ctx.ip, result: 'failed', after: { deletionRequestId: r.id, error: detail.slice(0, 300) } });
      throw e;
    }
    const decided = await repo.decideDeletionRequest(r.id, { status: 'approved', decidedBy: ctx.auth.user!.id, decidedAt: clock.now(), decisionNote: b.note?.trim() || null });
    if (!decided) fail('conflict', { detail: 'already_decided' });
    await audit.log(ctx.auth.user!.id, 'deletion.approved', { type: r.kind, id: r.targetId, label: r.targetLabel }, { ip: ctx.ip, reason: r.reason, after: { deletionRequestId: r.id, note: decided!.decisionNote } });
    return toDto(decided!);
  });

  reg(app, deps, 'deletionReject', async (ctx) => {
    const b = ctx.body as { note?: string; totp: string };
    const r = await loadPending(ctx);
    await verifyStaffTotp(deps, ctx.auth.user!.id, b.totp);
    const decided = await repo.decideDeletionRequest(r.id, { status: 'rejected', decidedBy: ctx.auth.user!.id, decidedAt: clock.now(), decisionNote: b.note?.trim() || null });
    if (!decided) fail('conflict', { detail: 'already_decided' });
    await audit.log(ctx.auth.user!.id, 'deletion.rejected', { type: r.kind, id: r.targetId, label: r.targetLabel }, { ip: ctx.ip, reason: decided!.decisionNote, after: { deletionRequestId: r.id } });
    return toDto(decided!);
  });
}
