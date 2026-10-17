/**
 * Content-addressed view of content/assets/** (GLB models, thumbnails): every
 * file is indexed by its sha256, which is exactly the hash content/build.mjs
 * writes into `manifest.files[]`. The CDN stand-in serves a manifest entry by
 * that hash, so a file is found wherever it lives and a stale file can never
 * be served under a new hash. Indexed lazily, once per process.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Media types the asset pipeline produces; anything else in the folder (ASSET.json, CREDITS.md) is not served. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export interface AssetFile {
  /** Absolute path on disk. */
  file: string;
  size: number;
  contentType: string;
}

export class AssetStore {
  private index: Map<string, AssetFile> | null = null;
  private scannedAt = 0;

  /**
   * `rescanAfterMs`: a miss re-reads the folder when the index is at least this
   * old, so a model rebuilt while the server runs (asset pipeline, re-seed) is
   * served without a restart. Misses are rare (only paths a manifest lists
   * get here), so this costs nothing in normal operation.
   */
  constructor(
    private readonly dir: string,
    private readonly rescanAfterMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The file whose sha256 is `hash`, or null. */
  get(hash: string): AssetFile | null {
    if (!this.index) this.rebuild();
    const hit = this.index!.get(hash);
    if (hit || this.now() - this.scannedAt < this.rescanAfterMs) return hit ?? null;
    this.rebuild();
    return this.index!.get(hash) ?? null;
  }

  private rebuild(): void {
    this.index = this.scan();
    this.scannedAt = this.now();
  }

  /** Forget the index (tests, or after the asset folder changed). */
  reset(): void {
    this.index = null;
  }

  private scan(): Map<string, AssetFile> {
    const out = new Map<string, AssetFile>();
    if (!existsSync(this.dir)) return out;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          const contentType = ASSET_TYPES[extname(e.name).toLowerCase()];
          if (!contentType) continue;
          const bytes = readFileSync(p);
          out.set(createHash('sha256').update(bytes).digest('hex'), {
            file: p,
            size: bytes.length,
            contentType,
          });
        }
      }
    };
    walk(this.dir);
    return out;
  }
}
