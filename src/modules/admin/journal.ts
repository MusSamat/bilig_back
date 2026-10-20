/**
 * Contract 0.8.0 §4: the action journal. `audit.read` — a manager sees only
 * their own records, SuperAdmin all of them; filters by staff member, «on
 * behalf of», group / action, object, period and result; newest first with a
 * cursor. CSV export is streamed and itself journaled. SuperAdmin verifies the
 * hash chain and sees the alerts (mass deletion, broken chain, edit-mode support).
 */
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AuditEvent, AuditEventQuery } from '@bilig/content-model/api';
import { grantFor } from '@bilig/permissions';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { pageOf } from '../../repo/paging.js';
import type { AuditEventRec, JournalFilter } from '../../repo/types.js';
import { iso, reg, type AnyCtx } from './util.js';

/** CSV cell: quoted, and spreadsheet formulas neutralised (CSV injection). */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const CSV_COLUMNS = ['seq', 'at', 'actor_id', 'actor_name', 'actor_role', 'on_behalf_of_id', 'on_behalf_of_name', 'group', 'action', 'target_type', 'target_id', 'target_label', 'before', 'after', 'reason', 'result', 'ip', 'user_agent', 'request_id', 'support_session_id', 'hash'];

export function registerJournalAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, audit, clock } = deps;

  /** The filter from the query; a manager (`own`) is pinned to their own records. */
  function filterOf(ctx: AnyCtx): JournalFilter {
    const q = ctx.query as AuditEventQuery;
    const own = grantFor(ctx.auth.principal, 'audit.read') !== 'all';
    const me = ctx.auth.user!.id;
    if (own && q.actorId && q.actorId !== me) fail('forbidden', { detail: 'audit.read:own' });
    return {
      actorId: own ? me : q.actorId,
      onBehalfOfId: q.onBehalfOfId,
      group: q.group,
      action: q.action,
      targetType: q.targetType,
      targetId: q.targetId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      result: q.result,
    };
  }

  /** Display names of the actors and «on behalf of» of a page. */
  async function namesOf(rows: AuditEventRec[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((e) => [e.actorId, e.onBehalfOfId]).filter((x): x is string => !!x))];
    return new Map((await repo.getUsers(ids)).map((u) => [u.id, u.displayName]));
  }

  const toDto = (e: AuditEventRec, names: Map<string, string>): AuditEvent => ({
    id: e.id,
    seq: e.seq,
    at: iso(e.at),
    actor: { id: e.actorId, displayName: e.actorId ? (names.get(e.actorId) ?? null) : null, role: e.actorRole },
    onBehalfOf: e.onBehalfOfId ? { id: e.onBehalfOfId, displayName: names.get(e.onBehalfOfId) ?? '' } : null,
    group: e.group,
    action: e.action,
    target: { type: e.targetType, id: e.targetId, label: e.targetLabel },
    before: e.before ?? null,
    after: e.after ?? e.details ?? null,
    reason: e.reason,
    result: e.result,
    ip: e.ip,
    userAgent: e.userAgent,
    requestId: e.requestId,
    supportSessionId: e.supportSessionId,
  });

  reg(app, deps, 'journal', async (ctx) => {
    const page = await repo.listJournal(filterOf(ctx), pageOf(ctx.query as AuditEventQuery, 50, 200));
    const names = await namesOf(page.items);
    return { items: page.items.map((e) => toDto(e, names)), nextCursor: page.nextCursor };
  });

  reg(app, deps, 'journalExport', async (ctx) => {
    const filter = filterOf(ctx);
    // The export itself is journaled (before streaming: a broken download is still an export).
    await audit.log(ctx.auth.user!.id, 'export.journal_csv', { type: 'journal', id: 'csv' }, { ip: ctx.ip, after: { filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() } } });
    async function* lines() {
      yield `﻿${CSV_COLUMNS.join(',')}\r\n`;
      let cursor: string | undefined;
      do {
        const page = await repo.listJournal(filter, { cursor, limit: 500 });
        const names = await namesOf(page.items);
        let chunk = '';
        for (const e of page.items) {
          const d = toDto(e, names);
          chunk += `${[d.seq, d.at, d.actor.id, d.actor.displayName, d.actor.role, d.onBehalfOf?.id, d.onBehalfOf?.displayName, d.group, d.action, d.target.type, d.target.id, d.target.label, d.before, d.after, d.reason, d.result, d.ip, d.userAgent, d.requestId, d.supportSessionId, e.hash].map(csvCell).join(',')}\r\n`;
        }
        if (chunk) yield chunk;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    ctx.reply.header('Cache-Control', 'no-store');
    const stamp = iso(clock.now()).slice(0, 19).replace(/[:T]/g, '-');
    return { body: Readable.from(lines()), contentType: 'text/csv; charset=utf-8', filename: `journal-${stamp}.csv` };
  });

  reg(app, deps, 'journalVerify', async () => {
    const r = await repo.verifyJournal();
    if (!r.ok && r.brokenAt !== null) await audit.alert('chain_broken', `chain_broken:${r.brokenAt}`, null, `The journal hash chain is broken at #${r.brokenAt}`);
    return r;
  });

  reg(app, deps, 'journalAlerts', async () => {
    const rows = await repo.listAlerts(200);
    const names = new Map((await repo.getUsers([...new Set(rows.map((a) => a.actorId).filter((x): x is string => !!x))])).map((u) => [u.id, u.displayName]));
    return {
      items: rows.map((a) => ({
        id: a.id,
        at: iso(a.at),
        kind: a.kind,
        actor: { id: a.actorId, displayName: a.actorId ? (names.get(a.actorId) ?? null) : null },
        summary: a.summary,
        seenAt: a.seenAt ? iso(a.seenAt) : null,
      })),
    };
  });

  reg(app, deps, 'journalAlertSeen', async (ctx) => {
    if (!(await repo.markAlertSeen(ctx.params.id, clock.now()))) fail('not_found', { detail: 'alert' });
    return { ok: true as const };
  });
}
