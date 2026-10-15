/**
 * Object storage interface (snapshots, exports, assets). Local disk in dev,
 * memory in tests; an S3/MinIO adapter implements the same interface later
 * (TZ §7: MinIO keeps data in KR).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ObjectStorage {
  readonly kind: 'memory' | 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<{ url: string }>;
  get(key: string): Promise<StoredObject | null>;
  /** Presigned multipart upload URLs; empty for backends that do not support direct upload. */
  presignMultipart(key: string, parts: number): Promise<{ uploadId: string; partUrls: string[] }>;
}

/** Keys are `a-z0-9/._-` only, no `..` — never derived from user input without this check. */
export function assertSafeKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,300}$/.test(key) || key.split('/').includes('..')) {
    throw new Error('unsafe storage key');
  }
}

export class MemoryStorage implements ObjectStorage {
  readonly kind = 'memory' as const;
  readonly objects = new Map<string, StoredObject>();
  constructor(private baseUrl: string) {}
  async put(key: string, body: Buffer, contentType: string) {
    assertSafeKey(key);
    this.objects.set(key, { body, contentType });
    return { url: `${this.baseUrl}/files/${key}` };
  }
  async get(key: string) {
    assertSafeKey(key);
    return this.objects.get(key) ?? null;
  }
  async presignMultipart() {
    return { uploadId: 'memory', partUrls: [] };
  }
}

export class LocalDiskStorage implements ObjectStorage {
  readonly kind = 'local' as const;
  constructor(private dir: string, private baseUrl: string) {}
  private path(key: string) {
    assertSafeKey(key);
    const p = normalize(join(this.dir, key));
    if (!p.startsWith(normalize(this.dir) + sep) && p !== normalize(this.dir)) throw new Error('unsafe storage key');
    return p;
  }
  async put(key: string, body: Buffer, contentType: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
    await writeFile(p + '.meta', JSON.stringify({ contentType }));
    return { url: `${this.baseUrl}/files/${key}` };
  }
  async get(key: string) {
    const p = this.path(key);
    try {
      const [body, meta] = await Promise.all([readFile(p), readFile(p + '.meta', 'utf8')]);
      return { body, contentType: (JSON.parse(meta) as { contentType: string }).contentType };
    } catch {
      return null;
    }
  }
  async presignMultipart() {
    // Local disk has no presigned upload; the admin falls back to the S3 adapter in staging.
    return { uploadId: 'local', partUrls: [] };
  }
}
