/**
 * Admin: 3D assets (A-05). Upload registers metadata (licence, author and
 * source are mandatory) and returns presigned multipart URLs from the object
 * storage (empty on local disk). Processing is a STUB until bilig_worker
 * exists: it marks the asset ready and reports size/budget violations only
 * (no meshopt/KTX2, no node tree, no thumbnail).
 */
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { pageOf } from '../../repo/paging.js';
import type { AssetRec } from '../../repo/types.js';
import { PACKAGE_BUDGET_BYTES } from '../../services/publishing.js';
import { reg } from './util.js';

export const PART_SIZE = 16 * 1024 * 1024;

const slug = (filename: string) =>
  filename
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'asset';

export const toAssetReport = (a: AssetRec) => ({
  id: a.id,
  key: a.key,
  status: a.status,
  sizeBefore: a.sizeBytes,
  ...(a.sizeAfter !== null ? { sizeAfter: a.sizeAfter } : {}),
  ...(a.triangles !== null ? { triangles: a.triangles } : {}),
  nodes: a.nodes,
  violations: a.violations,
  ...(a.thumbUrl ? { thumbUrl: a.thumbUrl } : {}),
});

export function registerAssetAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, storage } = deps;

  reg(app, deps, 'adminAssetUpload', async (ctx) => {
    const b = ctx.body as { filename: string; kind: AssetRec['kind']; size: number; contentType: string; license: string; author: string; source: string };
    const id = newId();
    const parts = Math.max(1, Math.ceil(b.size / PART_SIZE));
    const up = await storage.presignMultipart(`assets/${id}/original`, parts);
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
      createdAt: clock.now(),
    };
    await repo.createAsset(rec);
    return { assetId: id, uploadId: up.uploadId, partSize: PART_SIZE, partUrls: up.partUrls };
  });

  reg(app, deps, 'adminAssetGet', async (ctx) => {
    const a = await repo.getAsset(ctx.params.id);
    if (!a) fail('not_found', { detail: 'asset' });
    return toAssetReport(a);
  });

  reg(app, deps, 'adminAssetList', async (ctx) => {
    const res = await repo.listAssets(pageOf(ctx.query as { cursor?: string; limit?: number }));
    return { items: res.items.map(toAssetReport), nextCursor: res.nextCursor };
  });

  // STUB processing report (validation / meshopt / KTX2 / thumbnail run in bilig_worker later).
  reg(app, deps, 'adminAssetProcess', async (ctx) => {
    const a = await repo.getAsset(ctx.params.id);
    if (!a) fail('not_found', { detail: 'asset' });
    const violations: string[] = [];
    if (a.kind === 'glb' && a.sizeBytes > PACKAGE_BUDGET_BYTES) violations.push(`size ${a.sizeBytes} B exceeds the ${PACKAGE_BUDGET_BYTES} B package budget`);
    const next = await repo.updateAsset(a.id, { status: 'ready', sizeAfter: a.sizeBytes, violations, nodes: [] });
    return toAssetReport(next!);
  });
}
