/**
 * Decks (TZ §9 Decks, W-51/W-52): teacher presentations (CRUD with If-Match
 * optimistic locking), PPTX/PDF export, 3D snapshots (image + SceneState).
 * Everything is owner-only: another user's presentation or snapshot is 404.
 */
import type { FastifyInstance } from 'fastify';
import type { Presentation, Slide, SnapshotResponse } from '@bilig/content-model/api';
import { newId } from '../ids.js';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import type { PresentationRec, SnapshotRec } from '../repo/types.js';
import { llmSlides, templateSlides } from '../services/slides.js';
import { renderPptx } from '../export/pptx.js';
import { renderDeckPdf } from '../export/deck-pdf.js';
import type { DeckImage } from '../export/deck-types.js';
import { pageOf } from '../repo/paging.js';

const iso = (d: Date) => d.toISOString();

export const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const SNAPSHOTS_PER_HOUR = 120;
const EXPORT_TTL_MS = 24 * 3600 * 1000;

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;
type ImageKind = keyof typeof EXT;

/** Verify the decoded bytes really are the declared image type. */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Decode a `data:image/<type>;base64,…` URI with size and magic-byte checks. */
export function decodeImageDataUri(uri: string): { kind: ImageKind; body: Buffer } {
  const m = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=\r\n]*)$/.exec(uri);
  if (!m) fail('validation_failed', { detail: 'image must be a base64 data URI' });
  const b64 = m[2].replace(/[\r\n]/g, '');
  if (Math.floor((b64.length * 3) / 4) > SNAPSHOT_MAX_BYTES + 3) fail('payload_too_large', { detail: `image > ${SNAPSHOT_MAX_BYTES} bytes` });
  const body = Buffer.from(b64, 'base64');
  if (body.length > SNAPSHOT_MAX_BYTES) fail('payload_too_large', { detail: `image > ${SNAPSHOT_MAX_BYTES} bytes` });
  const kind = sniffImage(body);
  if (!kind || kind !== (m[1] as ImageKind)) fail('validation_failed', { detail: 'image content does not match its type' });
  return { kind, body };
}

const toPresentationDto = (p: PresentationRec): Presentation => ({
  id: p.id,
  ownerId: p.ownerId,
  topicKey: p.topicKey,
  title: p.title,
  lang: p.lang,
  slides: p.slides as Slide[],
  updatedAt: iso(p.updatedAt),
  version: p.version,
});

const toSnapshotDto = (s: SnapshotRec): SnapshotResponse => ({
  id: s.id,
  topicKey: s.topicKey,
  topicVersion: s.topicVersion,
  imageUrl: s.imageUrl,
  sceneState: s.sceneState as SnapshotResponse['sceneState'],
  createdAt: iso(s.createdAt),
});

const snapshotIdsOf = (slides: readonly Slide[]) => [...new Set(slides.flatMap((s) => ('snapshotId' in s && s.snapshotId ? [s.snapshotId] : [])))];

export function registerDecks(app: FastifyInstance, deps: Deps) {
  const { repo, clock, content, storage, limiter, config } = deps;

  async function own(uid: string, id: string): Promise<PresentationRec> {
    const p = await repo.getPresentation(id);
    if (!p || p.ownerId !== uid) fail('not_found', { detail: 'presentation' });
    return p;
  }

  /** Every snapshot a slide references must belong to the owner. */
  async function checkSnapshots(uid: string, slides: readonly Slide[]) {
    const ids = snapshotIdsOf(slides);
    if (!ids.length) return;
    const found = await repo.getSnapshots(ids);
    if (found.length !== ids.length || found.some((s) => s.ownerId !== uid)) fail('validation_failed', { detail: 'unknown snapshotId' });
  }

  route(app, deps, 'presentationList', async ({ userId, query }) => {
    const res = await repo.listPresentations(userId(), pageOf(query));
    return {
      items: res.items.map((p) => {
        const { slides: _s, ...rest } = toPresentationDto(p);
        return rest;
      }),
      nextCursor: res.nextCursor,
    };
  });

  route(app, deps, 'presentationCreate', async ({ userId, auth, body }) => {
    const uid = userId();
    const pub = await content.getPublished(body.topicKey);
    if (!pub) fail('not_found', { detail: 'topic' });
    const verdict = await content.canOpen(auth, pub);
    if (verdict !== 'ok') fail(verdict, { detail: 'license_required' });
    let slides: Slide[];
    if (body.slides) {
      await checkSnapshots(uid, body.slides);
      slides = body.slides;
    } else if (body.mode === 'llm') {
      slides = (await llmSlides(deps.tutor, config.tutorModel, pub.build.pkg, body.lang)).slides;
    } else {
      slides = templateSlides(pub.build.pkg, body.lang);
    }
    const now = clock.now();
    const rec: PresentationRec = { id: newId(), ownerId: uid, topicKey: body.topicKey, title: body.title, lang: body.lang, slides, version: 1, createdAt: now, updatedAt: now };
    await repo.createPresentation(rec);
    return toPresentationDto(rec);
  });

  route(app, deps, 'presentationGet', async ({ userId, params }) => toPresentationDto(await own(userId(), params.id)));

  route(app, deps, 'presentationPatch', async ({ userId, params, body, ifMatch }) => {
    const uid = userId();
    const cur = await own(uid, params.id);
    if (ifMatch !== body.version || cur.version !== ifMatch) fail('version_mismatch', { detail: `current version is ${cur.version}` });
    if (body.slides) await checkSnapshots(uid, body.slides);
    const patch: Partial<Pick<PresentationRec, 'title' | 'slides'>> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.slides !== undefined) patch.slides = body.slides;
    const res = await repo.updatePresentation(cur.id, patch, ifMatch);
    if (res === 'not_found') fail('not_found', { detail: 'presentation' });
    if (res === 'version_mismatch') fail('version_mismatch');
    return toPresentationDto(res);
  });

  route(app, deps, 'presentationDelete', async ({ userId, params }) => {
    const p = await own(userId(), params.id);
    await repo.deletePresentation(p.id);
    return { ok: true as const };
  });

  route(app, deps, 'presentationExport', async ({ userId, params, query }) => {
    const uid = userId();
    const p = await own(uid, params.id);
    const r = await limiter.hit(`export:${uid}`, 30, 3600);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
    const slides = p.slides as Slide[];
    const images = new Map<string, DeckImage>();
    for (const s of await repo.getSnapshots(snapshotIdsOf(slides))) {
      if (s.ownerId !== p.ownerId) continue;
      const obj = await storage.get(s.imageKey);
      if (obj) images.set(s.id, obj);
    }
    const input = { title: p.title, slides, images };
    const jobId = newId();
    const body = query.format === 'pptx' ? await renderPptx(input) : await renderDeckPdf(input);
    const contentType = query.format === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/pdf';
    const { url } = await storage.put(`exports/${uid}/${jobId}.${query.format}`, body, contentType);
    return { jobId, status: 'done' as const, url, expiresAt: iso(new Date(clock.now().getTime() + EXPORT_TTL_MS)) };
  });

  route(
    app,
    deps,
    'snapshotCreate',
    async ({ userId, body }) => {
      const uid = userId();
      const r = await limiter.hit(`snapshot:${uid}`, SNAPSHOTS_PER_HOUR, 3600);
      if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
      if (body.sceneState.topicKey !== body.topicKey) fail('validation_failed', { detail: 'sceneState.topicKey' });
      const topic = await repo.getTopicByKey(body.topicKey);
      const ver = topic ? await repo.getTopicVersionBySemver(topic.id, body.topicVersion) : null;
      const build = ver ? await repo.readyBuildForVersion(ver.id) : null;
      if (!build) fail('not_found', { detail: 'topic_version' });
      const img = decodeImageDataUri(body.image);
      const id = newId();
      const imageKey = `snapshots/${uid}/${id}.${EXT[img.kind]}`;
      const { url } = await storage.put(imageKey, img.body, `image/${img.kind}`);
      const rec: SnapshotRec = { id, ownerId: uid, topicKey: body.topicKey, topicVersion: body.topicVersion, imageKey, imageUrl: url, sceneState: body.sceneState, createdAt: clock.now() };
      await repo.createSnapshot(rec);
      return toSnapshotDto(rec);
    },
    { bodyLimit: 8 * 1024 * 1024 },
  );

  route(app, deps, 'snapshotGet', async ({ userId, params }) => {
    const s = await repo.getSnapshot(params.id);
    if (!s || s.ownerId !== userId()) fail('not_found', { detail: 'snapshot' });
    return toSnapshotDto(s);
  });
}
