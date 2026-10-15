/**
 * Admin: translation workspace (A-11). LocaleString rows mirror the Localized
 * values inside content docs (keys `kind/entityKey/path`). Edits are written
 * back into the owning document: dictionary entries are updated in place;
 * topic strings go into the latest version when it is a draft, otherwise a
 * new draft version is created. CSV (`key,source,target`) and XLIFF 1.2/2.0
 * import/export. `sourceChanged` = the ru source changed since translation.
 */
import type { FastifyInstance } from 'fastify';
import {
  ConceptSchema,
  CourseSchema,
  ItemSchema,
  ObjectiveSchema,
  ProcessSchema,
  SubjectGroupSchema,
  SubjectSchema,
  TopicSchema,
  UnitSchema,
  LANGS,
  type I18nStatus,
  type Lang,
  type Localized,
} from '@bilig/content-model';
import { canEditField } from '@bilig/permissions';
import type { z } from 'zod';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { parseCsv, toCsv } from '../../domain/csv.js';
import { nextVersion } from '../../domain/semver.js';
import { getAtPath, parseStringKey, setAtPath, sourceHash, SOURCE_LANG } from '../../domain/strings.js';
import { parseXliff, toXliff } from '../../domain/xliff.js';
import { pageArray, sortedPage } from '../../repo/paging.js';
import type { ContentKind, LocaleStringRec, LocaleStringWrite } from '../../repo/types.js';
import { toWrite } from '../../services/content-writes.js';
import { authorizeSubject, isLocalizedValue, iso, reg, type AnyCtx } from './util.js';

const DICT: Partial<Record<ContentKind, z.ZodTypeAny>> = {
  group: SubjectGroupSchema,
  subject: SubjectSchema,
  course: CourseSchema,
  unit: UnitSchema,
  objective: ObjectiveSchema,
  concept: ConceptSchema,
  process: ProcessSchema,
  item: ItemSchema,
};

export interface StringEdit {
  key: string;
  locale: Lang;
  value: string;
  status: I18nStatus;
  line?: number;
  /** false: an unchanged value keeps its stored status (re-imported files do not demote reviewed rows). */
  explicitStatus?: boolean;
}

export interface ApplyResult {
  updated: number;
  unchanged: number;
  unknownKeys: string[];
  errors: { line?: number; message: string }[];
}

export function registerStringsAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit } = deps;

  /** Apply edits to documents + rows. Throws 403 when the caller may not edit an entity's strings. */
  async function apply(ctx: AnyCtx, edits: readonly StringEdit[]): Promise<ApplyResult> {
    const res: ApplyResult = { updated: 0, unchanged: 0, unknownKeys: [], errors: [] };
    const groups = new Map<string, { kind: string; entityKey: string; edits: (StringEdit & { path: (string | number)[] })[] }>();
    for (const e of edits) {
      const p = parseStringKey(e.key);
      if (!p || (p.kind !== 'topic' && !DICT[p.kind as ContentKind])) {
        res.unknownKeys.push(e.key);
        continue;
      }
      const g = groups.get(`${p.kind}/${p.entityKey}`) ?? { kind: p.kind, entityKey: p.entityKey, edits: [] };
      g.edits.push({ ...e, path: p.path });
      groups.set(`${p.kind}/${p.entityKey}`, g);
    }
    const rows: LocaleStringWrite[] = [];
    for (const g of groups.values()) {
      let doc: unknown;
      let subjectKey: string | null;
      let save: (doc: unknown) => Promise<void>;
      if (g.kind === 'topic') {
        const t = await repo.getTopicByKey(g.entityKey);
        const v = t?.latestVersionId ? await repo.getTopicVersion(t.latestVersionId) : null;
        if (!t || !v) {
          res.unknownKeys.push(...g.edits.map((e) => e.key));
          continue;
        }
        doc = v.doc;
        subjectKey = t.subjectKey;
        save = async (next) => {
          const parsed = TopicSchema.parse(next);
          if (v.reviewState === 'draft') {
            await repo.updateTopicVersion(v.id, { doc: parsed });
            return;
          }
          const versions = (await repo.listTopicVersions(t.id)).map((x) => x.version);
          const created = await repo.createTopicVersion({
            id: newId(),
            topicId: t.id,
            topicKey: t.key,
            version: nextVersion(versions),
            doc: { ...parsed, status: 'draft' },
            authorId: ctx.auth.user!.id,
            createdAt: clock.now(),
            reviewState: 'draft',
            message: 'translations',
          });
          if (created === 'conflict') throw new Error('version conflict');
          await repo.updateTopic(t.id, { latestVersionId: created.id, status: 'draft', scheduledAt: null, scheduledVersionId: null }, null);
        };
      } else {
        const kind = g.kind as ContentKind;
        const store = repo.content(kind);
        const rec = await store.get(g.entityKey);
        if (!rec) {
          res.unknownKeys.push(...g.edits.map((e) => e.key));
          continue;
        }
        doc = rec.data;
        subjectKey = rec.subjectKey;
        save = async (next) => {
          const parsed = DICT[kind]!.parse(next);
          await store.update(g.entityKey, await toWrite(repo, kind, g.entityKey, parsed as never), null, ctx.auth.user!.id);
        };
      }
      let next = doc;
      let changed = 0;
      const touched = new Map<string, (string | number)[]>();
      for (const e of g.edits) {
        const cur = getAtPath(next, e.path);
        if (!isLocalizedValue(cur)) {
          res.unknownKeys.push(e.key);
          continue;
        }
        touched.set(e.key, e.path);
        if ((cur as Localized)[e.locale] === e.value) {
          res.unchanged++;
        } else {
          next = setAtPath(next, [...e.path, e.locale], e.value);
          changed++;
        }
      }
      const existing = new Map((await repo.getStrings([...touched.keys()])).map((r) => [`${r.key}\u0000${r.locale}`, r]));
      const valueChanged = (e: StringEdit) => (getAtPath(doc, touched.get(e.key)!) as Localized)[e.locale] !== e.value;
      const statusChanged = g.edits.some(
        (e) => touched.has(e.key) && e.explicitStatus !== false && existing.get(`${e.key}\u0000${e.locale}`)?.status !== e.status,
      );
      if (!changed && !statusChanged) continue;
      // Only entities that actually change need the caller's rights (an exported file re-imported as-is is a no-op).
      authorizeSubject(ctx, 'content.draft.edit', subjectKey);
      if (!canEditField(ctx.auth.principal, 'strings', subjectKey ? { subjectId: subjectKey } : {})) fail('forbidden', { detail: 'field_group:strings' });
      if (changed) {
        try {
          await save(next);
        } catch (err) {
          res.errors.push({ line: g.edits[0].line, message: `${g.kind}/${g.entityKey}: ${err instanceof Error ? err.message.slice(0, 300) : 'invalid'}` });
          continue;
        }
        res.updated += changed;
      }
      for (const e of g.edits) {
        const path = touched.get(e.key);
        if (!path) continue;
        if (e.explicitStatus === false && !valueChanged(e)) continue;
        const loc = getAtPath(next, path) as Localized;
        rows.push({ key: e.key, locale: e.locale, value: loc[e.locale], status: e.status, sourceHash: sourceHash(loc[SOURCE_LANG]), updatedAt: clock.now() });
      }
    }
    if (rows.length) await repo.upsertStrings(rows);
    if (res.updated) {
      deps.content.invalidate();
      await audit.log(ctx.auth.user!.id, 'content.updated', { type: 'strings', id: edits[0]?.locale ?? 'all' }, { ip: ctx.ip, diff: { updated: res.updated } });
    }
    return res;
  }

  const flag = (ctx: AnyCtx, name: string) => {
    const v = (ctx.req.query as Record<string, string | undefined>)[name];
    return v === 'true' || v === '1';
  };

  /** Rows of a locale with `sourceChanged` computed against the current ru rows. */
  async function rowsFor(locale: Lang, status?: I18nStatus) {
    const rows = (await repo.listStrings({ locale, ...(status ? { status } : {}) }, { limit: 1_000_000 })).items;
    const ru = new Map((await repo.listStrings({ locale: SOURCE_LANG }, { limit: 1_000_000 })).items.map((r) => [r.key, r]));
    return rows.map((r) => ({ row: r, ru: ru.get(r.key), sourceChanged: locale !== SOURCE_LANG && !!ru.get(r.key) && r.sourceHash !== sourceHash(ru.get(r.key)!.value) }));
  }

  /** v0.3.0 `q` (key or value, case-insensitive) and `prefix` (key) filters. */
  const textFilter = (q: { q?: string; prefix?: string }) => {
    const needle = q.q?.toLocaleLowerCase();
    return (key: string, values: string[]) =>
      (!q.prefix || key.startsWith(q.prefix)) && (!needle || key.toLocaleLowerCase().includes(needle) || values.some((v) => v.toLocaleLowerCase().includes(needle)));
  };

  reg(app, deps, 'adminStrings', async (ctx) => {
    const q = ctx.query as { locale: Lang; status?: I18nStatus; cursor?: string; limit?: number; q?: string; prefix?: string; sort?: 'key' | 'updatedAt' | 'status' | 'value'; order?: 'asc' | 'desc' };
    let rows = await rowsFor(q.locale, q.status);
    if (flag(ctx, 'untranslated')) rows = rows.filter((r) => !r.row.value.trim());
    if (flag(ctx, 'sourceChanged')) rows = rows.filter((r) => r.sourceChanged);
    const match = textFilter(q);
    if (q.q || q.prefix) rows = rows.filter((r) => match(r.row.key, [r.row.value, r.ru?.value ?? '']));
    const pq = { cursor: q.cursor, limit: Math.min(500, q.limit ?? 100) };
    const page =
      q.sort || q.order === 'desc'
        ? sortedPage(rows, { value: (r) => (q.sort === 'updatedAt' ? iso(r.row.updatedAt) : q.sort && q.sort !== 'key' ? r.row[q.sort] : r.row.key), tie: (r) => r.row.key, order: q.order }, pq)
        : pageArray(rows, pq, (r) => r.row.key);
    return {
      items: page.items.map(({ row, sourceChanged }) => ({ key: row.key, locale: row.locale, value: row.value, status: row.status, sourceHash: row.sourceHash, sourceChanged, version: row.version, updatedAt: iso(row.updatedAt) })),
      nextCursor: page.nextCursor,
    };
  });

  // v0.3.0: several locales side by side, one row per key (A-11 «ru → ky → en рядом»).
  reg(app, deps, 'adminStringRows', async (ctx) => {
    const q = ctx.query as { locales?: string; status?: I18nStatus; untranslated?: boolean; sourceChanged?: boolean; q?: string; prefix?: string; sort?: 'key' | 'updatedAt'; order?: 'asc' | 'desc'; cursor?: string; limit?: number };
    const locales = q.locales ? ([...new Set(q.locales.split(','))] as Lang[]) : [...LANGS];
    const all = (await repo.listStrings({}, { limit: 10_000_000 })).items;
    const byKey = new Map<string, Map<Lang, LocaleStringRec>>();
    for (const r of all) {
      const m = byKey.get(r.key) ?? new Map<Lang, LocaleStringRec>();
      m.set(r.locale, r);
      byKey.set(r.key, m);
    }
    const match = textFilter(q);
    const rows = [...byKey.entries()].flatMap(([key, m]) => {
      const src = m.get(SOURCE_LANG);
      const srcHash = src ? sourceHash(src.value) : '';
      const present = locales.flatMap((l) => (m.has(l) ? [m.get(l)!] : []));
      const stale = present.filter((r) => r.locale !== SOURCE_LANG && !!src && r.sourceHash !== srcHash).map((r) => r.locale);
      if (q.status && !present.some((r) => r.status === q.status)) return [];
      if (q.untranslated && !locales.some((l) => !m.get(l)?.value.trim())) return [];
      if (q.sourceChanged && !stale.length) return [];
      if (!match(key, [...m.values()].map((r) => r.value))) return [];
      const updated = present.reduce<Date | null>((d, r) => (!d || r.updatedAt > d ? r.updatedAt : d), null);
      return [
        {
          key,
          values: Object.fromEntries(present.map((r) => [r.locale, r.value])),
          status: Object.fromEntries(present.map((r) => [r.locale, r.status])),
          versions: Object.fromEntries(present.map((r) => [r.locale, r.version])),
          sourceHash: srcHash,
          sourceChanged: stale.length > 0,
          sourceChangedLocales: stale,
          ...(updated ? { updatedAt: iso(updated) } : {}),
        },
      ];
    });
    const pq = { cursor: q.cursor, limit: Math.min(500, q.limit ?? 100) };
    const page =
      q.sort === 'updatedAt' || q.order === 'desc'
        ? sortedPage(rows, { value: (r) => (q.sort === 'updatedAt' ? r.updatedAt : r.key), tie: (r) => r.key, order: q.order }, pq)
        : pageArray(rows.sort((a, b) => (a.key < b.key ? -1 : 1)), pq, (r) => r.key);
    return page;
  });

  reg(app, deps, 'adminStringsPatch', async (ctx) => {
    const b = ctx.body as { items: (StringEdit & { version?: number; sourceHash?: string })[] };
    // v0.3.0 preconditions: checked for every item before anything is written.
    const guarded = b.items.filter((i) => i.version !== undefined || i.sourceHash !== undefined);
    if (guarded.length) {
      const cur = new Map((await repo.getStrings([...new Set(guarded.map((i) => i.key))])).map((r) => [`${r.key}\u0000${r.locale}`, r]));
      for (const i of guarded) {
        const row = cur.get(`${i.key}\u0000${i.locale}`);
        if (i.version !== undefined && (row?.version ?? 0) !== i.version) fail('version_mismatch', { detail: `${i.key} (${i.locale}): version ${row?.version ?? 0}` });
        if (i.sourceHash !== undefined) {
          const src = cur.get(`${i.key}\u0000${SOURCE_LANG}`);
          if (src && sourceHash(src.value) !== i.sourceHash) fail('version_mismatch', { detail: `${i.key}: source changed` });
        }
      }
    }
    const r = await apply(ctx, b.items);
    if (r.unknownKeys.length) fail('validation_failed', { detail: `unknown keys: ${r.unknownKeys.slice(0, 10).join(', ')}` });
    if (r.errors.length) fail('validation_failed', { detail: r.errors[0].message });
    return { ok: true as const };
  });

  reg(
    app,
    deps,
    'adminStringsImport',
    async (ctx) => {
      const b = ctx.body as { format: 'csv' | 'xliff'; locale: Lang; content: string; status?: I18nStatus };
      const status = b.status ?? 'draft';
      const edits: StringEdit[] = [];
      const errors: ApplyResult['errors'] = [];
      if (b.format === 'csv') {
        const rows = parseCsv(b.content);
        rows.forEach((r, i) => {
          if (i === 0 && r[0]?.toLowerCase() === 'key') return;
          if (r.length < 2) errors.push({ line: i + 1, message: 'expected key,source,target' });
          else edits.push({ key: r[0], locale: b.locale, value: r.length >= 3 ? r[2] : r[1], status, line: i + 1, explicitStatus: b.status !== undefined });
        });
      } else {
        try {
          parseXliff(b.content).forEach((u) => edits.push({ key: u.id, locale: b.locale, value: u.target, status, explicitStatus: b.status !== undefined }));
        } catch (e) {
          fail('validation_failed', { detail: e instanceof Error ? e.message : 'invalid xliff' });
        }
      }
      // Empty targets are skipped (they would wipe a translation).
      const res = await apply(ctx, edits.filter((e) => e.value !== ''));
      return { ...res, errors: [...errors, ...res.errors] };
    },
    { bodyLimit: 6 * 1024 * 1024 },
  );

  reg(app, deps, 'adminStringsExport', async (ctx) => {
    const q = ctx.query as { format: 'csv' | 'xliff'; locale: Lang; source?: Lang };
    const source = q.source ?? SOURCE_LANG;
    let rows = (await repo.listStrings({ locale: q.locale }, { limit: 1_000_000 })).items;
    if (flag(ctx, 'untranslated')) rows = rows.filter((r) => !r.value.trim());
    const src = new Map((await repo.listStrings({ locale: source }, { limit: 1_000_000 })).items.map((r) => [r.key, r.value]));
    const units = rows.map((r) => ({ id: r.key, source: src.get(r.key) ?? '', target: r.value }));
    const stamp = iso(clock.now()).slice(0, 10);
    if (q.format === 'csv') {
      return { body: '﻿' + toCsv([['key', 'source', 'target'], ...units.map((u) => [u.id, u.source, u.target])]), contentType: 'text/csv; charset=utf-8', filename: `bilig-${q.locale}-${stamp}.csv` };
    }
    return { body: toXliff(units, source, q.locale), contentType: 'application/xliff+xml; charset=utf-8', filename: `bilig-${q.locale}-${stamp}.xlf` };
  });
}
