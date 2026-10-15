import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fixtureContent,
  demoPackage,
  makeTestApp,
  type TestCtx,
} from '../../test/helpers.js';
import { importContent, loadContentDir } from '../../services/seed.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let t: TestCtx | null = null;
let dir: string | null = null;
afterEach(async () => {
  await t?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  t = null;
  dir = null;
});

describe('cdn stand-in (/cdn/<packageHash>/<path>)', () => {
  it('serves manifest files by hash, immutable, and nothing else', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bilig-cdn-'));
    const bytes = Buffer.from('glTF fake model bytes');
    mkdirSync(join(dir, 'assets', 'demo-cell', 'models'), { recursive: true });
    writeFileSync(
      join(dir, 'assets', 'demo-cell', 'models', 'cell.glb'),
      bytes,
    );
    writeFileSync(join(dir, 'assets', 'demo-cell', 'ASSET.json'), '{}');
    const pkg = demoPackage();
    const pkgHash = 'ab'.repeat(32);
    pkg.manifest.hash = pkgHash;
    pkg.manifest.files = [
      { path: 'models/cell.glb', hash: sha256(bytes), size: bytes.length },
      {
        path: 'thumbs/pending.webp',
        hash: sha256(Buffer.from('pending:thumbs/pending.webp')),
        size: 0,
      },
    ];
    t = await makeTestApp({ seed: false, config: { contentDir: dir } });
    await importContent(
      t.repo,
      t.clock,
      { base: fixtureContent().base, packages: [pkg] },
      t.deps.config,
    );
    t.deps.content.invalidate();

    const r = await t.inject({
      method: 'GET',
      url: `/cdn/${pkgHash}/models/cell.glb`,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.rawPayload.equals(bytes)).toBe(true);
    expect(r.headers['content-type']).toBe('model/gltf-binary');
    expect(r.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(r.headers.etag).toBe(`"${sha256(bytes)}"`);
    expect(Number(r.headers['content-length'])).toBe(bytes.length);

    const again = await t.inject({
      method: 'GET',
      url: `/cdn/${pkgHash}/models/cell.glb`,
      headers: { 'if-none-match': `"${sha256(bytes)}"` },
    });
    expect(again.statusCode).toBe(304);

    for (const url of [
      `/cdn/${'cd'.repeat(32)}/models/cell.glb`, // unknown package
      `/cdn/${pkgHash}/models/other.glb`, // not in the manifest
      `/cdn/${pkgHash}/thumbs/pending.webp`, // placeholder entry
      `/cdn/${pkgHash}/package.json`, // packages go through the gated API
      `/cdn/${pkgHash}/ASSET.json`,
      `/cdn/${pkgHash}/../demo-cell/ASSET.json`,
      `/cdn/not-a-hash/models/cell.glb`,
    ]) {
      expect((await t.inject({ method: 'GET', url })).statusCode, url).toBe(
        404,
      );
    }
  });

  it('serves the real content assets under the manifest filesBaseUrl', async () => {
    const content = loadContentDir();
    t = await makeTestApp({ seed: false });
    await importContent(t.repo, t.clock, content, t.deps.config);
    t.deps.content.invalidate();
    const withAssets = content.packages.filter((p) =>
      p.manifest.files.some((f) => f.size > 0),
    );
    expect(withAssets.map((p) => p.topic.key)).toEqual(
      expect.arrayContaining(['human-heart', 'earth-layers']),
    );
    for (const pkg of withAssets) {
      const total = pkg.manifest.files.reduce((n, f) => n + f.size, 0);
      expect(total, pkg.topic.key).toBeLessThanOrEqual(5 * 1024 * 1024); // TZ §10 package budget
      for (const f of pkg.manifest.files.filter((x) => x.size > 0)) {
        const r = await t.inject({
          method: 'GET',
          url: `/cdn/${pkg.manifest.hash}/${f.path}`,
        });
        expect(r.statusCode, `${pkg.topic.key}/${f.path}`).toBe(200);
        expect(sha256(r.rawPayload)).toBe(f.hash);
      }
    }
  });
});
