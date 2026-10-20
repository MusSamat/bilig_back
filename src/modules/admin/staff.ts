/**
 * Contract 0.8.0 §1–2: staff (staff.manage = SuperAdmin). SuperAdmin invites a
 * manager with ticked permissions; the manager accepts the invite (name,
 * password), then enrols TOTP at /admin (mandatory). Permissions can be
 * changed, accounts blocked, restored and soft-deleted (history stays; the
 * account is never purged). Never on yourself; never below two active
 * SuperAdmins once two exist. Every step is journaled with the reason.
 */
import type { FastifyInstance } from 'fastify';
import type { StaffMember } from '@bilig/content-model/api';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { hashToken, randomToken } from '../../domain/crypto.js';
import { INVITE_TTL_MS } from '../auth.js';
import type { GrantRec, StaffProfileRec, UserRec } from '../../repo/types.js';
import { assertNotSelf, assertSuperadminFloor, checkAssignable } from '../../services/staff.js';
import { iso, reg, type AnyCtx } from './util.js';

export function registerStaffAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit, mailer, config } = deps;

  async function toMember(u: UserRec, grants?: GrantRec[], profile?: StaffProfileRec | null): Promise<StaffMember> {
    const gs = grants ?? (await repo.listGrants(u.id));
    const p = profile === undefined ? await repo.getStaffProfile(u.id) : profile;
    const totp = await repo.getCredential(u.id, 'totp');
    const superadmin = gs.some((g) => g.role === 'superadmin');
    const status = p?.deletedAt ? 'deleted' : p?.blockedAt || u.status === 'blocked' || u.deletedAt ? 'blocked' : u.status === 'invited' ? 'invited' : 'active';
    return {
      userId: u.id,
      email: u.email ?? `${u.id}@invalid.bilig.kg`,
      displayName: u.displayName,
      role: superadmin ? 'superadmin' : 'manager',
      permissions: superadmin ? [] : (p?.permissions ?? []),
      status,
      totpEnabled: !!totp && !totp.secretHash.startsWith('pending:'),
      createdAt: iso(p?.createdAt ?? u.createdAt),
      createdBy: p?.createdBy ?? null,
      lastLoginAt: u.lastLoginAt ? iso(u.lastLoginAt) : null,
    };
  }

  /** A staff member: a manager / SuperAdmin grant, or an invited manager (profile, no grant yet). */
  async function loadStaff(ctx: AnyCtx): Promise<{ user: UserRec; grants: GrantRec[]; profile: StaffProfileRec | null }> {
    const user = await repo.getUser(ctx.params.userId);
    if (!user) fail('not_found', { detail: 'staff' });
    const grants = await repo.listGrants(user.id);
    const profile = await repo.getStaffProfile(user.id);
    if (!grants.some((g) => g.role === 'manager' || g.role === 'superadmin') && !profile) fail('not_found', { detail: 'staff' });
    assertNotSelf(ctx.auth.user!.id, user.id);
    return { user, grants, profile };
  }

  const profileOf = (u: UserRec, p: StaffProfileRec | null, by: string): StaffProfileRec =>
    p ?? { userId: u.id, permissions: [], scope: null, createdBy: by, createdAt: u.createdAt, blockedAt: null, deletedAt: null };

  reg(app, deps, 'staffList', async () => {
    const ids = new Set<string>([...(await repo.listUserIdsByRole('manager')), ...(await repo.listUserIdsByRole('superadmin'))]);
    const profiles = new Map((await repo.listStaffProfiles()).map((p) => [p.userId, p]));
    profiles.forEach((_p, id) => ids.add(id));
    const users = await repo.getUsers([...ids].sort());
    const items: StaffMember[] = [];
    for (const u of users) items.push(await toMember(u, undefined, profiles.get(u.id) ?? null));
    return { items };
  });

  reg(app, deps, 'staffInvite', async (ctx) => {
    const b = ctx.body as { email: string; displayName: string; permissions: Parameters<typeof checkAssignable>[0] };
    const permissions = checkAssignable(b.permissions);
    const email = b.email.toLowerCase();
    const by = ctx.auth.user!.id;
    const now = clock.now();
    let user = await repo.getUserByEmail(email);
    // No shared accounts: an existing (teacher, student, active staff) account is never turned into a manager here.
    if (user && !(user.status === 'invited' && (await repo.getStaffProfile(user.id)))) fail('conflict', { detail: 'email_in_use' });
    if (!user) {
      const created = await repo.createUser({ id: newId(), kind: 'adult', email, emailVerifiedAt: null, displayName: b.displayName, locale: 'ru', status: 'invited' });
      if (created === 'conflict') fail('conflict', { detail: 'email_in_use' });
      user = created as UserRec;
    } else {
      user = (await repo.updateUser(user.id, { displayName: b.displayName }))!;
    }
    const prev = await repo.getStaffProfile(user.id);
    await repo.putStaffProfile({ userId: user.id, permissions, scope: null, createdBy: prev?.createdBy ?? by, createdAt: prev?.createdAt ?? now, blockedAt: null, deletedAt: null });
    // A new invite replaces any earlier pending one for this address.
    for (const i of (await repo.listInvites({ scope: 'platform' }, { limit: 10_000 })).items) {
      if (i.email === email && !i.acceptedAt && !i.revokedAt) await repo.updateInvite(i.id, { revokedAt: now });
    }
    const token = randomToken();
    await repo.createInvite({
      id: newId(),
      email,
      role: 'manager',
      scope: 'platform',
      scopeId: null,
      subrole: null,
      permissions,
      tokenHash: hashToken(token),
      invitedBy: by,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      acceptedAt: null,
    });
    const link = `${config.adminUrl}/invite?token=${token}`;
    await mailer.send({ to: email, kind: 'invite', link, subject: 'Bilig: приглашение в админку', text: `Вас пригласили в админку Bilig. Ссылка действует 7 дней:\n${link}\nПосле входа подключите приложение-аутентификатор (2FA).` });
    await audit.log(by, 'staff.invited', { type: 'user', id: user.id, label: email }, { ip: ctx.ip, after: { email, displayName: b.displayName, permissions } });
    return { ok: true as const };
  });

  reg(app, deps, 'staffPatch', async (ctx) => {
    const { user, grants, profile } = await loadStaff(ctx);
    const b = ctx.body as { permissions?: Parameters<typeof checkAssignable>[0]; displayName?: string; reason: string };
    const by = ctx.auth.user!.id;
    if (b.permissions && grants.some((g) => g.role === 'superadmin')) fail('validation_failed', { detail: 'superadmin_holds_all' });
    let u = user;
    let p = profile;
    if (b.permissions) {
      const next = checkAssignable(b.permissions);
      const cur = profileOf(user, profile, by);
      p = { ...cur, permissions: next };
      await repo.putStaffProfile(p);
      await audit.log(by, 'staff.permissions_changed', { type: 'user', id: user.id, label: user.email }, { ip: ctx.ip, reason: b.reason, before: { permissions: cur.permissions }, after: { permissions: next } });
    }
    if (b.displayName && b.displayName !== user.displayName) {
      u = (await repo.updateUser(user.id, { displayName: b.displayName }))!;
      await audit.log(by, 'staff.updated', { type: 'user', id: user.id, label: user.email }, { ip: ctx.ip, reason: b.reason, before: { displayName: user.displayName }, after: { displayName: b.displayName } });
    }
    return toMember(u, grants, p);
  });

  reg(app, deps, 'staffBlock', async (ctx) => {
    const { user, grants, profile } = await loadStaff(ctx);
    const by = ctx.auth.user!.id;
    if (profile?.deletedAt) fail('conflict', { detail: 'staff_deleted' });
    await assertSuperadminFloor(repo, user.id);
    const now = clock.now();
    const p = { ...profileOf(user, profile, by), blockedAt: profile?.blockedAt ?? now };
    await repo.putStaffProfile(p);
    const u = (await repo.updateUser(user.id, { status: 'blocked' }))!;
    const revoked = await repo.revokeUserSessions(user.id, now);
    await audit.log(by, 'staff.blocked', { type: 'user', id: user.id, label: user.email }, { ip: ctx.ip, reason: (ctx.body as { reason: string }).reason, before: { status: user.status }, after: { status: 'blocked', revoked } });
    return toMember(u, grants, p);
  });

  reg(app, deps, 'staffRestore', async (ctx) => {
    const { user, grants, profile } = await loadStaff(ctx);
    const by = ctx.auth.user!.id;
    const p = { ...profileOf(user, profile, by), blockedAt: null, deletedAt: null };
    await repo.putStaffProfile(p);
    const hasPassword = !!(await repo.getCredential(user.id, 'password'));
    const u = (await repo.updateUser(user.id, { status: hasPassword ? 'active' : 'invited', deletedAt: null }))!;
    await audit.log(by, 'staff.restored', { type: 'user', id: user.id, label: user.email }, {
      ip: ctx.ip,
      reason: (ctx.body as { reason: string }).reason,
      before: { blocked: !!profile?.blockedAt, deleted: !!profile?.deletedAt },
      after: { status: u.status },
    });
    return toMember(u, grants, p);
  });

  // Soft delete: the account can no longer sign in and is hidden from work, but it is kept
  // (never purged: user.deletedAt stays empty) so the journal keeps its history; restore is possible.
  reg(app, deps, 'staffDelete', async (ctx) => {
    const { user, grants, profile } = await loadStaff(ctx);
    const by = ctx.auth.user!.id;
    await assertSuperadminFloor(repo, user.id);
    const now = clock.now();
    const p = { ...profileOf(user, profile, by), deletedAt: profile?.deletedAt ?? now };
    await repo.putStaffProfile(p);
    const u = (await repo.updateUser(user.id, { status: 'blocked' }))!;
    const revoked = await repo.revokeUserSessions(user.id, now);
    await audit.log(by, 'staff.deleted', { type: 'user', id: user.id, label: user.email }, { ip: ctx.ip, reason: (ctx.body as { reason: string }).reason, before: { status: user.status }, after: { status: 'deleted', revoked } });
    return toMember(u, grants, p);
  });
}
