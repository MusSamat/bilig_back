/**
 * Contract 0.8.0 §3: teachers (teacher.view) and support sessions — a staff
 * member opens a chosen teacher's cabinet. View needs teacher.view; edit needs
 * teacher.edit, a reason (≥ 10 characters) and the staff member's TOTP again.
 * The response carries a client-audience access token (sub = the teacher,
 * act = the staff member, 15 / 30 min, no refresh). A staff account is never
 * opened. Start and end are journaled with both ids; edit mode raises an alert.
 */
import type { FastifyInstance } from 'fastify';
import type { SupportStartRequest, TeacherListQuery, TeacherSummary } from '@bilig/content-model/api';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { decodeCursor, encodeCursor } from '../../repo/paging.js';
import type { GrantRec, SupportSessionRec, UserRec } from '../../repo/types.js';
import { taughtClasses, teacherProfile } from '../../services/profile.js';
import { isStaff, primaryRole, verifyStaffTotp } from '../../services/staff.js';
import { endSupport, SUPPORT_TTL_MS } from '../../services/support.js';
import { iso, reg, type AnyCtx } from './util.js';

export function registerSupportAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit, jwt } = deps;

  async function summary(u: UserRec, grants: GrantRec[]): Promise<TeacherSummary> {
    const schoolIds = [...new Set(grants.filter((g) => g.role === 'teacher' && g.scope === 'school' && g.scopeId).map((g) => g.scopeId!))];
    const school = schoolIds.length ? await repo.getSchool(schoolIds[0]) : null;
    const classes = await taughtClasses(repo, u.id);
    const profile = await teacherProfile(repo, u, grants);
    return {
      id: u.id,
      displayName: u.displayName,
      phone: u.phone ?? null,
      email: u.email,
      schoolName: school?.name ?? '',
      region: school?.region ?? '',
      teachingLang: u.teachingLang ?? null,
      classes: classes.length,
      subjects: [...new Set(classes.flatMap((c) => c.subjectKeys ?? (c.subjectKey ? [c.subjectKey] : [])))].sort(),
      profileStatus: profile?.profileStatus ?? 'incomplete',
      status: u.deletedAt ? 'deleted' : u.status === 'blocked' ? 'blocked' : 'active',
      createdAt: iso(u.createdAt),
      lastActiveAt: u.lastLoginAt ? iso(u.lastLoginAt) : null,
    };
  }

  /** A teacher (teacher grant, not staff), deleted ones included; 404 otherwise. */
  async function loadTeacher(id: string): Promise<{ user: UserRec; grants: GrantRec[] }> {
    const user = await repo.getUser(id);
    const grants = user ? await repo.listGrants(user.id) : [];
    if (!user || user.kind !== 'adult' || !grants.some((g) => g.role === 'teacher')) fail('not_found', { detail: 'teacher' });
    // A staff account is never shown or opened as a teacher.
    if (isStaff(grants)) fail('forbidden', { detail: 'staff_account' });
    return { user: user!, grants };
  }

  const digits = (s: string) => s.replace(/\D/g, '');

  reg(app, deps, 'teacherList', async (ctx) => {
    const q = ctx.query as TeacherListQuery;
    const limit = Math.min(100, q.limit ?? 50);
    const after = decodeCursor(q.cursor);
    const needle = q.q?.toLocaleLowerCase();
    const needleDigits = needle ? digits(needle) : '';
    const ids = (await repo.listUserIdsByRole('teacher')).sort().reverse(); // newest first (UUID v7)
    const items: TeacherSummary[] = [];
    let more = false;
    for (const id of ids) {
      if (after !== undefined && id >= after) continue;
      const user = (await repo.getUsers([id]))[0];
      if (!user || user.kind !== 'adult') continue;
      const grants = await repo.listGrants(id);
      if (isStaff(grants)) continue;
      const s = await summary(user, grants);
      if (q.status && s.status !== q.status) continue;
      if (q.profileStatus && s.profileStatus !== q.profileStatus) continue;
      if (
        needle &&
        !(
          s.displayName.toLocaleLowerCase().includes(needle) ||
          (s.email ?? '').includes(needle) ||
          s.schoolName.toLocaleLowerCase().includes(needle) ||
          (needleDigits.length >= 3 && !!s.phone && digits(s.phone).includes(needleDigits))
        )
      )
        continue;
      if (items.length === limit) {
        more = true;
        break;
      }
      items.push(s);
    }
    return { items, nextCursor: more && items.length ? encodeCursor(items[items.length - 1].id) : null };
  });

  reg(app, deps, 'teacherGet', async (ctx) => {
    const { user, grants } = await loadTeacher(ctx.params.id);
    await audit.log(ctx.auth.user!.id, 'teacher.viewed', { type: 'user', id: user.id, label: user.displayName }, { ip: ctx.ip });
    return summary(user, grants);
  });

  const toSession = (s: SupportSessionRec, teacher: UserRec, actor: UserRec, actorGrants: GrantRec[]) => ({
    id: s.id,
    mode: s.mode,
    teacher: { id: teacher.id, displayName: teacher.displayName },
    actor: { id: actor.id, displayName: actor.displayName, role: primaryRole(actorGrants) === 'superadmin' ? ('superadmin' as const) : ('manager' as const) },
    reason: s.reason,
    startedAt: iso(s.startedAt),
    expiresAt: iso(s.expiresAt),
    endedAt: s.endedAt ? iso(s.endedAt) : null,
  });

  reg(app, deps, 'supportStart', async (ctx: AnyCtx) => {
    const b = ctx.body as SupportStartRequest;
    const actor = ctx.auth.user!;
    if (!isStaff(ctx.auth.grants)) fail('forbidden', { detail: 'staff_only' });
    if (b.mode === 'edit') {
      ctx.authorize('teacher.edit');
      await verifyStaffTotp(deps, actor.id, b.totp);
    }
    const { user: teacher } = await loadTeacher(ctx.params.id);
    if (teacher.deletedAt || teacher.status !== 'active') fail('conflict', { detail: 'teacher_inactive' });
    const now = clock.now();
    const ttl = SUPPORT_TTL_MS[b.mode];
    const s: SupportSessionRec = {
      id: newId(),
      actorId: actor.id,
      teacherId: teacher.id,
      mode: b.mode,
      reason: b.reason?.trim() || null,
      ip: ctx.ip,
      startedAt: now,
      expiresAt: new Date(now.getTime() + ttl),
      endedAt: null,
      endedBy: null,
      endReason: null,
    };
    await repo.createSupportSession(s);
    const accessToken = await jwt.sign({ sub: teacher.id, sid: s.id, aud: 'client', kind: 'adult', act: actor.id, mode: b.mode }, now, ttl / 1000);
    await audit.log(actor.id, 'support.started', { type: 'user', id: teacher.id, label: teacher.displayName }, {
      ip: ctx.ip,
      onBehalfOf: teacher.id,
      supportSessionId: s.id,
      reason: s.reason,
      after: { mode: s.mode, expiresAt: iso(s.expiresAt) },
    });
    if (b.mode === 'edit') await audit.alert('support_edit', `support_edit:${s.id}`, actor.id, `Edit-mode support session in the cabinet of ${teacher.displayName}: ${s.reason ?? ''}`.slice(0, 500));
    return { session: toSession(s, teacher, actor, ctx.auth.grants), accessToken, tokenType: 'Bearer' as const, expiresIn: ttl / 1000 };
  });

  // «Выйти в админку»: with the support token itself, or the staff member's admin token (SuperAdmin: any session).
  reg(app, deps, 'supportEnd', async (ctx) => {
    const s = await repo.getSupportSession(ctx.params.sessionId);
    if (!s) fail('not_found', { detail: 'support_session' });
    const sp = ctx.auth.support;
    const caller = sp ? sp.actor.id : ctx.auth.user!.id;
    const allowed = sp ? sp.session.id === s.id : ctx.auth.aud === 'admin' && (caller === s.actorId || ctx.auth.grants.some((g) => g.role === 'superadmin'));
    if (!allowed) fail('not_found', { detail: 'support_session' });
    if (!s.endedAt) await endSupport(deps, s, caller, s.expiresAt <= clock.now() ? 'expired' : 'ended');
    return { ok: true as const };
  });
}
