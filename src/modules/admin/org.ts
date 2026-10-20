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
import { pageArray, pageOf, sortedPage, type SortValue } from '../../repo/paging.js';
import type { GrantRec, InviteRec, LicenseRec, SchoolRec, UserRec } from '../../repo/types.js';
import { adminSchools, iso, isSuperadmin, optionalVersion, reg, type AnyCtx } from './util.js';
import { STAFF_ROLES, assertNotSelf, assertSuperadminFloor } from '../../services/staff.js';

type Order = 'asc' | 'desc';
interface SortQ {
  sort?: string;
  order?: Order;
  cursor?: string;
  limit?: number;
}

const toSchool = (s: SchoolRec) => ({ id: s.id, name: s.name, region: s.region, type: s.type, language: s.language, status: s.status, version: s.version });
const toLicense = (l: LicenseRec) => ({ id: l.id, schoolId: l.schoolId, subjects: l.subjects, grades: l.grades, seats: l.seats, startsAt: iso(l.startsAt), endsAt: iso(l.endsAt), version: l.version });
export const inviteStatus = (i: InviteRec, now: Date) =>
  i.acceptedAt ? ('accepted' as const) : i.revokedAt ? ('revoked' as const) : i.expiresAt <= now ? ('expired' as const) : ('pending' as const);
const toInvite = (i: InviteRec, now: Date) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  scope: i.scope,
  ...(i.scopeId ? { scopeId: i.scopeId } : {}),
  expiresAt: iso(i.expiresAt),
  ...(i.acceptedAt ? { acceptedAt: iso(i.acceptedAt) } : {}),
  ...(i.revokedAt ? { revokedAt: iso(i.revokedAt) } : {}),
  createdAt: iso(i.createdAt),
  invitedBy: i.invitedBy,
  status: inviteStatus(i, now),
});

/** Legacy id-ordered page, or (v0.3.0) a sorted page when `sort`/`order` is given. */
function pageBy<T extends { id: string }>(rows: T[], q: SortQ, value: (t: T, sort: string) => SortValue) {
  if (!q.sort && q.order !== 'desc') return pageArray([...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), pageOf(q), (r) => r.id);
  const sort = q.sort ?? 'createdAt';
  return sortedPage(rows, { value: (t) => value(t, sort), tie: (t) => t.id, order: q.order }, pageOf(q));
}

const pseudonym = (u: UserRec) => `Ученик #${u.id.slice(-6)}`;

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
      displayName: reveal ? u.displayName : pseudonym(u),
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
    const q = ctx.query as SortQ & { q?: string; region?: string; status?: SchoolRec['status'] };
    const scope = isSuperadmin(ctx) ? {} : { ids: adminSchools(ctx) };
    if (!q.sort && q.order !== 'desc' && !q.q && !q.region && !q.status) {
      const res = await repo.listSchools(scope, pageOf(q));
      return { items: res.items.map(toSchool), nextCursor: res.nextCursor };
    }
    const needle = q.q?.toLocaleLowerCase();
    const rows = (await repo.listSchools(scope, { limit: 100_000 })).items.filter(
      (s) => (!needle || s.name.toLocaleLowerCase().includes(needle) || s.region.toLocaleLowerCase().includes(needle)) && (!q.region || s.region === q.region) && (!q.status || s.status === q.status),
    );
    const res = pageBy(rows, q, (s, f) => (f === 'createdAt' ? iso(s.createdAt) : (s as unknown as Record<string, SortValue>)[f]));
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
    const expected = optionalVersion(ctx);
    const { version: _v, ...patch } = ctx.body as Partial<SchoolRec>;
    const s = await repo.updateSchool(ctx.params.id, patch, expected);
    if (!s) fail('not_found', { detail: 'school' });
    if (s === 'version_mismatch') fail('version_mismatch');
    await audit.log(ctx.auth.user!.id, 'school.updated', { type: 'school', id: s.id }, { ip: ctx.ip, diff: ctx.body });
    return toSchool(s);
  });

  // --- licences --------------------------------------------------------------------
  reg(app, deps, 'adminLicenseList', async (ctx) => {
    const q = ctx.query as SortQ & { schoolId?: string; active?: boolean };
    let schoolIds = isSuperadmin(ctx) ? undefined : adminSchools(ctx);
    if (q.schoolId) {
      if (schoolIds && !schoolIds.includes(q.schoolId)) fail('forbidden');
      schoolIds = [q.schoolId];
    }
    if (!q.sort && q.order !== 'desc' && q.active === undefined) {
      const res = await repo.listLicenses(schoolIds ? { schoolIds } : {}, pageOf(q));
      return { items: res.items.map(toLicense), nextCursor: res.nextCursor };
    }
    const now = clock.now();
    const rows = (await repo.listLicenses(schoolIds ? { schoolIds } : {}, { limit: 100_000 })).items.filter(
      (l) => q.active === undefined || q.active === (l.startsAt <= now && now < l.endsAt),
    );
    const res = pageBy(rows, q, (l, f) => (f === 'startsAt' || f === 'endsAt' ? iso(l[f]) : f === 'createdAt' ? l.id : (l as unknown as Record<string, SortValue>)[f]));
    return { items: res.items.map(toLicense), nextCursor: res.nextCursor };
  });
  reg(app, deps, 'adminLicenseCreate', async (ctx) => {
    const { version: _v, ...b } = ctx.body as { id: string; schoolId: string; subjects: string[]; grades: number[]; seats: number; startsAt: string; endsAt: string; version?: number };
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
    const expected = optionalVersion(ctx);
    const { version: _v, ...b } = ctx.body as Partial<{ subjects: string[]; grades: number[]; seats: number; startsAt: string; endsAt: string; version: number }>;
    if (expected !== null && expected !== cur.version) fail('version_mismatch');
    const patch = {
      ...b,
      ...(b.startsAt ? { startsAt: new Date(b.startsAt) } : {}),
      ...(b.endsAt ? { endsAt: new Date(b.endsAt) } : {}),
    } as Partial<LicenseRec>;
    const start = patch.startsAt ?? cur.startsAt;
    const end = patch.endsAt ?? cur.endsAt;
    if (end <= start) fail('validation_failed', { detail: 'endsAt must be after startsAt' });
    const l = await repo.updateLicense(cur.id, patch, expected);
    if (!l) fail('not_found', { detail: 'license' });
    if (l === 'version_mismatch') fail('version_mismatch');
    deps.content.invalidate();
    await audit.log(ctx.auth.user!.id, 'license.updated', { type: 'license', id: cur.id }, { ip: ctx.ip, diff: b });
    return toLicense(l);
  });
  reg(app, deps, 'adminLicenseDelete', async (ctx) => {
    const r = await repo.deleteLicense(ctx.params.id, optionalVersion(ctx));
    if (r === 'version_mismatch') fail('version_mismatch');
    if (!r) fail('not_found', { detail: 'license' });
    await audit.log(ctx.auth.user!.id, 'license.deleted', { type: 'license', id: ctx.params.id }, { ip: ctx.ip });
    return { ok: true as const };
  });

  // --- users -------------------------------------------------------------------------
  reg(app, deps, 'adminUsers', async (ctx) => {
    const q = ctx.query as SortQ & { q?: string; schoolId?: string; role?: string; status?: 'active' | 'blocked' | 'invited' };
    const vis = await visibleUserIds(ctx, q.schoolId);
    const status = q.status === 'invited' ? undefined : q.status;
    let users = (await repo.listUsers({ q: q.q, ...(vis ? { ids: [...vis] } : {}), ...(status ? { status } : {}) }, { limit: 1_000_000 })).items;
    if (q.status === 'invited') users = users.filter((u) => u.status === 'invited' || u.status === 'pending');
    if (q.role) {
      const keep: UserRec[] = [];
      for (const u of users) if ((await repo.listGrants(u.id)).some((g) => g.role === q.role)) keep.push(u);
      users = keep;
    }
    const mine = await scopeSchoolUsers(ctx);
    // Pupils sort by their pseudonym unless the viewer may see the name (no leak through ordering).
    const visibleName = (u: UserRec) => (u.kind !== 'student' || (!!mine && mine.has(u.id) && !isSuperadmin(ctx)) ? u.displayName : `Ученик #${u.id.slice(-6)}`);
    const page = pageBy(users, q, (u, f) => (f === 'createdAt' ? iso(u.createdAt) : f === 'displayName' ? visibleName(u) : f === 'status' ? (u.status === 'pending' ? 'invited' : u.status) : (u as unknown as Record<string, SortValue>)[f]));
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
    if (grants.some((g) => g.role === 'superadmin' || g.role === 'manager' || ((g.role === 'author' || g.role === 'editor') && !grants.some((x) => controls(schools, x)))))
      fail('forbidden', { detail: 'outside_scope' });
  }

  reg(app, deps, 'adminUserPatch', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    await assertManageable(ctx, u);
    const b = ctx.body as { status?: 'active' | 'blocked'; displayName?: string };
    // v0.8.0: nobody changes their own status; never below two active SuperAdmins.
    if (b.status && b.status !== u.status) {
      assertNotSelf(ctx.auth.user!.id, u.id);
      if (b.status === 'blocked') await assertSuperadminFloor(repo, u.id);
    }
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
    // v0.8.0: no one changes their own role; never below two active SuperAdmins; no shared staff/teacher accounts.
    if (added.length || removed.length) assertNotSelf(ctx.auth.user!.id, u.id);
    if (removed.some((g) => g.role === 'superadmin') && !next.some((g) => g.role === 'superadmin')) await assertSuperadminFloor(repo, u.id);
    if (next.some((g) => STAFF_ROLES.has(g.role)) && next.some((g) => g.role === 'teacher' || g.role === 'school_admin' || g.role === 'student'))
      fail('validation_failed', { detail: 'staff_and_teacher', issues: [{ path: ['grants'], message: 'A staff account cannot also be a teacher or school admin' }] });
    if (added.some((g) => g.role === 'manager') && !(await repo.getStaffProfile(u.id))) {
      await repo.putStaffProfile({ userId: u.id, permissions: [], scope: null, createdBy: ctx.auth.user!.id, createdAt: clock.now(), blockedAt: null, deletedAt: null });
    }
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
    const q = ctx.query as SortQ & { status?: ReturnType<typeof inviteStatus>; q?: string };
    const scope = isSuperadmin(ctx) ? {} : { scope: 'school' as const, scopeIds: adminSchools(ctx) };
    const now = clock.now();
    if (!q.sort && q.order !== 'desc' && !q.status && !q.q) {
      const res = await repo.listInvites(scope, pageOf(q));
      return { items: res.items.map((i) => toInvite(i, now)), nextCursor: res.nextCursor };
    }
    const needle = q.q?.toLocaleLowerCase();
    const rows = (await repo.listInvites(scope, { limit: 100_000 })).items.filter((i) => (!q.status || inviteStatus(i, now) === q.status) && (!needle || i.email.includes(needle)));
    const res = pageBy(rows, q, (i, f) => (f === 'expiresAt' || f === 'createdAt' || f === 'acceptedAt' ? (i[f] ? iso(i[f]!) : undefined) : (i as unknown as Record<string, SortValue>)[f]));
    return { items: res.items.map((i) => toInvite(i, now)), nextCursor: res.nextCursor };
  });

  /** Who may manage an existing invite: the same rule as creating it. */
  function authorizeInvite(ctx: AnyCtx, inv: InviteRec) {
    if (controls(adminSchools(ctx), inv)) ctx.authorize('school.teachers.manage', { schoolId: inv.scopeId! });
    else ctx.authorize('platform.manage');
  }
  async function loadInvite(ctx: AnyCtx): Promise<InviteRec> {
    const inv = await repo.getInvite(ctx.params.id);
    if (!inv) fail('not_found', { detail: 'invite' });
    if (!isSuperadmin(ctx) && !controls(adminSchools(ctx), inv)) fail('not_found', { detail: 'invite' });
    authorizeInvite(ctx, inv);
    return inv;
  }

  // v0.3.0: revoke (the link stops working) and resend (new link, new 7-day expiry).
  reg(app, deps, 'adminInviteRevoke', async (ctx) => {
    const inv = await loadInvite(ctx);
    if (inv.acceptedAt) fail('conflict', { detail: 'invite_accepted' });
    if (!inv.revokedAt) await repo.updateInvite(inv.id, { revokedAt: clock.now() });
    await audit.log(ctx.auth.user!.id, 'invite.revoked', { type: 'invite', id: inv.id }, { ip: ctx.ip, diff: { email: inv.email } });
    return { ok: true as const };
  });

  reg(app, deps, 'adminInviteResend', async (ctx) => {
    const inv = await loadInvite(ctx);
    if (inv.acceptedAt) fail('conflict', { detail: 'invite_accepted' });
    const token = randomToken();
    const now = clock.now();
    const next = await repo.updateInvite(inv.id, { tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS), revokedAt: null });
    await sendInvite(next!, token);
    await audit.log(ctx.auth.user!.id, 'invite.resent', { type: 'invite', id: inv.id }, { ip: ctx.ip, diff: { email: inv.email } });
    return toInvite(next!, now);
  });

  async function sendInvite(inv: InviteRec, token: string) {
    const link = `${config.appUrl}/invite?token=${token}`;
    await mailer.send({ to: inv.email, kind: 'invite', link, subject: 'Bilig: приглашение', text: `Вас пригласили в Bilig. Ссылка действует 7 дней:\n${link}` });
  }

  // v0.3.0: audited access to a pupil's real name «с основанием» (A-16). Superadmin only.
  reg(app, deps, 'adminUserReveal', async (ctx) => {
    const u = await loadUser(ctx, ctx.params.id);
    if (u.kind !== 'student') fail('validation_failed', { detail: 'students only' });
    const b = ctx.body as { ground: string; reason: string; reference?: string };
    const enr = await repo.listEnrollments({ userId: u.id, role: 'student' });
    const classes = (await repo.listClasses({ ids: enr.map((e) => e.classId) }, { limit: 100 })).items;
    const schools = new Map((await repo.listSchools({ ids: [...new Set(classes.map((c) => c.schoolId))] }, { limit: 100 })).items.map((s) => [s.id, s.name]));
    const auditId = await audit.log(ctx.auth.user!.id, 'student.data_reveal', { type: 'user', id: u.id }, {
      ip: ctx.ip,
      diff: { ground: b.ground, reason: b.reason, ...(b.reference ? { reference: b.reference } : {}), fields: ['displayName', 'classes'] },
    });
    return {
      userId: u.id,
      displayName: u.displayName,
      classes: classes.map((c) => ({ classId: c.id, className: c.name, schoolId: c.schoolId, ...(schools.get(c.schoolId) ? { schoolName: schools.get(c.schoolId)! } : {}) })),
      revealedAt: iso(clock.now()),
      auditId,
    };
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
      revokedAt: null,
    };
    await repo.createInvite(inv);
    await sendInvite(inv, token);
    await audit.log(ctx.auth.user!.id, 'invite.created', { type: 'invite', id: inv.id }, { ip: ctx.ip, diff: { role: inv.role, scope: inv.scope, scopeId: inv.scopeId } });
    return { ok: true as const };
  });
}
