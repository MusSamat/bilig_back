/**
 * Request authentication: verify the JWT (signature, issuer, `aud`, expiry),
 * then the live session and user, then load role grants (managers: with the
 * permissions SuperAdmin ticked). The resulting Principal is what
 * @bilig/permissions checks. There is no other way to become authenticated.
 *
 * v0.8.0 support tokens (`act` claim): a staff member works in a teacher's
 * cabinet. The principal is the teacher's; the ImpersonationSession must be
 * open and unexpired and the staff member must still hold teacher.view
 * (teacher.edit for edit mode) — checked on every request.
 */
import type { FastifyRequest } from 'fastify';
import { API_PREFIX } from '@bilig/content-model/api';
import { GUEST, grantFor, type Principal, type RoleGrant } from '@bilig/permissions';
import type { Deps } from '../deps.js';
import type { AccessClaims } from '../domain/jwt.js';
import type { Audience, GrantRec, SessionRec, SupportSessionRec, UserRec } from '../repo/types.js';
import { isStaff, principalGrants } from '../services/staff.js';
import { endSupport } from '../services/support.js';
import { HttpError } from './errors.js';

export interface SupportCtx {
  session: SupportSessionRec;
  /** The staff member. */
  actor: UserRec;
  actorGrants: GrantRec[];
}

export interface AuthCtx {
  principal: Principal;
  user: UserRec | null;
  session: SessionRec | null;
  aud: Audience | null;
  grants: GrantRec[];
  /** v0.8.0: set while a staff member works in this (teacher's) cabinet. */
  support: SupportCtx | null;
}

export const GUEST_CTX: AuthCtx = { principal: GUEST, user: null, session: null, aud: null, grants: [], support: null };

export const toRoleGrant = (g: GrantRec): RoleGrant => ({
  role: g.role,
  scope: g.scope,
  ...(g.scopeId ? { scopeId: g.scopeId } : {}),
  ...(g.subrole ? { subrole: g.subrole } : {}),
});

export const isAdminPath = (url: string) => url.startsWith(`${API_PREFIX}/admin/`) || url === `${API_PREFIX}/admin`;
const isAuthPath = (url: string) => url.startsWith(`${API_PREFIX}/auth/`);
/** POST /admin/support/:id/end also takes the support token itself («Выйти в админку»). */
export const SUPPORT_END_RE = new RegExp(`^${API_PREFIX}/admin/support/[^/]+/end$`);

/** Resolve the caller. A presented but invalid token → 401 (so the client refreshes), except on /auth/*. */
export async function resolveAuth(req: FastifyRequest, deps: Deps): Promise<AuthCtx> {
  const header = req.headers.authorization;
  if (!header) return GUEST_CTX;
  const m = /^Bearer\s+([A-Za-z0-9_\-.]+)$/.exec(header.trim());
  const url = req.url.split('?')[0];
  const reject = (): AuthCtx => {
    if (isAuthPath(url)) return GUEST_CTX;
    throw new HttpError('unauthorized', { detail: 'invalid_token' });
  };
  if (!m) return reject();
  const now = deps.clock.now();
  // Admin API accepts only admin-audience tokens; a client token there is rejected (TZ §6).
  const audiences: Audience[] = isAdminPath(url) ? (SUPPORT_END_RE.test(url) ? ['admin', 'client'] : ['admin']) : ['client', 'admin'];
  let claims: AccessClaims | null = null;
  for (const aud of audiences) {
    claims = await deps.jwt.verify(m[1], aud, now);
    if (claims) break;
  }
  if (!claims) return reject();
  if (claims.act) return (await resolveSupport(deps, claims, now)) ?? reject();
  // A plain client token is not accepted on the support-end path (only the support token or an admin token).
  if (isAdminPath(url) && claims.aud !== 'admin') return reject();
  const session = await deps.repo.getSession(claims.sid);
  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= now) {
    // A rotated-out session's access token stays valid until it expires (≤15 min) only
    // if the family is alive; revoked families (logout, reuse) are cut off immediately.
    if (!session || session.userId !== claims.sub || !session.replacedById || session.expiresAt <= now) return reject();
    const family = await deps.repo.listActiveSessions(session.userId, now);
    if (!family.some((s) => s.family === session.family)) return reject();
  }
  const user = await deps.repo.getUser(claims.sub);
  if (!user || user.status !== 'active' || user.deletedAt) return reject();
  const { grants, roleGrants } = await principalGrants(deps.repo, user.id);
  return { principal: { userId: user.id, grants: roleGrants }, user, session, aud: claims.aud, grants, support: null };
}

async function resolveSupport(deps: Deps, claims: AccessClaims, now: Date): Promise<AuthCtx | null> {
  const { repo } = deps;
  if (claims.aud !== 'client') return null;
  const s = await repo.getSupportSession(claims.sid);
  if (!s || s.teacherId !== claims.sub || s.actorId !== claims.act || s.mode !== claims.mode || s.endedAt) return null;
  if (s.expiresAt <= now) {
    await endSupport(deps, s, null, 'expired');
    return null;
  }
  const actor = await repo.getUser(s.actorId);
  if (!actor || actor.status !== 'active' || actor.deletedAt) return null;
  const staff = await principalGrants(repo, actor.id);
  const actorPrincipal: Principal = { userId: actor.id, grants: staff.roleGrants };
  // The staff member lost the right meanwhile (blocked, permission removed): the session ends.
  if (!isStaff(staff.grants) || grantFor(actorPrincipal, 'teacher.view') === false || (s.mode === 'edit' && grantFor(actorPrincipal, 'teacher.edit') === false)) {
    await endSupport(deps, s, null, 'ended', 'actor_lost_permission');
    return null;
  }
  const teacher = await repo.getUser(s.teacherId);
  if (!teacher || teacher.status !== 'active' || teacher.deletedAt) return null;
  const t = await principalGrants(repo, teacher.id);
  if (isStaff(t.grants)) return null; // never a staff account
  return {
    principal: { userId: teacher.id, grants: t.roleGrants },
    user: teacher,
    session: null,
    aud: 'client',
    grants: t.grants,
    support: { session: s, actor, actorGrants: staff.grants },
  };
}
