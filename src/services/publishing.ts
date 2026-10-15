/**
 * Package assembly, the automatic publish checklist and builds (TZ A-13, §8
 * Build). The client reads content only from built packages, so publishing =
 * assemble from the relational tables → validate → hash → store a Build →
 * move the topic's published pointer.
 */
import {
  LANGS,
  missingLangs,
  validatePackage,
  type Concept,
  type ContentPackage,
  type Manifest,
  type PropertyTypeDef,
  type Topic,
  type ValidationIssue,
} from '@bilig/content-model';
import type { Checklist } from '@bilig/content-model/api';
import { newId } from '../ids.js';
import { sha256Hex, stableStringify } from '../domain/crypto.js';
import { extractLocalized } from '../domain/strings.js';
import type { BuildRec, Repository, TopicRec, TopicVersionRec } from '../repo/types.js';
import type { Clock } from './clock.js';

/** TZ §10: theme package ≤ 5 MB. */
export const PACKAGE_BUDGET_BYTES = 5 * 1024 * 1024;
export const PROPERTY_TYPES_SETTING = 'content.propertyTypes';

export interface AssembleResult {
  pkg: ContentPackage | null;
  issues: ValidationIssue[];
}

const issue = (path: (string | number)[], code: string, message: string, severity: 'error' | 'warning' = 'error'): ValidationIssue => ({
  path,
  code,
  message,
  severity,
});

export class PublishingService {
  constructor(
    private repo: Repository,
    private clock: Clock,
    private urls: { publicUrl: string; cdnBaseUrl?: string },
  ) {}

  packageUrl(topicKey: string, hash: string): string {
    return this.urls.cdnBaseUrl
      ? `${this.urls.cdnBaseUrl}/${hash}/package.json`
      : `${this.urls.publicUrl}/api/v1/packages/${encodeURIComponent(topicKey)}?v=${hash}`;
  }
  filesBaseUrl(hash: string): string {
    return this.urls.cdnBaseUrl ? `${this.urls.cdnBaseUrl}/${hash}/` : `${this.urls.publicUrl}/cdn/${hash}/`;
  }

  /** Concept keys a topic document needs in its package. */
  static neededConcepts(doc: Topic, processSteps: string[], dictionary: Map<string, Concept>): string[] {
    const keys = new Set<string>(doc.conceptKeys);
    for (const k of doc.conceptKeys) dictionary.get(k)?.related.forEach((r) => keys.add(r));
    processSteps.forEach((k) => keys.add(k));
    doc.activities.comparison?.columns.forEach((c) => c.kind === 'concept' && keys.add(c.key));
    return [...keys];
  }

  /** Assemble a package for a topic version from the current dictionary tables. */
  async assemble(topic: TopicRec, ver: TopicVersionRec, prevManifest?: Manifest | null): Promise<AssembleResult> {
    const doc = ver.doc;
    const issues: ValidationIssue[] = [];
    const subject = await this.repo.content('subject').get(topic.subjectKey);
    const unit = await this.repo.content('unit').get(doc.unitKey);
    const course = unit ? await this.repo.content('course').get(unit.data.courseKey) : null;
    if (!subject) issues.push(issue(['subject'], 'subject_missing', `Subject "${topic.subjectKey}" not found`));
    if (!unit) issues.push(issue(['topic', 'unitKey'], 'unit_missing', `Unit "${doc.unitKey}" not found`));
    const objectives = (await this.repo.content('objective').getMany(doc.objectiveKeys)).map((r) => r.data);
    const processes = (await this.repo.content('process').getMany(doc.activities.processKeys)).map((r) => r.data);
    const items = (await this.repo.content('item').getMany(doc.activities.quiz?.itemKeys ?? [])).map((r) => r.data);

    // Concepts: two passes so related-of-topic-concepts are resolved from the dictionary.
    const first = await this.repo.content('concept').getMany(doc.conceptKeys);
    const dict = new Map(first.map((r) => [r.key, r.data]));
    const stepConcepts = processes.flatMap((p) => p.steps.flatMap((s) => (s.conceptKey ? [s.conceptKey] : [])));
    const needed = PublishingService.neededConcepts(doc, stepConcepts, dict);
    const concepts = (await this.repo.content('concept').getMany(needed)).map((r) => r.data);

    const glossary = (await this.repo.content('glossary').list({}, { limit: 10_000 })).items.map((r) => r.data);
    const ptSetting = await this.repo.getSetting(PROPERTY_TYPES_SETTING);
    const propertyTypes = (ptSetting?.value as PropertyTypeDef[] | undefined) ?? [];
    if (!subject || !unit) return { pkg: null, issues };

    const body = {
      subject: subject.data,
      ...(course ? { course: course.data } : {}),
      unit: unit.data,
      objectives,
      topic: { ...doc, status: 'published' as const, demo: topic.demo },
      concepts,
      processes,
      items,
      glossary,
      ...(propertyTypes.length ? { propertyTypes } : {}),
    };
    const json = stableStringify(body);
    const hash = sha256Hex(json);
    const assetFiles = (prevManifest?.files ?? []).filter((f) => f.path !== 'package.json');
    const manifest: Manifest = {
      topicKey: topic.key,
      version: ver.version,
      hash,
      files: [{ path: 'package.json', hash, size: Buffer.byteLength(json) }, ...assetFiles],
      builtAt: this.clock.now().toISOString(),
    };
    const res = validatePackage({ manifest, ...body });
    return { pkg: res.data ?? null, issues: [...issues, ...res.issues] };
  }

  /** The automatic checklist (A-13): schema, translations, budgets, alt text. */
  checklist(res: AssembleResult): Checklist {
    const issues = [...res.issues];
    const pkg = res.pkg;
    if (pkg) {
      // translations: every Localized string of the topic and its dictionary entries in ky/ru/en
      const docs: [string, unknown][] = [
        ['topic', pkg.topic],
        ...pkg.concepts.map((c, i) => [`concepts.${i}`, c] as [string, unknown]),
        ...pkg.processes.map((p, i) => [`processes.${i}`, p] as [string, unknown]),
        ...pkg.items.map((it, i) => [`items.${i}`, it] as [string, unknown]),
      ];
      for (const [root, d] of docs) {
        for (const { path, value } of extractLocalized(d)) {
          const miss = missingLangs(value);
          if (miss.length && miss.length < LANGS.length)
            issues.push(issue([...root.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)), ...path], 'translation_missing', `Missing: ${miss.join(', ')}`));
        }
      }
      // v0.3.0: «Права и источники» (A-06) — a 3D asset without a rights entry is a warning.
      if (pkg.topic.scene.asset && !pkg.topic.rights?.length)
        issues.push(issue(['topic', 'rights'], 'rights_missing', `No licence/author/source entry for "${pkg.topic.scene.asset}"`, 'warning'));
      // budgets
      const total = pkg.manifest.files.reduce((n, f) => n + f.size, 0);
      if (total > PACKAGE_BUDGET_BYTES) issues.push(issue(['manifest', 'files'], 'budget_package_size', `Package is ${total} bytes (budget ${PACKAGE_BUDGET_BYTES})`));
      // alt text: process steps and tour steps
      pkg.processes.forEach((p, pi) =>
        p.steps.forEach((s, si) => {
          if (missingLangs(s.altText).length) issues.push(issue(['processes', pi, 'steps', si, 'altText'], 'alt_text_missing', 'Alt text not in all languages'));
        }),
      );
      pkg.topic.activities.tour?.steps.forEach((s, si) => {
        if (missingLangs(s.altText).length) issues.push(issue(['topic', 'activities', 'tour', 'steps', si, 'altText'], 'alt_text_missing', 'Alt text not in all languages'));
      });
    }
    const errs = (codes: (c: string) => boolean) => !issues.some((i) => i.severity === 'error' && codes(i.code));
    const isTranslation = (c: string) => c === 'translation_missing' || c === 'example_translation_missing';
    const isBudget = (c: string) => c.startsWith('budget_');
    const isAlt = (c: string) => c.startsWith('alt_text');
    return {
      schema: !!pkg && errs((c) => !isTranslation(c) && !isBudget(c) && !isAlt(c)),
      translations: errs(isTranslation),
      budgets: errs(isBudget),
      altText: errs(isAlt) && !issues.some((i) => i.code === 'alt_text_incomplete'),
      issues,
    };
  }

  static passes(c: Checklist): boolean {
    return c.schema && c.translations && c.budgets && c.altText;
  }

  /** Build (and store) a package for a version. Returns the build record (ready or failed). */
  async build(topic: TopicRec, ver: TopicVersionRec): Promise<{ build: BuildRec; checklist: Checklist }> {
    const prev = topic.publishedVersionId ? await this.repo.readyBuildForVersion(topic.publishedVersionId) : null;
    const res = await this.assemble(topic, ver, prev?.manifest);
    const checklist = this.checklist(res);
    const ok = PublishingService.passes(checklist) && !!res.pkg;
    const log = [
      `assemble ${topic.key}@${ver.version}`,
      ...checklist.issues.map((i) => `${i.severity}: ${i.path.join('.')}: ${i.code} ${i.message}`),
      ok ? `ready ${res.pkg!.manifest.hash}` : 'failed',
    ];
    const build: BuildRec = {
      id: newId(),
      topicId: topic.id,
      topicKey: topic.key,
      topicVersionId: ver.id,
      version: ver.version,
      status: ok ? 'ready' : 'failed',
      manifest: ok ? res.pkg!.manifest : null,
      pkg: ok ? res.pkg : null,
      packageUrl: ok ? this.packageUrl(topic.key, res.pkg!.manifest.hash) : null,
      hash: ok ? res.pkg!.manifest.hash : null,
      log,
      createdAt: this.clock.now(),
    };
    await this.repo.createBuild(build);
    return { build, checklist };
  }
}
