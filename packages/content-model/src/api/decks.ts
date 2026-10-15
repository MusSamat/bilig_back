/** Presentations, slides and snapshots (TZ W-51, W-52, §9 Decks). */
import { z } from 'zod';
import { KeySchema, SemverSchema } from '../common.js';
import { LangSchema } from '../i18n.js';
import { SceneStateSchema } from '../scene-state.js';
import { DateTimeSchema, IdSchema, VersionTagSchema } from './common.js';

const slideBase = { id: z.string().min(1), notes: z.string().max(4000).optional() };

/** Slide text is the teacher's own (single language), not Localized. */
export const SlideSchema = z.discriminatedUnion('kind', [
  z.object({ ...slideBase, kind: z.literal('title'), title: z.string(), subtitle: z.string().optional() }),
  z.object({
    ...slideBase,
    kind: z.literal('concept'),
    conceptKey: KeySchema,
    title: z.string(),
    text: z.string(),
    snapshotId: IdSchema.optional(),
  }),
  z.object({
    ...slideBase,
    kind: z.literal('process'),
    processKey: KeySchema,
    title: z.string(),
    equation: z.string().optional(),
    steps: z.array(z.string()),
  }),
  z.object({ ...slideBase, kind: z.literal('text'), title: z.string(), text: z.string() }),
  z.object({ ...slideBase, kind: z.literal('snapshot'), snapshotId: IdSchema, caption: z.string().optional() }),
]);
export type Slide = z.infer<typeof SlideSchema>;
export type SlideKind = Slide['kind'];

export const PresentationSchema = z.object({
  id: IdSchema,
  ownerId: IdSchema,
  topicKey: KeySchema,
  title: z.string().min(1).max(200),
  lang: LangSchema,
  slides: z.array(SlideSchema),
  updatedAt: DateTimeSchema,
  /** Optimistic lock; send as If-Match on PATCH. */
  version: VersionTagSchema,
});
export type Presentation = z.infer<typeof PresentationSchema>;

// POST /presentations — `template` = deterministic offline template; `llm` = server-generated JSON slides.
export const PresentationCreateRequestSchema = z.object({
  topicKey: KeySchema,
  title: z.string().min(1).max(200),
  lang: LangSchema,
  mode: z.enum(['template', 'llm']).optional(),
  slides: z.array(SlideSchema).optional(),
});
export type PresentationCreateRequest = z.infer<typeof PresentationCreateRequestSchema>;

// PATCH /presentations/:id
export const PresentationPatchRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slides: z.array(SlideSchema).optional(),
  version: VersionTagSchema,
});
export type PresentationPatchRequest = z.infer<typeof PresentationPatchRequestSchema>;

export const PresentationListSchema = z.object({
  items: z.array(PresentationSchema.omit({ slides: true })),
  nextCursor: z.string().nullable(),
});

// POST /presentations/:id/export?format=pptx|pdf
export const ExportQuerySchema = z.object({ format: z.enum(['pptx', 'pdf']) });
export const ExportResponseSchema = z.object({
  jobId: IdSchema,
  status: z.enum(['queued', 'running', 'done', 'failed']),
  url: z.string().optional(),
  expiresAt: DateTimeSchema.optional(),
});
export type ExportResponse = z.infer<typeof ExportResponseSchema>;

// POST /snapshots
export const SnapshotCreateRequestSchema = z.object({
  topicKey: KeySchema,
  topicVersion: SemverSchema,
  /** `data:image/webp;base64,…` or `data:image/png;base64,…`. */
  image: z.string().regex(/^data:image\/(webp|png|jpeg);base64,/),
  sceneState: SceneStateSchema,
});
export type SnapshotCreateRequest = z.infer<typeof SnapshotCreateRequestSchema>;

export const SnapshotResponseSchema = z.object({
  id: IdSchema,
  topicKey: KeySchema,
  topicVersion: SemverSchema,
  imageUrl: z.string().min(1),
  sceneState: SceneStateSchema,
  createdAt: DateTimeSchema,
});
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
