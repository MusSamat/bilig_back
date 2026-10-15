/** Append-only audit log (TZ §6, A-19): logins, role changes, publishes, student-data access. */
import { newId } from '../ids.js';
import type { Repository } from '../repo/types.js';
import type { Clock } from './clock.js';

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
  | 'auth.2fa_enrollment_started';

export class AuditService {
  constructor(private repo: Repository, private clock: Clock) {}
  async log(
    actorId: string | null,
    action: AuditAction,
    target: { type: string; id: string },
    opts: { diff?: unknown; ip?: string | null } = {},
  ): Promise<string> {
    const id = newId();
    await this.repo.appendAudit({
      id,
      actorId,
      action,
      targetType: target.type,
      targetId: target.id,
      diff: opts.diff ?? null,
      ip: opts.ip ?? null,
      ts: this.clock.now(),
    });
    return id;
  }
}
