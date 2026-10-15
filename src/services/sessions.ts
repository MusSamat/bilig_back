/**
 * Sessions & refresh tokens (TZ §6): opaque refresh token in an HttpOnly;
 * Secure; SameSite=Lax cookie, stored as sha256 only, rotated on every
 * refresh. Reusing an already-rotated token revokes the whole family.
 * Adults: 30-day sliding refresh. Students (shared school PCs): 8 hours
 * from login, never extended.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX, HEADERS } from '@bilig/content-model/api';
import { newId } from '../ids.js';
import { hashToken, randomToken } from '../domain/crypto.js';
import { ACCESS_TTL_SEC } from '../domain/jwt.js';
import type { Deps } from '../deps.js';
import type { Audience, SessionRec, UserRec } from '../repo/types.js';

export const ADULT_REFRESH_TTL_SEC = 30 * 24 * 3600;
export const STUDENT_REFRESH_TTL_SEC = 8 * 3600;
export const COOKIE_PATH = `${API_PREFIX}/auth`;

export const cookieName = (aud: Audience) => (aud === 'admin' ? 'bilig_admin_rt' : 'bilig_rt');

export function audienceOf(req: FastifyRequest): Audience {
  const h = req.headers[HEADERS.audience.toLowerCase()];
  return h === 'admin' ? 'admin' : 'client';
}

export function deviceOf(req: FastifyRequest): string {
  const ua = String(req.headers['user-agent'] ?? 'unknown');
  // Coarse device label only (no full UA fingerprint stored).
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /YaBrowser/.test(ua) ? 'Yandex' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

export interface Issued {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export class SessionService {
  constructor(private deps: Deps) {}

  private ttl(user: UserRec) {
    return user.kind === 'student' ? STUDENT_REFRESH_TTL_SEC : ADULT_REFRESH_TTL_SEC;
  }

  private setCookie(reply: FastifyReply, aud: Audience, token: string, expiresAt: Date) {
    reply.setCookie(cookieName(aud), token, {
      httpOnly: true,
      secure: this.deps.config.cookieSecure,
      sameSite: 'lax',
      path: COOKIE_PATH,
      expires: expiresAt,
    });
  }

  clearCookie(reply: FastifyReply, aud: Audience) {
    reply.clearCookie(cookieName(aud), { path: COOKIE_PATH, httpOnly: true, secure: this.deps.config.cookieSecure, sameSite: 'lax' });
  }

  async access(user: UserRec, session: SessionRec): Promise<Issued> {
    const accessToken = await this.deps.jwt.sign({ sub: user.id, sid: session.id, aud: session.audience, kind: user.kind }, this.deps.clock.now());
    return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL_SEC };
  }

  /** New login: a new session family. */
  async start(req: FastifyRequest, reply: FastifyReply, user: UserRec, aud: Audience): Promise<Issued> {
    const now = this.deps.clock.now();
    const token = randomToken();
    const id = newId();
    const session: SessionRec = {
      id,
      userId: user.id,
      refreshHash: hashToken(token),
      family: id,
      audience: aud,
      device: deviceOf(req),
      ip: req.ip ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.ttl(user) * 1000),
      revokedAt: null,
      replacedById: null,
    };
    await this.deps.repo.createSession(session);
    this.setCookie(reply, aud, token, session.expiresAt);
    return this.access(user, session);
  }

  /**
   * Rotate a refresh token. Returns null (→ 401) for unknown, expired or
   * revoked tokens. A token that was already rotated is a replay: the whole
   * family is revoked and the event audited.
   */
  async refresh(req: FastifyRequest, reply: FastifyReply, aud: Audience): Promise<Issued | null> {
    const token = req.cookies?.[cookieName(aud)];
    if (!token) return null;
    const now = this.deps.clock.now();
    const old = await this.deps.repo.getSessionByRefreshHash(hashToken(token));
    if (!old || old.audience !== aud) return null;
    if (old.replacedById) {
      await this.reuseDetected(old, req.ip);
      return null;
    }
    if (old.revokedAt || old.expiresAt <= now) return null;
    const user = await this.deps.repo.getUser(old.userId);
    if (!user || user.status !== 'active' || user.deletedAt) return null;
    const next: SessionRec = {
      ...old,
      id: newId(),
      refreshHash: hashToken(randomToken()),
      createdAt: now,
      // Students keep the 8 h cap from login; adults slide 30 days.
      expiresAt: user.kind === 'student' ? old.expiresAt : new Date(now.getTime() + this.ttl(user) * 1000),
      device: deviceOf(req),
      ip: req.ip ?? null,
      revokedAt: null,
      replacedById: null,
    };
    const fresh = randomToken();
    next.refreshHash = hashToken(fresh);
    if (!(await this.deps.repo.rotateSession(old.id, next, now))) {
      // Lost a race with another use of the same token → also a replay.
      await this.reuseDetected(old, req.ip);
      return null;
    }
    this.setCookie(reply, aud, fresh, next.expiresAt);
    return this.access(user, next);
  }

  private async reuseDetected(s: SessionRec, ip: string | undefined) {
    const n = await this.deps.repo.revokeFamily(s.family, this.deps.clock.now());
    await this.deps.audit.log(s.userId, 'auth.refresh_reuse', { type: 'session', id: s.family }, { diff: { revoked: n }, ip });
  }

  /** Revoke the session behind the refresh cookie (if any) and the access token's session. */
  async logout(req: FastifyRequest, reply: FastifyReply, aud: Audience) {
    const now = this.deps.clock.now();
    const token = req.cookies?.[cookieName(aud)];
    if (token) {
      const s = await this.deps.repo.getSessionByRefreshHash(hashToken(token));
      if (s) await this.deps.repo.revokeFamily(s.family, now);
    }
    if (req.auth.session) await this.deps.repo.revokeFamily(req.auth.session.family, now);
    this.clearCookie(reply, aud);
  }
}
