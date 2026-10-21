/**
 * The action journal (contract 0.8.0 §4): groups, secret stripping, the
 * canonical JSON of an event and its chain hash. PostgreSQL computes the hash
 * in SQL (audit_event_append, jsonb's normalised text); the in-memory
 * repository uses `memoryEventHash` below. Each backend verifies its own chain.
 */
import { createHash } from 'node:crypto';
import type { AuditEventInput, AuditGroup, AuditRec } from '../repo/types.js';

/** The journal group of an action (`content.publish` → content). */
export function groupOf(action: string): AuditGroup {
  const p = action.split('.')[0];
  switch (p) {
    case 'auth':
      return 'auth';
    case 'user':
    case 'invite':
    case 'staff':
      return 'staff';
    case 'support':
      return 'support';
    case 'content':
    case 'asset':
    case 'review':
    case 'generated':
    case 'book':
    case 'tutor':
      return 'content';
    case 'export':
      return 'export';
    case 'deletion':
      return 'deletion';
    default:
      return 'teacher_data';
  }
}

/** Field names that hold secrets: never written to the journal. */
const SECRET_KEY = /pass(word)?|secret|token|otpauth|^pin$|^code$|^totp$|^otp$|cookie|authorization/i;
/** Non-secret marker values allowed under a secret-looking key (e.g. `totp: 'fixed'`). */
const MARKERS = new Set(['fixed', 'enrolled', 'admin_enrollment']);

/**
 * A JSON-safe copy without secrets: keys like password / token / totp / secret
 * are dropped (booleans and known markers stay), Dates become ISO strings,
 * `undefined` and functions disappear, NUL characters are removed.
 */
export function sanitize(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return null;
  if (depth > 12) return '[depth]';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v.replace(/\u0000/g, '');
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || typeof x === 'function') continue;
      if (SECRET_KEY.test(k) && !(typeof x === 'boolean' || (typeof x === 'string' && MARKERS.has(x)))) continue;
      out[k.replace(/\u0000/g, '')] = sanitize(x, depth + 1);
    }
    return out;
  }
  return null;
}

/** JSON with object keys sorted (recursively): equal values give equal text. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The hashed fields of an event (everything but `hash`). */
export function eventBody(e: AuditEventInput & { seq: number; prevHash: string }) {
  return {
    seq: e.seq,
    id: e.id,
    at: e.at.toISOString(),
    actorId: e.actorId,
    actorRole: e.actorRole,
    onBehalfOfId: e.onBehalfOfId,
    group: e.group,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    targetLabel: e.targetLabel,
    before: e.before ?? null,
    after: e.after ?? null,
    details: e.details ?? null,
    reason: e.reason,
    result: e.result,
    ip: e.ip,
    userAgent: e.userAgent,
    requestId: e.requestId,
    supportSessionId: e.supportSessionId,
    prevHash: e.prevHash,
  };
}

/** sha256(prevHash ‖ canonical JSON of the row), hex — the in-memory chain. */
export const memoryEventHash = (e: AuditEventInput & { seq: number; prevHash: string }) =>
  createHash('sha256').update(e.prevHash + canonicalJson(eventBody(e)), 'utf8').digest('hex');

/** A legacy AuditRec (appendAudit) as a journal event. */
export function legacyToEvent(a: AuditRec): AuditEventInput {
  const diff = sanitize(a.diff);
  const obj = diff && typeof diff === 'object' && !Array.isArray(diff) ? (diff as Record<string, unknown>) : null;
  return {
    id: a.id,
    at: a.ts,
    actorId: a.actorId,
    actorRole: null,
    onBehalfOfId: null,
    group: groupOf(a.action),
    action: a.action,
    targetType: a.targetType,
    targetId: a.targetId,
    targetLabel: null,
    before: obj && 'before' in obj ? obj.before : null,
    after: obj && 'after' in obj ? obj.after : null,
    details: diff,
    reason: null,
    result: a.action === 'auth.login_failed' ? 'failed' : 'ok',
    ip: a.ip,
    userAgent: null,
    requestId: null,
    supportSessionId: null,
  };
}

/** The journal projected to the legacy AuditRec (GET /admin/audit). */
export const eventToLegacy = (e: AuditEventInput): AuditRec => ({
  id: e.id,
  actorId: e.actorId,
  action: e.action,
  targetType: e.targetType,
  targetId: e.targetId,
  diff: e.details ?? (e.before !== null || e.after !== null ? { before: e.before ?? null, after: e.after ?? null } : null),
  ip: e.ip,
  ts: e.at,
});
