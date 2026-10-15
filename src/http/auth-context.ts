/**
 * Request authentication: verify the JWT (signature, issuer, `aud`, expiry),
 * then the live session and user, then load role grants. The resulting
 * Principal is what @bilig/permissions checks. There is no other way to
 * become authenticated — the old unsigned base64 principal is gone.
 */
import type { FastifyRequest } from 'fastify';
import { API_PREFIX } from '@bilig/content-model/api';
import { GUEST, type Principal, type RoleGrant } from '@bilig/permissions';
import type { Deps } from '../deps.js';
import type { Audience, GrantRec, SessionRec, UserRec } from '../repo/types.js';
import { HttpError } from './errors.js';

export interface AuthCtx {
  principal: Principal;
  user: UserRec | null;
  session: SessionRec | null;
  aud: Audience | null;
  grants: GrantRec[];
}

export const GUEST_CTX: AuthCtx = { principal: GUEST, user: null, session: null, aud: null, grants: [] };

export const toRoleGrant = (g: GrantRec): RoleGrant => ({
  role: g.role,
  scope: g.scope,
  ...(g.scopeId ? { scopeId: g.scopeId } : {}),
  ...(g.subrole ? { subrole: g.subrole } : {}),
});

export const isAdminPath = (url: string) => url.startsWith(`${API_PREFIX}/admin/`) || url === `${API_PREFIX}/admin`;
const isAuthPath = (url: string) => url.startsWith(`${API_PREFIX}/auth/`);

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
  const audiences: Audience[] = isAdminPath(url) ? ['admin'] : ['client', 'admin'];
  let claims = null;
  for (const aud of audiences) {
    claims = await deps.jwt.verify(m[1], aud, now);
    if (claims) break;
  }
  if (!claims) return reject();
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
  const grants = await deps.repo.listGrants(user.id);
  return { principal: { userId: user.id, grants: grants.map(toRoleGrant) }, user, session, aud: claims.aud, grants };
}
