/** Signed access tokens (HS256 JWT, 15 min, `aud` = client|admin) — TZ §6. */
import { SignJWT, jwtVerify, errors } from 'jose';
import type { Audience } from '../repo/types.js';

export const ACCESS_TTL_SEC = 15 * 60;
const ISSUER = 'bilig';

export interface AccessClaims {
  sub: string;
  sid: string;
  aud: Audience;
  kind: 'adult' | 'student';
}

export class JwtService {
  private key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(c: AccessClaims, now: Date): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT({ sid: c.sid, kind: c.kind })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(c.sub)
      .setAudience(c.aud)
      .setIssuer(ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TTL_SEC)
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
      return { sub: payload.sub, sid: payload.sid, aud: audience, kind };
    } catch (e) {
      if (e instanceof errors.JOSEError) return null;
      return null;
    }
  }
}
