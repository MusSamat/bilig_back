/** Signed access tokens (HS256 JWT, 15 min, `aud` = client|admin) — TZ §6. */
import { SignJWT, jwtVerify, errors } from 'jose';
import type { Audience } from '../repo/types.js';

export const ACCESS_TTL_SEC = 15 * 60;
const ISSUER = 'bilig';

export interface AccessClaims {
  sub: string;
  /** Session id; for a support token the ImpersonationSession id. */
  sid: string;
  aud: Audience;
  kind: 'adult' | 'student';
  /** v0.8.0 support token: the staff member acting in the teacher's (`sub`) cabinet (RFC 8693 `act.sub`). */
  act?: string;
  /** v0.8.0 support token: view | edit. */
  mode?: 'view' | 'edit';
}

export class JwtService {
  private key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  /** `ttlSec` defaults to the 15-minute access lifetime (support tokens: 15 / 30 min). */
  async sign(c: AccessClaims, now: Date, ttlSec = ACCESS_TTL_SEC): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT({ sid: c.sid, kind: c.kind, ...(c.act ? { act: { sub: c.act }, mode: c.mode ?? 'view' } : {}) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(c.sub)
      .setAudience(c.aud)
      .setIssuer(ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttlSec)
      .sign(this.key);
  }

  /** Verifies signature, issuer, audience and expiry. Returns null on any failure. */
  async verify(token: string, audience: Audience, now: Date): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience,
        algorithms: ['HS256'],
        currentDate: now,
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      const kind = payload.kind === 'student' ? 'student' : 'adult';
      const act = payload.act && typeof payload.act === 'object' ? (payload.act as { sub?: unknown }).sub : undefined;
      if (payload.act !== undefined && typeof act !== 'string') return null;
      const mode = payload.mode === 'edit' ? 'edit' : 'view';
      return { sub: payload.sub, sid: payload.sid, aud: audience, kind, ...(typeof act === 'string' ? { act, mode } : {}) };
    } catch (e) {
      if (e instanceof errors.JOSEError) return null;
      return null;
    }
  }
}
