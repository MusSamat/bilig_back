/** Shared helpers for the admin modules. */
import type { FastifyInstance } from 'fastify';
import { LANGS, isLocalizedValue as isLocalizedContract, t as tr, type Lang, type Topic } from '@bilig/content-model';
import type { EndpointName } from '@bilig/content-model/api';
import { canEditField, type ContentField, type Permission } from '@bilig/permissions';
import type { Deps } from '../../deps.js';
import { route, type Ctx, type RouteOptions } from '../../http/route.js';
import { fail } from '../../http/errors.js';
import { diffJson } from '../../domain/diff.js';
import { getAtPath } from '../../domain/strings.js';
import type { ContentRec, TopicRec, TopicVersionRec } from '../../repo/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyCtx = Ctx<any>;

/** Untyped registration for table-driven routes (the response is still contract-validated). */
export function reg(app: FastifyInstance, deps: Deps, name: EndpointName, h: (ctx: AnyCtx) => unknown, opts?: RouteOptions) {
  route(app, deps, name as never, h as never, opts);
}

export const iso = (d: Date) => d.toISOString();

export function toRecord<T>(r: ContentRec<T>) {
  return { id: r.id, data: r.data, version: r.version, updatedAt: iso(r.updatedAt), ...(r.updatedBy ? { updatedBy: r.updatedBy } : {}) };
}

/** Body `version` (if present) must agree with If-Match. */
export function checkBodyVersion(ctx: AnyCtx) {
  const v = (ctx.body as { version?: number } | undefined)?.version;
  if (v !== undefined && v !== ctx.ifMatch) fail('validation_failed', { detail: 'body.version must equal If-Match' });
}

export const isLocalizedValue = (v: unknown): boolean => isLocalizedContract(v);

/** A sortable scalar from any JSON value: numbers/strings as-is, booleans 0/1, arrays by length, Localized in `lang`. */
export function sortScalar(v: unknown, lang: Lang): string | number | undefined {
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  if (isLocalizedContract(v)) return tr(v, lang);
  return undefined;
}

/** Semver as a sortable string (`1.10.0` after `1.9.0`). */
export const semverSortKey = (v: string | undefined) =>
  v ? v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(8, '0') : p)).join('.') : undefined;

/** Optional If-Match / body `version`: the expected version, or null when neither was sent. 400 when they disagree. */
export function optionalVersion(ctx: AnyCtx): number | null {
  const body = (ctx.body as { version?: number } | undefined)?.version;
  const header = ctx.ifMatch >= 0 ? ctx.ifMatch : undefined;
  if (body !== undefined && header !== undefined && body !== header) fail('validation_failed', { detail: 'body.version must equal If-Match' });
  return body ?? header ?? null;
}

/** `mine=true` → the caller; else `authorId`. */
export const authorFilter = (ctx: AnyCtx, q: { authorId?: string; mine?: boolean }): string | undefined => (q.mine ? ctx.auth.user!.id : q.authorId);

const ASSET_KEYS = new Set(['asset', 'thumb', 'thumbUrl', 'icon']);

/** Which field groups (structure / strings / assets) does `before → after` touch? */
export function touchedFields(before: unknown, after: unknown): Set<ContentField> {
  const out = new Set<ContentField>();
  for (const c of diffJson(before, after)) {
    const last = c.path[c.path.length - 1];
    const parent = getAtPath(after, c.path.slice(0, -1)) ?? getAtPath(before, c.path.slice(0, -1));
    if ((typeof last === 'string' && (LANGS as readonly string[]).includes(last) && isLocalizedValue(parent)) || isLocalizedValue(c.after ?? c.before)) out.add('strings');
    else if (c.path.some((p) => typeof p === 'string' && ASSET_KEYS.has(p))) out.add('assets');
    else out.add('structure');
  }
  return out;
}

/** Author sub-roles (TZ §2): e.g. a translator may only change Localized strings. */
export function assertFields(ctx: AnyCtx, before: unknown, after: unknown, subjectKey: string | null) {
  for (const f of touchedFields(before, after)) {
    if (!canEditField(ctx.auth.principal, f, subjectKey ? { subjectId: subjectKey } : {})) fail('forbidden', { detail: `field_group:${f}` });
  }
}

/** Scope-aware check against the owning subject (null subject → only platform-level grants). */
export function authorizeSubject(ctx: AnyCtx, permission: Permission, subjectKey: string | null) {
  ctx.authorize(permission, subjectKey ? { subjectId: subjectKey } : {});
}

/** All (live) topics with all their version docs — for usage checks. */
export async function allTopicDocs(deps: Deps): Promise<{ topic: TopicRec; versions: TopicVersionRec[] }[]> {
  const topics = (await deps.repo.listTopics({}, { limit: 100_000 })).items;
  return Promise.all(topics.map(async (topic) => ({ topic, versions: await deps.repo.listTopicVersions(topic.id) })));
}

export async function topicsWhere(deps: Deps, pred: (doc: Topic) => boolean): Promise<string[]> {
  const out = new Set<string>();
  for (const { topic, versions } of await allTopicDocs(deps)) if (versions.some((v) => pred(v.doc))) out.add(topic.key);
  return [...out].sort();
}

/** Admin-scope helpers over the caller's grants. */
export const isSuperadmin = (ctx: AnyCtx) => ctx.auth.grants.some((g) => g.role === 'superadmin');
export const adminSchools = (ctx: AnyCtx) =>
  [...new Set(ctx.auth.grants.filter((g) => g.role === 'school_admin' && g.scopeId).map((g) => g.scopeId!))];
