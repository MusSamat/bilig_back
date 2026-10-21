/**
 * The action journal (TZ §6, A-19; contract 0.8.0 §4): logins, role changes,
 * publishes, student-data access, staff and support actions. Every entry goes
 * to the append-only, hash-chained AuditEvent table. The request context
 * (AsyncLocalStorage) supplies the request id, IP, user agent and — inside a
 * support session — the staff member as the actor and the teacher as
 * «on behalf of». Secrets are stripped before anything is written.
 */
import { newId } from '../ids.js';
import { groupOf, sanitize } from '../domain/journal.js';
import { currentRequest } from '../http/request-context.js';
import type { AuditAlertKind, AuditGroup, AuditResult, Repository } from '../repo/types.js';
import type { Clock } from './clock.js';
import { primaryRole } from './staff.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.student_login'
  | 'auth.pin_locked'
  | 'auth.refresh_reuse'
  | 'auth.logout_all'
  | 'auth.password_reset'
  | 'auth.invite_accepted'
  | 'auth.2fa_enabled'
  | 'auth.2fa_disabled'
  | 'user.grants_changed'
  | 'user.status_changed'
  | 'user.2fa_reset'
  | 'user.sessions_revoked'
  | 'invite.created'
  | 'student.data_access'
  | 'student.created'
  | 'student.updated'
  | 'student.deleted'
  | 'student.pin_reset'
  | 'class.join_code_reissued'
  | 'content.created'
  | 'content.updated'
  | 'content.deleted'
  | 'content.submit'
  | 'content.reject'
  | 'content.publish'
  | 'content.schedule'
  | 'content.archive'
  | 'content.restore'
  | 'content.rollback'
  | 'school.created'
  | 'school.updated'
  | 'license.created'
  | 'license.updated'
  | 'license.deleted'
  | 'tutor.settings_changed'
  // v0.3.0
  | 'tutor.regression_run'
  | 'content.schedule_cancelled'
  | 'review.comment_created'
  | 'review.comment_updated'
  | 'asset.uploaded'
  | 'asset.version_created'
  | 'asset.deleted'
  | 'invite.revoked'
  | 'invite.resent'
  | 'student.data_reveal'
  | 'auth.2fa_enrollment_started'
  // v0.4.0: review of AI-generated examples and questions
  | 'generated.new'
  | 'generated.approved'
  | 'generated.dismissed'
  | 'generated.promoted'
  // v0.5.0: КТП → lesson plans
  | 'ktp.created'
  | 'ktp.deleted'
  // v0.9.3: the book library
  | 'book.created'
  | 'book.processing'
  | 'book.updated'
  | 'book.published'
  | 'book.archived'
  // v0.6.0: teachers register themselves
  | 'auth.self_registered'
  // v0.8.0: staff, support, teacher data, deletion requests, exports
  | 'auth.login_denied'
  | 'staff.invited'
  | 'staff.invite_accepted'
  | 'staff.updated'
  | 'staff.permissions_changed'
  | 'staff.blocked'
  | 'staff.restored'
  | 'staff.deleted'
  | 'support.started'
  | 'support.ended'
  | 'support.request'
  | 'support.denied'
  | 'teacher.viewed'
  | 'teacher.deleted'
  | 'profile.updated'
  | 'class.created'
  | 'class.updated'
  | 'license.trial_extended'
  | 'ktp.updated'
  | 'deletion.requested'
  | 'deletion.approved'
  | 'deletion.rejected'
  | 'deletion.failed'
  | 'export.journal_csv'
  | 'journal.verified';

export interface AuditOpts {
  /** Legacy free-form details (also split into before / after when it has those keys). */
  diff?: unknown;
  ip?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  result?: AuditResult;
  group?: AuditGroup;
  /** Explicit «on behalf of» (otherwise taken from a support session). */
  onBehalfOf?: string | null;
  supportSessionId?: string | null;
}

/** Mass deletion: this many deletions by one actor within the window raise an alert. */
export const MASS_DELETION_COUNT = 10;
export const MASS_DELETION_WINDOW_MS = 10 * 60_000;

export class AuditService {
  constructor(private repo: Repository, private clock: Clock) {}

  async log(actorId: string | null, action: AuditAction, target: { type: string; id: string; label?: string | null }, opts: AuditOpts = {}): Promise<string> {
    const ctx = currentRequest();
    const support = ctx?.auth?.support ?? null;
    let actor = actorId;
    let onBehalfOf = opts.onBehalfOf ?? null;
    let supportSessionId = opts.supportSessionId ?? null;
    if (support) {
      supportSessionId ??= support.session.id;
      // Inside a support session the teacher's own actions are the staff member's.
      if (actorId === support.session.teacherId) {
        actor = support.session.actorId;
        onBehalfOf ??= support.session.teacherId;
      }
    }
    let actorRole: string | null = null;
    if (actor) {
      if (support && actor === support.session.actorId) actorRole = primaryRole(support.actorGrants);
      else if (ctx?.auth?.user?.id === actor) actorRole = primaryRole(ctx.auth.grants);
      else actorRole = primaryRole(await this.repo.listGrants(actor));
    }
    const diff = opts.diff === undefined ? null : sanitize(opts.diff);
    const obj = diff && typeof diff === 'object' && !Array.isArray(diff) ? (diff as Record<string, unknown>) : null;
    const id = newId();
    const at = this.clock.now();
    await this.repo.appendJournal({
      id,
      at,
      actorId: actor,
      actorRole,
      onBehalfOfId: onBehalfOf,
      group: opts.group ?? groupOf(action),
      action,
      targetType: target.type,
      targetId: target.id,
      targetLabel: target.label ?? null,
      before: opts.before !== undefined ? sanitize(opts.before) : obj && 'before' in obj ? obj.before : null,
      after: opts.after !== undefined ? sanitize(opts.after) : obj && 'after' in obj ? obj.after : null,
      details: diff,
      reason: opts.reason ?? null,
      result: opts.result ?? (action === 'auth.login_failed' ? 'failed' : action === 'auth.login_denied' ? 'denied' : 'ok'),
      ip: opts.ip ?? ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      requestId: ctx?.requestId ?? null,
      supportSessionId,
    });
    if (actor && action.endsWith('.deleted')) await this.checkMassDeletion(actor, at);
    return id;
  }

  /** Raise an alert once per key (repeats are ignored). */
  async alert(kind: AuditAlertKind, key: string, actorId: string | null, summary: string): Promise<void> {
    await this.repo.createAlert({ id: newId(), key, at: this.clock.now(), kind, actorId, summary, seenAt: null });
  }

  private async checkMassDeletion(actorId: string, at: Date) {
    const from = new Date(at.getTime() - MASS_DELETION_WINDOW_MS);
    const recent = await this.repo.listJournal({ actorId, actionSuffix: '.deleted', from }, { limit: MASS_DELETION_COUNT });
    if (recent.items.length < MASS_DELETION_COUNT) return;
    const bucket = Math.floor(at.getTime() / MASS_DELETION_WINDOW_MS);
    await this.alert('mass_deletion', `mass_deletion:${actorId}:${bucket}`, actorId, `${MASS_DELETION_COUNT}+ deletions within 10 minutes`);
  }
}
