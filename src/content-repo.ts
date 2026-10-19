/**
 * Read-only view of content/** straight from disk (packages validated with
 * validatePackage at load). Used by content checks and tooling; the server
 * itself reads published Builds through the Repository (see services/seed.ts).
 */
import { filterTextbookTopics, summarizeTopic, type Catalog, type ContentPackage, type Manifest } from '@bilig/content-model';
import { DEFAULT_CONTENT_DIR, loadContentDir } from './services/seed.js';

export interface ContentRepo {
  catalog(): Catalog;
  getPackage(topicKey: string): ContentPackage | undefined;
  getManifest(topicKey: string): Manifest | undefined;
}

export function loadContentRepo(dir: string = DEFAULT_CONTENT_DIR): ContentRepo {
  const { base, packages } = loadContentDir(dir);
  const byKey = new Map(packages.map((p) => [p.topic.key, p]));
  const topics = packages.filter((p) => p.topic.status === 'published').map(summarizeTopic);
  const published = new Set(topics.map((t) => t.key));
  // v0.5.0: textbook lessons list published topics only (as the API does).
  const catalog: Catalog = {
    ...base,
    topics,
    ...(base.textbooks ? { textbooks: base.textbooks.map((tb) => filterTextbookTopics(tb, (k) => published.has(k))) } : {}),
  };
  return {
    catalog: () => catalog,
    getPackage: (key) => byKey.get(key),
    getManifest: (key) => byKey.get(key)?.manifest,
  };
}
