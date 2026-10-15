/**
 * Resolve the request Principal from the Authorization header (TZ §2).
 *
 * Permissions are enforced ONLY on the backend against @bilig/permissions. In
 * this MVP a bearer token carries a base64url-encoded JSON principal for local
 * development; in production this is replaced by verified JWT claims. The shape
 * the rest of the app depends on — the resolved `Principal` — stays identical,
 * so swapping the verifier later touches only this file.
 */
import { GUEST, type Principal } from '@bilig/permissions';

/** Decode `Authorization: Bearer <base64url(JSON Principal)>` into a Principal. */
export function principalFromAuth(header: string | undefined): Principal {
  if (!header) return GUEST;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return GUEST;
  try {
    const json = Buffer.from(match[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<Principal>;
    if (!parsed || !Array.isArray(parsed.grants)) return GUEST;
    return {
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      grants: parsed.grants,
    };
  } catch {
    return GUEST;
  }
}

/** Dev helper: mint a token for a principal (used by tests and local tooling). */
export function devToken(principal: Principal): string {
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url');
}
