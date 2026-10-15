/**
 * Dev / offline-server stand-in for the CDN behind `filesBaseUrl`
 * (`<publicUrl>/cdn/<packageHash>/<path>`, used when CDN_BASE_URL is unset):
 * serves the binary files listed in a published topic's `manifest.files`
 * (GLB models, thumbnails) from content/assets/**.
 *
 * Like the CDN it replaces, these are public, hash-addressed, immutable
 * files: the licence gate is on the manifest (`/topics/:key/manifest`), which
 * is the only way to learn the package hash. Asset loaders (GLTFLoader,
 * <img>) send no Authorization header, so the files cannot be gated here.
 * `package.json` is never served from here: the package goes through the
 * gated API route.
 */
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { sendProblem } from '../http/errors.js';
import { AssetStore } from '../services/assets.js';
import { DEFAULT_CONTENT_DIR } from '../services/seed.js';

const HASH_RE = /^[a-f0-9]{64}$/;

export function registerCdn(
  app: FastifyInstance,
  deps: Deps,
  store = new AssetStore(
    join(deps.config.contentDir ?? DEFAULT_CONTENT_DIR, 'assets'),
  ),
) {
  app.get('/cdn/:hash/*', async (req, reply) => {
    const { hash, '*': path } = req.params as { hash: string; '*': string };
    if (!HASH_RE.test(hash) || !path || path === 'package.json')
      return sendProblem(reply, 'not_found');
    const pub = await deps.content.getPublishedByHash(hash);
    // Only paths the manifest lists, and only real files (placeholders have size 0).
    const entry = pub?.build.manifest.files.find(
      (f) => f.path === path && f.size > 0,
    );
    const asset = entry ? store.get(entry.hash) : null;
    if (!entry || !asset || asset.size !== entry.size)
      return sendProblem(reply, 'not_found');

    const etag = `"${entry.hash}"`;
    reply
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff')
      // the client app may live on another site than the API in production
      .header('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply
      .type(asset.contentType)
      .header('Content-Length', asset.size)
      .send(createReadStream(asset.file));
  });
}
