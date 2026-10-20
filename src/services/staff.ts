/**
 * Contract 0.8.0 §1–2: staff (manager, SuperAdmin). A manager holds the
 * permissions SuperAdmin ticked (StaffProfile.permissions, the matrix is the
 * ceiling); the principal is built from the grants and the profile on every
 * request, so a change applies at once. Guards: nobody changes their own role
 * or permissions; never fewer than two active SuperAdmins once two exist.
 */
import { MANAGER_ASSIGNABLE, type Permission, type RoleGrant } from '@bilig/permissions';
import type { Deps } from '../deps.js';
import { fail } from '../http/errors.js';
import { safeEqual } from '../domain/crypto.js';
import { verifyTotp } from '../domain/totp.js';
import type { GrantRec, Repository, StaffProfileRec, UserRec } from '../repo/types.js';

/** Roles that make an account staff: admin sign-in only, never opened through support. */
export const STAFF_ROLES = new Set(['manager', 'superadmin', 'author', 'editor']);
/** Roles allowed on the admin audience (school admins keep their dormant admin screens). */
export const ADMIN_ROLES = new Set([...STAFF_ROLES, 'school_admin']);

export const isStaff = (grants: readonly Pick<GrantRec, 'role'>[]) => grants.some((g) => STAFF_ROLES.has(g.role));

const ROLE_ORDER = ['superadmin', 'manager', 'editor', 'author', 'school_admin', 'teacher', 'student'];
/** The most powerful role of a set of grants (journal `actorRole`). */
export function primaryRole(grants: readonly Pick<GrantRec, 'role'>[]): string | null {
  for (const r of ROLE_ORDER) if (grants.some((g) => g.role === r)) return r;
  return null;
}

/** A manager profile's effective ticks: none while blocked / deleted. */
export const profilePermissions = (p: StaffProfileRec | null): Permission[] => (p && !p.blockedAt && !p.deletedAt ? p.permissions : []);

/** RoleGrant (principal form) of a grant row; managers carry the ticked permissions. */
export function toPrincipalGrant(g: GrantRec, profile: StaffProfileRec | null): RoleGrant {
  return {
    role: g.role,
    scope: g.scope,
    ...(g.scopeId ? { scopeId: g.scopeId } : {}),
    ...(g.subrole ? { subrole: g.subrole } : {}),
    ...(g.role === 'manager' ? { permissions: profilePermissions(profile) } : {}),
  };
}

/** The user's grants for the principal (with the manager's permissions from StaffProfile). */
export async function principalGrants(repo: Repository, userId: string, grants?: GrantRec[]): Promise<{ grants: GrantRec[]; roleGrants: RoleGrant[] }> {
  const rows = grants ?? (await repo.listGrants(userId));
  const profile = rows.some((g) => g.role === 'manager') ? await repo.getStaffProfile(userId) : null;
  return { grants: rows, roleGrants: rows.map((g) => toPrincipalGrant(g, profile)) };
}

/** Only MANAGER_ASSIGNABLE permissions can be ticked (400 otherwise). */
export function checkAssignable(perms: readonly Permission[]): Permission[] {
  const bad = perms.filter((p) => !MANAGER_ASSIGNABLE.includes(p));
  if (bad.length) fail('validation_failed', { detail: 'permission_not_assignable', issues: [{ path: ['permissions'], message: `Not assignable to a manager: ${bad.join(', ')}` }] });
  return [...new Set(perms)].sort();
}

/** Is this user an active SuperAdmin (signed-in capable, not blocked / deleted)? */
export async function isActiveSuperadmin(repo: Repository, u: UserRec | null): Promise<boolean> {
  if (!u || u.deletedAt || u.status !== 'active') return false;
  if (!(await repo.listGrants(u.id)).some((g) => g.role === 'superadmin')) return false;
  const p = await repo.getStaffProfile(u.id);
  return !p?.blockedAt && !p?.deletedAt;
}

export async function activeSuperadminIds(repo: Repository): Promise<string[]> {
  const ids = await repo.listUserIdsByRole('superadmin');
  const users = await repo.getUsers(ids);
  const out: string[] = [];
  for (const u of users) if (await isActiveSuperadmin(repo, u)) out.push(u.id);
  return out;
}

/**
 * Refuse (409 `superadmin_minimum`) an action that takes `userId` out of the
 * active SuperAdmins when that leaves fewer than two (once two exist) or none.
 */
export async function assertSuperadminFloor(repo: Repository, userId: string): Promise<void> {
  const active = await activeSuperadminIds(repo);
  if (!active.includes(userId)) return;
  const after = active.length - 1;
  if (after < 2) fail('conflict', { detail: 'superadmin_minimum' });
}

/** Refuse any change of one's own role, permissions or lifecycle (403 `self`). */
export function assertNotSelf(actorId: string, targetId: string): void {
  if (actorId === targetId) fail('forbidden', { detail: 'self' });
}

/**
 * The staff member's TOTP again (support edit mode, deletion approval): the
 * enrolled authenticator or, in the test period, AUTH_FIXED_TOTP. The dev-only
 * ADMIN_TOTP_DISABLED skips it. Rate-limited with the sign-in counter.
 */
export async function verifyStaffTotp(deps: Deps, userId: string, code: string | undefined): Promise<void> {
  const { config, repo, limiter, clock } = deps;
  if (config.adminTotpDisabled) return;
  if (!code) fail('totp_required');
  const r = await limiter.hit(`totp:${userId}`, 10, 15 * 60);
  if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
  if (config.authFixedTotp && safeEqual(code!, config.authFixedTotp)) return;
  const cred = await repo.getCredential(userId, 'totp');
  if (!cred || cred.secretHash.startsWith('pending:') || !verifyTotp(cred.secretHash, code!, clock.now())) fail('invalid_credentials', { detail: 'totp' });
}
