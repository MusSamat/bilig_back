/**
 * Zod runtime validators for the content model (TZ §7/§8: validate content and
 * API payloads). The static types in `index.ts` are the source of truth; these
 * schemas mirror them for runtime checks at system boundaries — the admin GLB/
 * content upload (bilig_back) and the content package loader (bilig_ft).
 */
import { z } from 'zod';
import type {
  Catalog,
  Concept,
  ContentPackage,
  Lang,
  Subject,
  Topic,
} from './index.js';

export const LangSchema: z.ZodType<Lang> = z.enum(['ky', 'ru', 'en']);

/** A localized string: at least the Kyrgyz key should be present in authored content. */
export const LocalizedSchema = z
  .object({
    ky: z.string().optional(),
    ru: z.string().optional(),
    en: z.string().optional(),
  })
  .refine((v) => v.ky || v.ru || v.en, {
    message: 'Localized value must have at least one language',
  });

export const PluginTypeSchema = z.enum([
  'glb',
  'molecule',
  'crystal',
  'geometry',
  'sim',
]);

export const SubjectStatusSchema = z.enum(['available', 'coming']);

export const SubjectSchema: z.ZodType<Subject> = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: LocalizedSchema,
  icon: z.string().min(1),
  hue: z.number().int().min(0).max(359),
  group: z.string().min(1),
  status: SubjectStatusSchema,
});

export const ConceptPropertySchema = z.object({
  type: z.string().min(1),
  label: LocalizedSchema,
  value: z.union([z.string(), z.number()]),
  unit: z.string().optional(),
});

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const ConceptSchema: z.ZodType<Concept> = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: LocalizedSchema,
  subtitle: LocalizedSchema.optional(),
  description: LocalizedSchema,
  container: z.boolean(),
  colorHue: z.number().int().min(0).max(359).optional(),
  properties: z.array(ConceptPropertySchema),
  fact: LocalizedSchema.optional(),
  relatedIds: z.array(z.string()),
  anchor: Vec3.optional(),
});

export const ProcessEngineSchema = z.enum(['timeline', 'stoich', 'ode']);

export const ProcessStepSchema = z.object({
  index: z.number().int().min(0),
  title: LocalizedSchema,
  description: LocalizedSchema,
  conceptId: z.string().optional(),
  result: LocalizedSchema.optional(),
  altText: LocalizedSchema.optional(),
});

export const ProcessSchema = z.object({
  id: z.string().min(1),
  title: LocalizedSchema,
  description: LocalizedSchema,
  equation: z.string().optional(),
  engine: ProcessEngineSchema,
  steps: z.array(ProcessStepSchema),
  metrics: z.array(z.string()),
});

export const SceneSpecSchema = z.object({
  plugin: PluginTypeSchema,
  modelRef: z.string().optional(),
  modes: z.array(z.string()),
  overrides: z
    .record(
      z.string(),
      z.object({
        anchor: Vec3.optional(),
        colorHue: z.number().int().min(0).max(359).optional(),
      }),
    )
    .optional(),
});

export const QuizQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: LocalizedSchema,
  options: z.array(z.object({ id: z.string(), text: LocalizedSchema })).min(2),
  correctOptionId: z.string().min(1),
  conceptId: z.string().optional(),
});

export const ComparisonSpecSchema = z.object({
  columnConceptIds: z.array(z.string()),
  propertyTypes: z.array(z.string()),
});

export const TopicSchema: z.ZodType<Topic> = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1),
  slug: z.string().min(1),
  grade: z.string().optional(),
  title: LocalizedSchema,
  classification: LocalizedSchema.optional(),
  description: LocalizedSchema,
  goal: LocalizedSchema.optional(),
  programCode: z.string().optional(),
  scene: SceneSpecSchema,
  concepts: z.array(ConceptSchema),
  processes: z.array(ProcessSchema),
  comparison: ComparisonSpecSchema.optional(),
  quiz: z.array(QuizQuestionSchema).optional(),
});

export const GlossaryEntrySchema = z.object({
  id: z.string().min(1),
  term: LocalizedSchema,
  definition: LocalizedSchema,
  conceptId: z.string().optional(),
});

export const ContentPackageSchema: z.ZodType<ContentPackage> = z.object({
  version: z.string().min(1),
  subject: SubjectSchema,
  topics: z.array(TopicSchema),
  glossary: z.array(GlossaryEntrySchema),
  searchDocs: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
        lang: LangSchema,
      }),
    )
    .optional(),
});

export const CatalogSchema: z.ZodType<Catalog> = z.object({
  groups: z.array(
    z.object({ id: z.string(), title: LocalizedSchema, order: z.number() }),
  ),
  subjects: z.array(SubjectSchema),
});

/** Parse + validate a content package (throws ZodError on invalid input). */
export function parseContentPackage(input: unknown): ContentPackage {
  return ContentPackageSchema.parse(input) as ContentPackage;
}
