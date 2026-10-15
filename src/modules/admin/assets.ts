/**
 * Admin: 3D assets (A-05). Upload registers metadata (licence, author and
 * source are mandatory) and returns presigned multipart URLs from the object
 * storage (empty on local disk). Processing is a STUB until bilig_worker
 * exists: it marks the asset ready and reports size/budget violations only
 * (no meshopt/KTX2, no node tree, no thumbnail).
 *
 * v0.3.0: every upload is an AssetVersion (the Asset row mirrors the current
 * one); a new file for the same asset is a new version; multipart uploads are
 * finished with POST /complete; DELETE refuses while a topic references the
 * asset (its key in `scene.asset` or in a `rights[].covers` entry).
 */
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { pageOf, sortedPage, type SortValue } from '../../repo/paging.js';
import type { AssetRec, AssetVersionRec } from '../../repo/types.js';
import { PACKAGE_BUDGET_BYTES } from '../../services/publishing.js';
import type { ObjectStorage } from '../../services/storage.js';
import { iso, reg, topicsWhere } from './util.js';

export const PART_SIZE = 16 * 1024 * 1024;

/** Storages with presigned multipart uploads also finish them (the S3 adapter). */
type MultipartStorage = ObjectStorage & {
  completeMultipart?(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
};

const slug = (filename: string) =>
  filename
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'asset';

const originalKey = (id: string, version: number) => (version === 1 ? `assets/${id}/original` : `assets/${id}/v${version}/original`);

export const toAssetReport = (a: AssetRec, current?: AssetVersionRec | null) => ({
  id: a.id,
  key: a.key,
  status: a.status,
  sizeBefore: a.sizeBytes,
  ...(a.sizeAfter !== null ? { sizeAfter: a.sizeAfter } : {}),
  ...(a.triangles !== null ? { triangles: a.triangles } : {}),
  nodes: a.nodes,
  violations: a.violations,
  ...(a.thumbUrl ? { thumbUrl: a.thumbUrl } : {}),
  filename: a.filename,
  kind: a.kind,
  contentType: a.contentType,
  license: a.license,
  author: a.author,
  source: a.source,
  createdAt: iso(a.createdAt),
  createdBy: a.createdBy,
  version: a.version ?? 1,
  ...(current?.completedAt ? { completedAt: iso(current.completedAt) } : {}),
});

/** Version 1 for assets stored before versions existed (or created elsewhere without one). */
const legacyVersion = (a: AssetRec): AssetVersionRec => ({
  assetId: a.id,
  version: a.version ?? 1,
  filename: a.filename,
  contentType: a.contentType,
  status: a.status,
  sizeBytes: a.sizeBytes,
  sizeAfter: a.sizeAfter,
  triangles: a.triangles,
  nodes: a.nodes,
  violations: a.violations,
  originalUrl: a.originalUrl,
  optimizedUrl: a.optimizedUrl,
  thumbUrl: a.thumbUrl,
  uploadId: a.uploadId,
  message: null,
  createdBy: a.createdBy,
  createdAt: a.createdAt,
  completedAt: null,
});

const toVersionDto = (v: AssetVersionRec, currentVersion: number) => ({
  assetId: v.assetId,
  version: v.version,
  filename: v.filename,
  contentType: v.contentType,
  status: v.status,
  sizeBefore: v.sizeBytes,
  ...(v.sizeAfter !== null ? { sizeAfter: v.sizeAfter } : {}),
  ...(v.triangles !== null ? { triangles: v.triangles } : {}),
  nodes: v.nodes,
  violations: v.violations,
  ...(v.thumbUrl ? { thumbUrl: v.thumbUrl } : {}),
  ...(v.message ? { message: v.message } : {}),
  createdAt: iso(v.createdAt),
  createdBy: v.createdBy,
  ...(v.completedAt ? { completedAt: iso(v.completedAt) } : {}),
  current: v.version === currentVersion,
});

export function registerAssetAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, storage, audit } = deps;

  async function load(id: string): Promise<AssetRec> {
    const a = await repo.getAsset(id);
    if (!a) fail('not_found', { detail: 'asset' });
    return a;
  }
  async function versionsOf(a: AssetRec): Promise<AssetVersionRec[]> {
    const vs = await repo.listAssetVersions(a.id);
    return vs.length ? vs : [legacyVersion(a)];
  }
  async function currentOf(a: AssetRec): Promise<AssetVersionRec> {
    const vs = await versionsOf(a);
    return vs.find((v) => v.version === (a.version ?? 1)) ?? vs[vs.length - 1];
  }
  /** Write a patch to the current version row (created from the asset row when missing). */
  async function updateCurrent(a: AssetRec, patch: Partial<AssetVersionRec>): Promise<AssetVersionRec> {
    const version = a.version ?? 1;
    const updated = (await repo.updateAssetVersion(a.id, version, patch)) ?? (await repo.createAssetVersion({ ...legacyVersion(a), ...patch }));
    return updated === 'conflict' ? { ...legacyVersion(a), ...patch } : updated;
  }

  reg(app, deps, 'adminAssetUpload', async (ctx) => {
    const b = ctx.body as { filename: string; kind: AssetRec['kind']; size: number; contentType: string; license: string; author: string; source: string };
    const id = newId();
    const parts = Math.max(1, Math.ceil(b.size / PART_SIZE));
    const up = await storage.presignMultipart(originalKey(id, 1), parts);
    const now = clock.now();
    const rec: AssetRec = {
      id,
      key: `${slug(b.filename)}-${id.slice(-6)}`,
      kind: b.kind,
      filename: b.filename,
      contentType: b.contentType,
      license: b.license,
      author: b.author,
      source: b.source,
      status: 'uploaded',
      sizeBytes: b.size,
      sizeAfter: null,
      triangles: null,
      nodes: [],
      violations: [],
      originalUrl: null,
      optimizedUrl: null,
      thumbUrl: null,
      uploadId: up.uploadId,
      createdBy: ctx.auth.user!.id,
      createdAt: now,
      version: 1,
    };
    await repo.createAsset(rec);
    await repo.createAssetVersion(legacyVersion(rec));
    await audit.log(ctx.auth.user!.id, 'asset.uploaded', { type: 'asset', id }, { ip: ctx.ip, diff: { filename: b.filename, license: b.license, author: b.author, source: b.source } });
    return { assetId: id, uploadId: up.uploadId, partSize: PART_SIZE, partUrls: up.partUrls, version: 1 };
  });

  reg(app, deps, 'adminAssetGet', async (ctx) => {
    const a = await load(ctx.params.id);
    return toAssetReport(a, await currentOf(a));
  });

  reg(app, deps, 'adminAssetList', async (ctx) => {
    const q = ctx.query as { cursor?: string; limit?: number; q?: string; kind?: AssetRec['kind']; status?: AssetRec['status']; sort?: string; order?: 'asc' | 'desc' };
    if (!q.q && !q.kind && !q.status && !q.sort && q.order !== 'desc') {
      const res = await repo.listAssets(pageOf(q));
      return { items: res.items.map((a) => toAssetReport(a)), nextCursor: res.nextCursor };
    }
    const needle = q.q?.toLocaleLowerCase();
    const rows = (await repo.listAssets({ limit: 100_000 })).items.filter(
      (a) => (!needle || a.key.includes(needle) || a.filename.toLocaleLowerCase().includes(needle)) && (!q.kind || a.kind === q.kind) && (!q.status || a.status === q.status),
    );
    const value = (a: AssetRec): SortValue => {
      switch (q.sort ?? 'createdAt') {
        case 'createdAt':
          return a.id; // UUID v7 = creation order
        case 'sizeBefore':
          return a.sizeBytes;
        case 'violations':
          return a.violations.length;
        default:
          return (a as unknown as Record<string, SortValue>)[q.sort!];
      }
    };
    const res = sortedPage(rows, { value, tie: (a) => a.id, order: q.order }, pageOf(q));
    return { items: res.items.map((a) => toAssetReport(a)), nextCursor: res.nextCursor };
  });

  // STUB processing report (validation / meshopt / KTX2 / thumbnail run in bilig_worker later).
  reg(app, deps, 'adminAssetProcess', async (ctx) => {
    const a = await load(ctx.params.id);
    const violations: string[] = [];
    if (a.kind === 'glb' && a.sizeBytes > PACKAGE_BUDGET_BYTES) violations.push(`size ${a.sizeBytes} B exceeds the ${PACKAGE_BUDGET_BYTES} B package budget`);
    const patch = { status: 'ready' as const, sizeAfter: a.sizeBytes, violations, nodes: [] };
    const next = await repo.updateAsset(a.id, patch);
    const cur = await updateCurrent(a, patch);
    return toAssetReport(next!, cur);
  });

  // v0.3.0: finish a presigned multipart upload of the current version.
  reg(app, deps, 'adminAssetComplete', async (ctx) => {
    const a = await load(ctx.params.id);
    const b = ctx.body as { uploadId?: string; parts: { partNumber: number; etag: string }[] };
    const cur = await currentOf(a);
    if (b.uploadId && b.uploadId !== cur.uploadId) fail('conflict', { detail: 'upload_id_mismatch' });
    if (cur.completedAt) return toAssetReport(a, cur); // idempotent
    if (a.status !== 'uploaded') fail('conflict', { detail: `asset is ${a.status}` });
    const parts = [...b.parts].sort((x, y) => x.partNumber - y.partNumber);
    if (parts.some((p, i) => p.partNumber !== i + 1)) fail('validation_failed', { detail: 'parts must be numbered 1..n without gaps or duplicates' });
    const s = storage as MultipartStorage;
    if (s.completeMultipart) {
      const expected = Math.max(1, Math.ceil(cur.sizeBytes / PART_SIZE));
      if (parts.length !== expected) fail('validation_failed', { detail: `expected ${expected} parts` });
      await s.completeMultipart(originalKey(a.id, cur.version), cur.uploadId, parts);
    }
    const done = await updateCurrent(a, { completedAt: clock.now() });
    return toAssetReport(a, done);
  });

  reg(app, deps, 'adminAssetVersions', async (ctx) => {
    const a = await load(ctx.params.id);
    return { items: (await versionsOf(a)).map((v) => toVersionDto(v, a.version ?? 1)) };
  });

  // v0.3.0: a new file for an existing asset (same key) → version n+1 becomes current.
  reg(app, deps, 'adminAssetVersionCreate', async (ctx) => {
    const a = await load(ctx.params.id);
    const b = ctx.body as { filename: string; size: number; contentType: string; license?: string; author?: string; source?: string; message?: string };
    const stored = await repo.listAssetVersions(a.id);
    if (!stored.length) await repo.createAssetVersion(legacyVersion(a)); // persist the implicit v1 first
    const version = Math.max(a.version ?? 1, ...stored.map((v) => v.version)) + 1;
    const parts = Math.max(1, Math.ceil(b.size / PART_SIZE));
    const up = await storage.presignMultipart(originalKey(a.id, version), parts);
    const file = {
      filename: b.filename,
      contentType: b.contentType,
      status: 'uploaded' as const,
      sizeBytes: b.size,
      sizeAfter: null,
      triangles: null,
      nodes: [],
      violations: [],
      originalUrl: null,
      optimizedUrl: null,
      thumbUrl: null,
      uploadId: up.uploadId,
    };
    const created = await repo.createAssetVersion({ assetId: a.id, version, ...file, message: b.message ?? null, createdBy: ctx.auth.user!.id, createdAt: clock.now(), completedAt: null });
    if (created === 'conflict') fail('conflict', { detail: 'version exists' });
    await repo.updateAsset(a.id, {
      ...file,
      version,
      ...(b.license ? { license: b.license } : {}),
      ...(b.author ? { author: b.author } : {}),
      ...(b.source ? { source: b.source } : {}),
    });
    await audit.log(ctx.auth.user!.id, 'asset.version_created', { type: 'asset', id: a.id }, { ip: ctx.ip, diff: { version, filename: b.filename, message: b.message } });
    return { assetId: a.id, uploadId: up.uploadId, partSize: PART_SIZE, partUrls: up.partUrls, version };
  });

  reg(app, deps, 'adminAssetDelete', async (ctx) => {
    const a = await load(ctx.params.id);
    const used = await topicsWhere(deps, (d) => !!d.scene.asset?.includes(a.key) || !!d.rights?.some((r) => r.covers === a.key));
    if (used.length) fail('in_use', { detail: used.slice(0, 20).map((k) => `topic:${k}`).join(', ') });
    await repo.deleteAsset(a.id);
    await audit.log(ctx.auth.user!.id, 'asset.deleted', { type: 'asset', id: a.id }, { ip: ctx.ip, diff: { key: a.key, filename: a.filename } });
    return { ok: true as const };
  });
}
