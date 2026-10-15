/**
 * Admin: schools, licences, users, role grants, invites (A-15, A-16).
 *
 * Scope: a school admin sees and manages only their own school(s): users
 * granted there or enrolled in its classes, teacher/school_admin grants with
 * that school as scope, and invites for it. Everything else needs
 * `platform.manage` (superadmin). Student names are pseudonymised for anyone
 * without a school scope over the student (A-16: the superadmin sees pupils
 * only de-identified).
 */
import type { FastifyInstance } from 'fastify';
import { isValidGrant, type RoleGrant } from '@bilig/permissions';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { toRoleGrant } from '../../http/auth-context.js';
import { newId } from '../../ids.js';
import { hashToken, randomToken } from '../../domain/crypto.js';
import { INVITE_TTL_MS } from '../auth.js';
import { pageArray, pageOf } from '../../repo/paging.js';
import type { GrantRec, InviteRec, LicenseRec, SchoolRec, UserRec } from '../../repo/types.js';
import { adminSchools, iso, isSuperadmin, reg, type AnyCtx } from './util.js';

const toSchool = (s: SchoolRec) => ({ id: s.id, name: s.name, region: s.region, type: s.type, language: s.language, status: s.status });
const toLicense = (l: LicenseRec) => ({ id: l.id, schoolId: l.schoolId, subjects: l.subjects, grades: l.grades, seats: l.seats, startsAt: iso(l.startsAt), endsAt: iso(l.endsAt) });
const toInvite = (i: InviteRec) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  scope: i.scope,
  ...(i.scopeId ? { scopeId: i.scopeId } : {}),
  expiresAt: iso(i.expiresAt),
  ...(i.acceptedAt ? { acceptedAt: iso(i.acceptedAt) } : {}),
});

/** Grants a school admin controls: teacher / school_admin on one of their schools. */
const controls = (schools: string[], g: Pick<GrantRec, 'role' | 'scope' | 'scopeId'>) =>
  (g.role === 'teacher' || g.role === 'school_admin') && g.scope === 'school' && !!g.scopeId && schools.includes(g.scopeId);

export function registerOrgAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit, mailer, config } = deps;

  /** Users belonging to a school: granted on it or enrolled in one of its classes. */
  async function schoolUserIds(schoolId: string): Promise<Set<string>> {
    const ids = new Set((await repo.listGrantsByScope('school', schoolId)).map((g) => g.userId));
    const classes = (await repo.listClasses({ schoolIds: [schoolId] }, { limit: 100_000 })).items.map((c) => c.id);
    if (classes.length) (await repo.listEnrollments({ classIds: classes })).forEach((e) => ids.add(e.userId));
    return ids;
  }
  async function visibleUserIds(ctx: AnyCtx, schoolId?: string): Promise<Set<string> | null> {
    if (isSuperadmin(ctx)) return schoolId ? schoolUserIds(schoolId) : null; // null = everyone
    const mine = adminSchools(ctx);
    const schools = schoolId ? mine.filter((s) => s === schoolId) : mine;
    if (schoolId && !schools.length) fail('forbidden');
    const out = new Set<string>();
    for (const s of schools) (await schoolUserIds(s)).forEach((id) => out.add(id));
    return out;
  }
  async function loadUser(ctx: AnyCtx, id: string): Promise<UserRec> {
    const u = await repo.getUser(id);
    if (!u || u.deletedAt) fail('not_found', { detail: 'user' });
    const vis = await visibleUserIds(ctx);
    if (vis && !vis.has(u.id)) fail('not_found', { detail: 'user' });
    return u;
  }
  async function toAdminUser(ctx: AnyCtx, u: UserRec, mySchoolUsers: Set<string> | null) {
    const grants = await repo.listGrants(u.id);
    // Pseudonymise pupils unless the viewer is a school admin of the pupil's school (A-16).
    const reveal = u.kind !== 'student' || (!!mySchoolUsers && mySchoolUsers.has(u.id) && !isSuperadmin(ctx));
    return {
      id: u.id,
      kind: u.kind,
      displayName: reveal ? u.displayName : `Ученик #${u.id.slice(-6)}`,
      ...(u.email ? { email: u.email } : {}),
      status: u.status === 'active' ? ('active' as const) : u.status === 'blocked' ? ('blocked' as const) : ('invited' as const),
      grants: grants.map(toRoleGrant),
    };
  }
  async function scopeSchoolUsers(ctx: AnyCtx) {
    if (isSuperadmin(ctx)) return null;
    return visibleUserIds(ctx);
  }

  // --- schools -------------------------------------------------------------------
  reg(app, deps, 'adminSchoolList', async (ctx) => {
    const page = pageOf(ctx.query as { cursor?: string; limit?: number });
    const res = await repo.listSchools(isSuperadmin(ctx) ? {} : { ids: adminSchools(ctx) }, page);
    return { items: res.items.map(toSchool), nextCursor: res.nextCursor };
  });
  reg(app, deps, 'adminSchoolGet', async (ctx) => {
    ctx.authorize('school.teachers.manage', { schoolId: ctx.params.id });
    const s = await repo.getSchool(ctx.params.id);
    if (!s) fail('not_found', { detail: 'school' });
    return toSchool(s);
  });
  reg(app, deps, 'adminSchoolCreate', async (ctx) => {
    const s: SchoolRec = { id: newId(), ...(ctx.body as Omit<SchoolRec, 'id' | 'createdAt'>), createdAt: clock.now() };
    await repo.createSchool(s);
    await audit.log(ctx.auth.user!.id, 'school.created', { type: 'school', id: s.id }, { ip: ctx.ip, diff: { name: s.name } });
    return toSchool(s);
  });
  reg(app, deps, 'adminSchoolPatch', async (ctx) => {
    const s = await repo.updateSchool(ctx.params.id, ctx.body as Partial<SchoolRec>);
    if (!s) fail('not_found', { detail: 'school' });
    await audit.log(ctx.auth.user!.id, 'school.updated', { type: 'school', id: s.id }, { ip: ctx.ip, diff: ctx.body });
    return toSchool(s);
  });

  // --- licences --------------------------------------------------------------------
  reg(app, deps, 'adminLicenseList', async (ctx) => {
    const q = ctx.query as { schoolId?: string; cursor?: string; limit?: number };
    let schoolIds = isSuperadmin(ctx) ? undefined : adminSchools(ctx);
    if (q.schoolId) {
      if (schoolIds && !schoolIds.includes(q.schoolId)) fail('forbidden');
      schoolIds = [q.schoolId];
    }
    const res = await repo.listLicenses(schoolIds ? { schoolIds } : {}, pageOf(q));
    return { items: res.items.map(toLicense), nextCursor: res.nextCursor };
  });
  reg(app, deps, 'adminLicenseCreate', async (ctx) => {
    const b = ctx.body as { id: string; schoolId: string; subjects: string[]; grades: number[]; seats: number; startsAt: string; endsAt: string };
    if (!(await repo.getSchool(b.schoolId))) fail('not_found', { detail: 'school' });
    const created = await repo.createLicense({ ...b, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt) });
    if (created === 'conflict') fail('conflict', { detail: 'license exists' });
    deps.content.invalidate();
    await audit.log(ctx.auth.user!.id, 'license.created', { type: 'license', id: created.id }, { ip: ctx.ip, diff: b });
    return toLicense(created);
  });
  reg(app, deps, 'adminLicensePatch', async (ctx) => {
    const cur = await repo.getLicense(ctx.params.id);
    if (!cur) fail('not_found', { detail: 'license' });
    const b = ctx.body as Partial<{ subjects: string[]; grades: number[]; seats: number; startsAt: string; endsAt: string }>;
    const patch = {
      ...b,
      ...(b.startsAt ? { startsAt: new Date(b.startsAt) } : {}),
      ...(b.endsAt ? { endsAt: new Date(b.endsAt) } : {}),
    } as Partial<LicenseRec>;
    const start = patch.startsAt ?? cur.startsAt;
    const end = patch.endsAt ?? cur.endsAt;
    if (end <= start) fail('validation_failed', { detail: 'endsAt must be after startsAt' });
    const l = await repo.updateLicense(cur.id, patch);
    await audit.log(ctx.auth.user!.id, 'license.updated', { type: 'license', id: cur.id }, { ip: ctx.ip, diff: b });
    return toLicense(l!);
  });
  reg(app, deps, 'adminLicenseDelete', async (ctx) => {
    if (!(await repo.deleteLicense(ctx.params.id))) fail('not_found', { detail: 'license' });
    await audit.log(ctx.auth.user!.id, 'license.deleted', { type: 'license', id: ctx.params.id }, { ip: ctx.ip });
    return { ok: true as const };
  });

  // --- users -------------------------------------------------------------------------
  reg(app, deps, 'adminUsers', async (ctx) => {
    const q = ctx.query as { q?: string; schoolId?: string; role?: string; status?: 'active' | 'blocked' | 'invited'; cursor?: string; limit?: number };
    const vis = await visibleUserIds(ctx, q.schoolId);
    const status = q.status === 'invited' ? undefined : q.status;
    let users = (await repo.listUsers({ q: q.q, ...(vis ? { ids: [...vis] } : {}), ...(status ? { status } : {}) }, { limit: 1_000_000 })).items;
    if (q.status === 'invited') users = users.filter((u) => u.status === 'invited' || u.status === 'pending');
    if (q.role) {
      const keep: UserRec[] = [];
      for (const u of users) if ((await repo.listGrants(u.id)).some((g) => g.role === q.role)) keep.push(u);
      users = keep;
    }
    const page = pageArray(users, pageOf(q), (u) => u.id);
    const mine = await scopeSchoolUsers(ctx);
    if (page.items.some((u) => u.kind === 'student')) {
      await audit.log(ctx.auth.user!.id, 'student.data_access', { type: 'users', id: q.schoolId ?? 'all' }, { ip: ctx.ip, diff: { count: page.items.filter((u) => u.kind === 'student').length } });
    }
    return { items: await Promise.all(page.items.map((u) => toAdminUser(ctx, u, mine))), nextCursor: page.nextCursor };
  });

  reg(app, deps, 'adminUserGet', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    if (u.kind === 'student') await audit.log(ctx.auth.user!.id, 'student.data_access', { type: 'user', id: u.id }, { ip: ctx.ip });
    return toAdminUser(ctx, u, await scopeSchoolUsers(ctx));
  });

  /** Non-superadmins may not act on users holding grants beyond their own authority. */
  async function assertManageable(ctx: AnyCtx, u: UserRec) {
    if (isSuperadmin(ctx)) return;
    if (u.id === ctx.auth.user!.id) fail('forbidden', { detail: 'self' });
    const schools = adminSchools(ctx);
    const grants = await repo.listGrants(u.id);
    if (grants.some((g) => g.role === 'superadmin' || ((g.role === 'author' || g.role === 'editor') && !grants.some((x) => controls(schools, x)))))
      fail('forbidden', { detail: 'outside_scope' });
  }

  reg(app, deps, 'adminUserPatch', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    await assertManageable(ctx, u);
    const b = ctx.body as { status?: 'active' | 'blocked'; displayName?: string };
    const next = await repo.updateUser(u.id, b);
    if (b.status && b.status !== u.status) {
      if (b.status === 'blocked') await repo.revokeUserSessions(u.id, clock.now());
      await audit.log(ctx.auth.user!.id, 'user.status_changed', { type: 'user', id: u.id }, { ip: ctx.ip, diff: { before: u.status, after: b.status } });
    }
    return toAdminUser(ctx, next!, await scopeSchoolUsers(ctx));
  });

  reg(app, deps, 'adminUserGrants', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    const wanted = (ctx.body as { grants: RoleGrant[] }).grants;
    for (const g of wanted) if (!isValidGrant(g)) fail('validation_failed', { detail: `invalid grant ${g.role}/${g.scope}` });
    const before = await repo.listGrants(u.id);
    const norm = (g: { role: string; scope: string; scopeId?: string | null; subrole?: string | null }) => `${g.role}|${g.scope}|${g.scopeId ?? ''}|${g.subrole ?? ''}`;
    const next = wanted.map((g) => ({ role: g.role, scope: g.scope, scopeId: g.scopeId ?? null, subrole: g.role === 'author' ? (g.subrole ?? null) : null }));
    const beforeKeys = new Set(before.map(norm));
    const nextKeys = new Set(next.map(norm));
    const added = next.filter((g) => !beforeKeys.has(norm(g)));
    const removed = before.filter((g) => !nextKeys.has(norm(g)));
    if (!isSuperadmin(ctx)) {
      if (u.id === ctx.auth.user!.id) fail('forbidden', { detail: 'self' });
      const schools = adminSchools(ctx);
      if (![...added, ...removed].every((g) => controls(schools, g))) fail('forbidden', { detail: 'outside_scope' });
    }
    if (u.kind === 'student' && next.some((g) => g.role !== 'student')) fail('validation_failed', { detail: 'students only hold class grants' });
    for (const g of added) {
      if (g.scope === 'school' && !(await repo.getSchool(g.scopeId!))) fail('not_found', { detail: 'school' });
      if (g.scope === 'subject' && !(await repo.content('subject').get(g.scopeId!))) fail('not_found', { detail: 'subject' });
    }
    await repo.setGrants(u.id, next);
    await audit.log(ctx.auth.user!.id, 'user.grants_changed', { type: 'user', id: u.id }, {
      ip: ctx.ip,
      diff: { before: before.map(toRoleGrant), after: next.map((g) => toRoleGrant({ ...g, userId: u.id })), added: added.length, removed: removed.length },
    });
    return toAdminUser(ctx, u, await scopeSchoolUsers(ctx));
  });

  reg(app, deps, 'adminUserRevokeSessions', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    await assertManageable(ctx, u);
    const n = await repo.revokeUserSessions(u.id, clock.now());
    await audit.log(ctx.auth.user!.id, 'user.sessions_revoked', { type: 'user', id: u.id }, { ip: ctx.ip, diff: { revoked: n } });
    return { ok: true as const };
  });

  reg(app, deps, 'adminUserReset2fa', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    await repo.deleteCredential(u.id, 'totp');
    await repo.revokeUserSessions(u.id, clock.now());
    await audit.log(ctx.auth.user!.id, 'user.2fa_reset', { type: 'user', id: u.id }, { ip: ctx.ip });
    return { ok: true as const };
  });

  reg(app, deps, 'adminUserPasswordReset', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    await assertManageable(ctx, u);
    if (u.kind !== 'adult' || !u.email) fail('validation_failed', { detail: 'adults with e-mail only' });
    await app.sendPasswordReset(u);
    return { ok: true as const };
  });

  // --- invites ---------------------------------------------------------------------------
  reg(app, deps, 'adminInviteList', async (ctx) => {
    const page = pageOf(ctx.query as { cursor?: string; limit?: number });
    const res = await repo.listInvites(isSuperadmin(ctx) ? {} : { scope: 'school', scopeIds: adminSchools(ctx) }, page);
    return { items: res.items.map(toInvite), nextCursor: res.nextCursor };
  });

  reg(app, deps, 'adminInviteCreate', async (ctx) => {
    const b = ctx.body as { email: string; role: GrantRec['role']; scope: GrantRec['scope']; scopeId?: string; subrole?: GrantRec['subrole'] };
    const grant: RoleGrant = { role: b.role, scope: b.scope, ...(b.scopeId ? { scopeId: b.scopeId } : {}), ...(b.subrole ? { subrole: b.subrole } : {}) };
    if (!isValidGrant(grant) || b.role === 'student') fail('validation_failed', { detail: 'invalid role/scope' });
    if (controls(adminSchools(ctx), { role: b.role, scope: b.scope, scopeId: b.scopeId ?? null })) ctx.authorize('school.teachers.manage', { schoolId: b.scopeId });
    else ctx.authorize('platform.manage');
    if (b.scope === 'school' && !(await repo.getSchool(b.scopeId!))) fail('not_found', { detail: 'school' });
    if (b.scope === 'subject' && !(await repo.content('subject').get(b.scopeId!))) fail('not_found', { detail: 'subject' });
    const token = randomToken();
    const now = clock.now();
    const inv: InviteRec = {
      id: newId(),
      email: b.email.toLowerCase(),
      role: b.role,
      scope: b.scope,
      scopeId: b.scopeId ?? null,
      subrole: b.role === 'author' ? (b.subrole ?? null) : null,
      tokenHash: hashToken(token),
      invitedBy: ctx.auth.user!.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      acceptedAt: null,
    };
    await repo.createInvite(inv);
    const link = `${config.appUrl}/invite?token=${token}`;
    await mailer.send({ to: inv.email, kind: 'invite', link, subject: 'Bilig: приглашение', text: `Вас пригласили в Bilig. Ссылка действует 7 дней:\n${link}` });
    await audit.log(ctx.auth.user!.id, 'invite.created', { type: 'invite', id: inv.id }, { ip: ctx.ip, diff: { role: inv.role, scope: inv.scope, scopeId: inv.scopeId } });
    return { ok: true as const };
  });
}
