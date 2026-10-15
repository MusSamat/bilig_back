/**
 * Import content/** into the repository as published TopicVersions + Builds
 * (`npm run db:seed`). Content packages are validated with validatePackage at
 * load; an invalid package aborts the import with its first errors.
 * Idempotent: re-running updates dictionary rows and skips existing versions.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CatalogSchema,
  LANGS,
  validatePackage,
  type ContentPackage,
  type PropertyTypeDef,
} from '@bilig/content-model';
import { newId } from '../ids.js';
import type { ContentKind, ContentKinds, LocaleStringWrite, Repository } from '../repo/types.js';
import { extractStrings, sourceHash, SOURCE_LANG } from '../domain/strings.js';
import type { Clock } from './clock.js';
import { toWrite } from './content-writes.js';
import { PROPERTY_TYPES_SETTING } from './publishing.js';

export const DEFAULT_CONTENT_DIR = fileURLToPath(new URL('../../content/', import.meta.url));

export interface LoadedContent {
  base: Omit<ReturnType<typeof CatalogSchema.parse>, 'topics'>;
  packages: ContentPackage[];
}

/** Read and validate content/catalog.json + content/packages/*.json. */
export function loadContentDir(dir: string = DEFAULT_CONTENT_DIR): LoadedContent {
  const base = CatalogSchema.omit({ topics: true }).parse(JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')));
  const pkgDir = join(dir, 'packages');
  const packages: ContentPackage[] = [];
  const errors: string[] = [];
  if (existsSync(pkgDir)) {
    for (const file of readdirSync(pkgDir).filter((f) => f.endsWith('.json')).sort()) {
      const res = validatePackage(JSON.parse(readFileSync(join(pkgDir, file), 'utf8')));
      if (!res.ok || !res.data) {
        const errs = res.issues.filter((i) => i.severity === 'error').slice(0, 5);
        errors.push(`${file}: ${errs.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      } else packages.push(res.data);
    }
  }
  if (errors.length) throw new Error(`Invalid content packages:\n${errors.join('\n')}`);
  return { base, packages };
}

async function upsert<K extends ContentKind>(repo: Repository, kind: K, key: string, data: ContentKinds[K]) {
  const w = await toWrite(repo, kind, key, data);
  const store = repo.content(kind);
  if ((await store.create(key, w, null)) === 'conflict') await store.update(key, w, null, null);
  return extractStrings(kind, key, data);
}

export interface SeedReport {
  subjects: number;
  topics: number;
  versionsCreated: number;
  strings: number;
}

export async function importContent(repo: Repository, clock: Clock, content: LoadedContent, opts: { publicUrl: string; cdnBaseUrl?: string; authorId?: string }): Promise<SeedReport> {
  const strings: ReturnType<typeof extractStrings> = [];
  const i18nStatus = new Map<string, NonNullable<ContentPackage['topic']['i18n']>>();
  for (const g of content.base.groups) strings.push(...(await upsert(repo, 'group', g.key, g)));
  for (const s of content.base.subjects) strings.push(...(await upsert(repo, 'subject', s.key, s)));
  for (const c of content.base.courses) strings.push(...(await upsert(repo, 'course', c.key, c)));
  for (const u of content.base.units) strings.push(...(await upsert(repo, 'unit', u.key, u)));

  const propertyTypes = new Map<string, PropertyTypeDef>();
  let versionsCreated = 0;
  for (const pkg of content.packages) {
    strings.push(...(await upsert(repo, 'subject', pkg.subject.key, pkg.subject)));
    if (pkg.course) strings.push(...(await upsert(repo, 'course', pkg.course.key, pkg.course)));
    if (pkg.unit) strings.push(...(await upsert(repo, 'unit', pkg.unit.key, pkg.unit)));
    for (const o of pkg.objectives ?? []) strings.push(...(await upsert(repo, 'objective', o.key, o)));
    for (const c of pkg.concepts) strings.push(...(await upsert(repo, 'concept', c.key, c)));
    for (const p of pkg.processes) strings.push(...(await upsert(repo, 'process', p.key, p)));
    for (const i of pkg.items) strings.push(...(await upsert(repo, 'item', i.key, i)));
    for (const g of pkg.glossary) await upsert(repo, 'glossary', g.id, g);
    for (const pt of pkg.propertyTypes ?? []) propertyTypes.set(pt.key, pt);

    const doc = pkg.topic;
    let topic = await repo.getTopicByKey(doc.key);
    if (!topic) {
      const created = await repo.createTopic({
        id: newId(),
        key: doc.key,
        unitKey: doc.unitKey,
        subjectKey: pkg.subject.key,
        status: 'draft',
        demo: doc.demo ?? false,
        publishedVersionId: null,
        latestVersionId: null,
        scheduledAt: null,
        scheduledVersionId: null,
      });
      if (created === 'conflict') throw new Error(`topic ${doc.key} conflict`);
      topic = created;
    }
    let ver = await repo.getTopicVersionBySemver(topic.id, pkg.manifest.version);
    if (!ver) {
      const v = await repo.createTopicVersion({
        id: newId(),
        topicId: topic.id,
        topicKey: doc.key,
        version: pkg.manifest.version,
        doc,
        authorId: opts.authorId ?? '00000000-0000-7000-8000-000000000000',
        createdAt: clock.now(),
        reviewState: 'published',
        message: 'seed import',
      });
      if (v === 'conflict') throw new Error(`version conflict ${doc.key}`);
      ver = v;
      versionsCreated++;
      await repo.createBuild({
        id: newId(),
        topicId: topic.id,
        topicKey: doc.key,
        topicVersionId: ver.id,
        version: ver.version,
        status: 'ready',
        manifest: pkg.manifest,
        pkg,
        packageUrl: opts.cdnBaseUrl
          ? `${opts.cdnBaseUrl}/${pkg.manifest.hash}/package.json`
          : `${opts.publicUrl}/api/v1/packages/${encodeURIComponent(doc.key)}?v=${pkg.manifest.hash}`,
        hash: pkg.manifest.hash,
        log: ['seed import'],
        createdAt: clock.now(),
      });
    }
    await repo.updateTopic(
      topic.id,
      { status: 'published', publishedVersionId: ver.id, latestVersionId: ver.id, unitKey: doc.unitKey, subjectKey: pkg.subject.key, demo: doc.demo ?? topic.demo },
      null,
    );
    strings.push(...extractStrings('topic', doc.key, doc));
    if (doc.i18n) i18nStatus.set(doc.key, doc.i18n);
  }
  if (propertyTypes.size) await repo.putSetting(PROPERTY_TYPES_SETTING, [...propertyTypes.values()], null);

  // Translation workspace rows (A-11): status from the topic's i18n map, else `reviewed`.
  const rows: LocaleStringWrite[] = [];
  const seen = new Set<string>();
  for (const s of strings) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const topicKey = s.key.startsWith('topic/') ? s.key.split('/')[1] : null;
    const status = topicKey ? i18nStatus.get(topicKey) : undefined;
    for (const l of LANGS) {
      rows.push({
        key: s.key,
        locale: l,
        value: s.value[l],
        status: s.value[l] ? (status?.[l] ?? 'reviewed') : 'draft',
        sourceHash: sourceHash(s.value[SOURCE_LANG]),
        updatedAt: clock.now(),
      });
    }
  }
  await repo.upsertStrings(rows);
  return { subjects: content.base.subjects.length, topics: content.packages.length, versionsCreated, strings: seen.size };
}
