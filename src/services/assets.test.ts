import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssetStore } from './assets.js';

const sha = (b: string) => createHash('sha256').update(b).digest('hex');

describe('AssetStore', () => {
  it('finds files by content hash and ignores non-asset files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assets-'));
    writeFileSync(join(dir, 'a.glb'), 'model-a');
    writeFileSync(join(dir, 'ASSET.json'), '{}');
    const store = new AssetStore(dir);
    expect(store.get(sha('model-a'))?.contentType).toBe('model/gltf-binary');
    expect(store.get(sha('{}'))).toBeNull();
  });

  it('serves a model rebuilt while the server runs (re-reads the folder on a miss)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assets-'));
    writeFileSync(join(dir, 'm.glb'), 'v1');
    let now = 0;
    const store = new AssetStore(dir, 5_000, () => now);
    expect(store.get(sha('v1'))).not.toBeNull();
    writeFileSync(join(dir, 'm.glb'), 'v2');
    // Within the window a miss does not touch the disk again.
    now = 1_000;
    expect(store.get(sha('v2'))).toBeNull();
    now = 10_000;
    expect(store.get(sha('v2'))?.size).toBe(2);
    expect(store.get(sha('v1'))).toBeNull();
  });
});
