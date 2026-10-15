/**
 * Content repository (TZ §4 «Для масштаба»: catalog & packages are data).
 *
 * MVP: built packages are JSON files under `content/packages/*.json`, validated
 * with `validatePackage` (schema + cross-references) at load. The catalog base
 * (groups, subjects, courses, units) is `content/catalog.json`; topic summaries
 * are derived from the packages, so adding a topic is a data change only.
 * Later this reads Build artifacts produced by the admin + worker pipeline.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CatalogSchema,
  assertValidPackage,
  summarizeTopic,
  type Catalog,
  type ContentPackage,
  type Manifest,
} from '@bilig/content-model';

const CONTENT_DIR = fileURLToPath(new URL('../content/', import.meta.url));

export interface ContentRepo {
  catalog(): Catalog;
  getPackage(topicKey: string): ContentPackage | undefined;
  getManifest(topicKey: string): Manifest | undefined;
}

/** Load and validate all packages + the catalog base from a content directory. */
export function loadContentRepo(dir: string = CONTENT_DIR): ContentRepo {
  const pkgDir = join(dir, 'packages');
  const packages = new Map<string, ContentPackage>();
  for (const file of readdirSync(pkgDir).filter((f) => f.endsWith('.json')).sort()) {
    const pkg = assertValidPackage(JSON.parse(readFileSync(join(pkgDir, file), 'utf8')));
    packages.set(pkg.topic.key, pkg);
  }
  const base = CatalogSchema.omit({ topics: true }).parse(
    JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')),
  );
  const catalog: Catalog = {
    ...base,
    topics: [...packages.values()]
      .filter((p) => p.topic.status === 'published')
      .map(summarizeTopic),
  };
  return {
    catalog: () => catalog,
    getPackage: (key) => packages.get(key),
    getManifest: (key) => packages.get(key)?.manifest,
  };
}
