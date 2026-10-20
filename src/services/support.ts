/**
 * Contract 0.8.0 §3: support sessions — a staff member in a teacher's cabinet.
 * View mode (15 min) reads only; edit mode (30 min) needs teacher.edit, a
 * reason and the staff member's TOTP again. No refresh: the session ends at
 * expiry or on «Выйти в админку». Some areas are closed in every mode
 * (credentials, 2FA, sessions, account deletion, payment). The teacher is not
 * notified: the journal (both ids) is the only trace.
 */
import type { Deps } from '../deps.js';
import { API_PREFIX } from '@bilig/content-model/api';
import type { SupportMode, SupportSessionRec } from '../repo/types.js';

export const SUPPORT_TTL_MS: Record<SupportMode, number> = { view: 15 * 60_000, edit: 30 * 60_000 };

/**
 * Closed in every mode (403 `support_forbidden`): sign-in and credentials
 * (/auth/*), 2FA, the teacher's sessions (list, end one, logout-all), and —
 * once they exist — phone / e-mail / password changes, account deletion,
 * payments and the private «Мои материалы».
 */
const FORBIDDEN: { method?: string; re: RegExp }[] = [
  { re: /^\/auth\// },
  { re: /^\/me\/2fa(\/|$)/ },
  { re: /^\/me\/sessions(\/|$)/ },
  { re: /^\/me\/(password|phone|email|delete|account)(\/|$)/ },
  { method: 'DELETE', re: /^\/me\/?$/ },
  { re: /^\/(payments?|billing|subscriptions?)(\/|$)/ },
  { re: /^\/me\/(payments?|billing|subscriptions?)(\/|$)/ },
  { re: /^\/me\/materials(\/|$)/ },
];

/** Path under the API prefix, without the query string. */
export const apiPath = (url: string) => {
  const p = url.split('?')[0];
  return p.startsWith(API_PREFIX) ? p.slice(API_PREFIX.length) : p;
};

export const isSupportForbidden = (method: string, url: string): boolean => {
  const p = apiPath(url);
  return FORBIDDEN.some((f) => (!f.method || f.method === method.toUpperCase()) && f.re.test(p));
};

export const isSupportEndPath = (url: string) => /^\/admin\/support\/[^/]+\/end$/.test(apiPath(url));

export const isReadOnlyMethod = (method: string) => ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

/** End a session once (expiry, «Выйти в админку», lost rights) and journal it with both ids. */
export async function endSupport(deps: Deps, s: SupportSessionRec, by: string | null, reason: 'ended' | 'expired', note?: string): Promise<boolean> {
  const ended = await deps.repo.endSupportSession(s.id, deps.clock.now(), by, reason);
  if (!ended) return false;
  await deps.audit.log(s.actorId, 'support.ended', { type: 'user', id: s.teacherId }, {
    onBehalfOf: s.teacherId,
    supportSessionId: s.id,
    diff: { mode: s.mode, reason, ...(note ? { note } : {}), ...(by && by !== s.actorId ? { endedBy: by } : {}) },
  });
  return true;
}

/** Scheduled: close expired sessions (they are also closed lazily on their next request). */
export async function expireSupportSessions(deps: Deps): Promise<number> {
  let n = 0;
  for (const s of await deps.repo.listExpiredSupportSessions(deps.clock.now())) if (await endSupport(deps, s, null, 'expired')) n++;
  return n;
}
