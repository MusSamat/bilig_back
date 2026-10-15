/**
 * Topic document (TZ §8 Topic/TopicVersion.doc, W-10..W-12, W-23, W-44, W-45,
 * W-50, A-06/A-07/A-09). A topic references dictionary concepts by key and
 * overrides them locally; processes and items are separate entities.
 */
import { z } from 'zod';
import { CameraSchema, KeySchema, RelPathSchema } from './common.js';
import { ConceptOverrideSchema, ExamplesSchema, PropertyTypeKeySchema } from './concept.js';
import { I18nStatusMapSchema, LocalizedSchema } from './i18n.js';

/** Publish workflow states (A-13): черновик → на проверке → опубликовано → архив. */
export const CONTENT_STATUSES = ['draft', 'review', 'published', 'archived'] as const;
export const ContentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

/** Scene plugins known today (W-25). New plugins add a string — no core change. */
export const KNOWN_SCENE_PLUGINS = ['gltf', 'molecule', 'crystal', 'geometry', 'sim'] as const;
export type KnownScenePlugin = (typeof KNOWN_SCENE_PLUGINS)[number];
/** Plugin kind: a known plugin or any other registered string. */
export type ScenePluginKind = KnownScenePlugin | (string & {});

export const SceneSpecSchema = z
  .object({
    plugin: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Invalid plugin id') as z.ZodType<ScenePluginKind>,
    /** Package-relative asset path for asset-based plugins (`gltf`). */
    asset: RelPathSchema.optional(),
    /** Generator parameters for procedural plugins (molecule, crystal, geometry, sim). */
    params: z.record(z.string(), z.unknown()).optional(),
    /** Initial camera. */
    camera: CameraSchema.optional(),
    /** Mode ids the «Вид модели» panel may show (intersected with plugin.modes()). */
    modes: z.array(z.string().min(1)),
  })
  .superRefine((s, ctx) => {
    if (s.plugin === 'gltf' && !s.asset) {
      ctx.addIssue({ code: 'custom', path: ['asset'], message: 'gltf scene requires an asset' });
    }
    if (s.plugin !== 'gltf' && !s.asset && !s.params) {
      ctx.addIssue({ code: 'custom', path: ['params'], message: 'scene requires params or asset' });
    }
  });
export type SceneSpec = z.infer<typeof SceneSpecSchema>;

/** A sample in the topic ribbon (W-12): pre-rendered WebP thumbnail. */
export const SampleSchema = z.object({
  key: KeySchema,
  title: LocalizedSchema,
  classification: LocalizedSchema.optional(),
  /** Package-relative thumbnail path (rendered at build time). */
  thumb: RelPathSchema,
  /** Topic that opens when the sample is clicked (W-44). */
  topicKey: KeySchema.optional(),
});
export type Sample = z.infer<typeof SampleSchema>;

/** Visibility for a tour step: isolate some concepts and/or hide others. */
export const VisibilitySchema = z.object({
  isolate: z.array(KeySchema).optional(),
  hide: z.array(KeySchema).optional(),
});
export type Visibility = z.infer<typeof VisibilitySchema>;

/** One step of the guided tour / lesson mode (W-50, A-07). */
export const TourStepSchema = z.object({
  key: KeySchema,
  camera: CameraSchema.optional(),
  visibility: VisibilitySchema.optional(),
  /** Scene mode state to apply at this step (`{ view: 'section', labels: true }`). */
  modes: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
  /** Concept focused at this step. */
  focus: KeySchema.optional(),
  text: LocalizedSchema,
  teacherNote: LocalizedSchema.optional(),
  altText: LocalizedSchema,
});
export type TourStep = z.infer<typeof TourStepSchema>;

export const TourSchema = z.object({ steps: z.array(TourStepSchema).min(1) });
export type Tour = z.infer<typeof TourSchema>;

/** A comparison column: a topic sample or a concept (W-44, A-09). */
export const ComparisonColumnSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('concept'), key: KeySchema }),
  z.object({ kind: z.literal('sample'), key: KeySchema }),
]);
export type ComparisonColumn = z.infer<typeof ComparisonColumnSchema>;

export const ComparisonSchema = z.object({
  columns: z.array(ComparisonColumnSchema).min(2),
  /** Property-type keys as rows; values are pulled from concept props. */
  rows: z.array(PropertyTypeKeySchema).min(1),
  /** Manual cells — only where the dictionary has no such property (A-09). */
  manual: z
    .array(z.object({ column: KeySchema, row: PropertyTypeKeySchema, value: LocalizedSchema }))
    .optional(),
});
export type Comparison = z.infer<typeof ComparisonSchema>;

export const QuizSpecSchema = z
  .object({
    itemKeys: z.array(KeySchema).min(1),
    /** How many items to draw per attempt (deterministic, see `sampleItems`). */
    sampleSize: z.number().int().min(1),
  })
  .refine((q) => q.sampleSize <= q.itemKeys.length, {
    message: 'sampleSize exceeds itemKeys',
    path: ['sampleSize'],
  });
export type QuizSpec = z.infer<typeof QuizSpecSchema>;

export const ActivitiesSchema = z.object({
  tour: TourSchema.optional(),
  processKeys: z.array(KeySchema),
  comparison: ComparisonSchema.optional(),
  quiz: QuizSpecSchema.optional(),
});
export type Activities = z.infer<typeof ActivitiesSchema>;

export const TopicSchema = z.object({
  /** Global key, also the URL slug (`animal-cell`). */
  key: KeySchema,
  unitKey: KeySchema,
  status: ContentStatusSchema,
  title: LocalizedSchema,
  /** Plain or TeX formula shown with the title (W-10: «Вода, H₂O»). */
  formula: z.string().optional(),
  /** Classification, shown in italics. */
  classification: LocalizedSchema.optional(),
  description: LocalizedSchema,
  /** «Цель урока». */
  goal: LocalizedSchema,
  objectiveKeys: z.array(KeySchema),
  durationMin: z.number().int().positive(),
  scene: SceneSpecSchema,
  /** Dictionary concepts present in this topic, in display order. */
  conceptKeys: z.array(KeySchema).min(1),
  /** Per-topic overrides keyed by concept key. */
  overrides: z.record(KeySchema, ConceptOverrideSchema),
  samples: z.array(SampleSchema),
  activities: ActivitiesSchema,
  examples: ExamplesSchema,
  /** Translation status per locale (A-11). */
  i18n: I18nStatusMapSchema.optional(),
});
export type Topic = z.infer<typeof TopicSchema>;
