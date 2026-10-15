/**
 * The offline unit (ContentPackage) and the catalog (TZ §4 W-02, W-55, §8 Build).
 * The client reads content ONLY from built packages, never from draft tables.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, KeySchema, RelPathSchema, SemverSchema, Sha256Schema } from './common.js';
import {
  ConceptSchema,
  PropertyTypeDefSchema,
  applyOverride,
  type ResolvedConcept,
} from './concept.js';
import {
  CourseSchema,
  ObjectiveSchema,
  SubjectGroupSchema,
  SubjectSchema,
  UnitSchema,
} from './curriculum.js';
import { GlossaryTermSchema } from './glossary.js';
import { LocalizedSchema } from './i18n.js';
import { ItemSchema } from './item.js';
import { ProcessSchema } from './process.js';
import { ContentStatusSchema, TopicSchema } from './topic.js';

export const ManifestFileSchema = z.object({
  path: RelPathSchema,
  hash: Sha256Schema,
  size: z.number().int().min(0),
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

/** Package manifest: what the API returns from GET /topics/:key/manifest (W-55). */
export const ManifestSchema = z.object({
  topicKey: KeySchema,
  version: SemverSchema,
  /** Hash over the package; CDN URL is content-addressed by it. */
  hash: Sha256Schema,
  files: z.array(ManifestFileSchema),
  builtAt: IsoDateTimeSchema.optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const ContentPackageSchema = z.object({
  manifest: ManifestSchema,
  subject: SubjectSchema,
  /** Breadcrumb context (W-04); optional so a bare topic package still validates. */
  course: CourseSchema.optional(),
  unit: UnitSchema.optional(),
  objectives: z.array(ObjectiveSchema).optional(),
  topic: TopicSchema,
  /** Only the concepts this topic uses (conceptKeys, related, steps, comparison). */
  concepts: z.array(ConceptSchema),
  processes: z.array(ProcessSchema),
  items: z.array(ItemSchema),
  glossary: z.array(GlossaryTermSchema),
  /** Extra property types beyond the built-in dictionary. */
  propertyTypes: z.array(PropertyTypeDefSchema).optional(),
});
export type ContentPackage = z.infer<typeof ContentPackageSchema>;

/** Catalog card counts (W-02 «число моделей»). */
export const TopicCountsSchema = z.object({
  concepts: z.number().int().min(0),
  /** 3D models in the topic: the samples, or 1 when the topic has none. */
  models: z.number().int().min(0),
  processes: z.number().int().min(0),
  items: z.number().int().min(0),
});
export type TopicCounts = z.infer<typeof TopicCountsSchema>;

export const TopicSummarySchema = z.object({
  key: KeySchema,
  unitKey: KeySchema,
  subjectKey: KeySchema,
  status: ContentStatusSchema,
  title: LocalizedSchema,
  classification: LocalizedSchema.optional(),
  formula: z.string().optional(),
  durationMin: z.number().int().positive(),
  /**
   * Thumbnail. `summarizeTopic` yields the package-relative path; API catalog
   * responses (v0.3.0) resolve it to an absolute, hash-addressed URL under `filesBaseUrl`.
   */
  thumb: z.string().optional(),
  /** Current published package version + hash (for "update only what changed"). */
  version: SemverSchema,
  hash: Sha256Schema,
  counts: TopicCountsSchema,
  /** Open demo topic (guests may load its package). */
  demo: z.boolean().optional(),
  /** v0.3.0: absolute base URL of the package files (as in the manifest response); API responses only. */
  filesBaseUrl: z.string().min(1).optional(),
  /** v0.3.0: the topic's concept keys («изучено N из M» without loading the package). */
  conceptKeys: z.array(KeySchema).optional(),
});
export type TopicSummary = z.infer<typeof TopicSummarySchema>;

export const CatalogSchema = z.object({
  groups: z.array(SubjectGroupSchema),
  subjects: z.array(SubjectSchema),
  courses: z.array(CourseSchema),
  units: z.array(UnitSchema),
  topics: z.array(TopicSummarySchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;

/** Parse a content package with the schema only (throws ZodError). See also `validatePackage`. */
export function parseContentPackage(input: unknown): ContentPackage {
  return ContentPackageSchema.parse(input);
}

/** Build the catalog summary for a package. */
export function summarizeTopic(pkg: ContentPackage): TopicSummary {
  const { topic } = pkg;
  return {
    key: topic.key,
    unitKey: topic.unitKey,
    subjectKey: pkg.subject.key,
    status: topic.status,
    title: topic.title,
    classification: topic.classification,
    formula: topic.formula,
    durationMin: topic.durationMin,
    thumb: topic.samples[0]?.thumb,
    version: pkg.manifest.version,
    hash: pkg.manifest.hash,
    counts: {
      concepts: topic.conceptKeys.length,
      models: Math.max(1, topic.samples.length),
      processes: topic.activities.processKeys.length,
      items: topic.activities.quiz?.itemKeys.length ?? 0,
    },
    ...(topic.demo !== undefined ? { demo: topic.demo } : {}),
    conceptKeys: [...topic.conceptKeys],
  };
}

/** Topics of a subject, ordered by course grade, then unit order. */
export function topicsOfSubject(catalog: Catalog, subjectKey: string): TopicSummary[] {
  const courses = new Map(
    catalog.courses.filter((c) => c.subjectKey === subjectKey).map((c) => [c.key, c]),
  );
  const units = new Map(
    catalog.units.filter((u) => courses.has(u.courseKey)).map((u) => [u.key, u]),
  );
  const rank = (t: TopicSummary): [number, number] => {
    const u = units.get(t.unitKey);
    return [u ? courses.get(u.courseKey)!.grade : 99, u?.order ?? 0];
  };
  return catalog.topics
    .filter((t) => t.subjectKey === subjectKey)
    .sort((a, b) => {
      const [ga, oa] = rank(a);
      const [gb, ob] = rank(b);
      return ga - gb || oa - ob || a.key.localeCompare(b.key);
    });
}

/** W-02 «число моделей» on a subject card. */
export function subjectModelCount(catalog: Catalog, subjectKey: string): number {
  return catalog.topics
    .filter((t) => t.subjectKey === subjectKey)
    .reduce((n, t) => n + t.counts.models, 0);
}

/** The topic's concepts in display order, merged with topic overrides (W-31). */
export function topicConcepts(pkg: ContentPackage): ResolvedConcept[] {
  const byKey = new Map(pkg.concepts.map((c) => [c.key, c]));
  const out: ResolvedConcept[] = [];
  for (const key of pkg.topic.conceptKeys) {
    const c = byKey.get(key);
    if (c) out.push(applyOverride(c, pkg.topic.overrides[key]));
  }
  return out;
}

/** One concept of the package, with the topic override applied when it belongs to the topic. */
export function findConcept(pkg: ContentPackage, key: string): ResolvedConcept | undefined {
  const c = pkg.concepts.find((x) => x.key === key);
  return c ? applyOverride(c, pkg.topic.overrides[key]) : undefined;
}
