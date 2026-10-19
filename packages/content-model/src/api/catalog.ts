/**
 * Catalog DTOs (TZ §9 Catalog, W-02, W-55). Packages themselves are served by
 * the CDN (immutable, hash-addressed); the API returns manifests.
 */
import { z } from 'zod';
import { KeySchema } from '../common.js';
import { CourseSchema, ObjectiveSchema, SubjectGroupSchema, SubjectSchema, UnitSchema } from '../curriculum.js';
import { LangSchema } from '../i18n.js';
import { CatalogSchema, ManifestSchema, TopicSummarySchema } from '../package.js';
import { TextbookSchema } from '../textbook.js';

// GET /catalog — the whole catalog in one payload (offline-cacheable).
export const CatalogResponseSchema = CatalogSchema;
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

// GET /subjects
export const SubjectsResponseSchema = z.object({
  groups: z.array(SubjectGroupSchema),
  subjects: z.array(SubjectSchema),
});
export type SubjectsResponse = z.infer<typeof SubjectsResponseSchema>;

// GET /subjects/:key/courses
export const SubjectCoursesResponseSchema = z.object({ items: z.array(CourseSchema) });
export type SubjectCoursesResponse = z.infer<typeof SubjectCoursesResponseSchema>;

// GET /courses/:key
export const CourseDetailResponseSchema = z.object({
  course: CourseSchema,
  units: z.array(UnitSchema),
  objectives: z.array(ObjectiveSchema),
  topics: z.array(TopicSummarySchema),
});
export type CourseDetailResponse = z.infer<typeof CourseDetailResponseSchema>;

// GET /topics/:key/manifest
export const TopicManifestResponseSchema = z.object({
  manifest: ManifestSchema,
  /** Immutable CDN URL of the package JSON (`…/<hash>/package.json`). */
  packageUrl: z.string().min(1),
  /** Base URL for `manifest.files[].path`. */
  filesBaseUrl: z.string().min(1),
});
export type TopicManifestResponse = z.infer<typeof TopicManifestResponseSchema>;

// GET /search?q=
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  lang: LangSchema.optional(),
  kind: z.enum(['topic', 'concept']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchHitSchema = z.object({
  kind: z.enum(['topic', 'concept']),
  key: KeySchema,
  /** For concept hits: a topic where it appears. */
  topicKey: KeySchema.optional(),
  subjectKey: KeySchema,
  /** Already localized (Accept-Language with fallback chain). */
  title: z.string(),
  snippet: z.string().optional(),
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;
export const SearchResponseSchema = z.object({ items: z.array(SearchHitSchema) });
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// v0.5.0 GET /textbooks?grade=&subjectKey= — the textbook menu (lessons list published topics only)
export const TextbooksQuerySchema = z.object({
  grade: z.coerce.number().int().min(1).max(11).optional(),
  subjectKey: KeySchema.optional(),
});
export type TextbooksQuery = z.infer<typeof TextbooksQuerySchema>;
export const TextbooksResponseSchema = z.object({ items: z.array(TextbookSchema) });
export type TextbooksResponse = z.infer<typeof TextbooksResponseSchema>;

// v0.5.0 GET /textbooks/:key — one textbook with the cards of the topics it maps to
export const TextbookDetailResponseSchema = z.object({
  textbook: TextbookSchema,
  topics: z.array(TopicSummarySchema),
});
export type TextbookDetailResponse = z.infer<typeof TextbookDetailResponseSchema>;
