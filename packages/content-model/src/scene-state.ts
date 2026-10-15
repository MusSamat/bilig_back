/**
 * Shareable scene state (W-05 URL, W-51 snapshots). Lives in the contract
 * because snapshots and presentations are stored by the API.
 */
import { z } from 'zod';
import { CameraSchema, KeySchema } from './common.js';
import { LangSchema } from './i18n.js';

export const VIEW_MODES = ['study', 'lesson'] as const;
export const ViewModeSchema = z.enum(VIEW_MODES);
export type ViewMode = z.infer<typeof ViewModeSchema>;

export const SceneStateSchema = z.object({
  lang: LangSchema,
  subjectKey: KeySchema,
  /** Grade path segment, e.g. `g7` (W-05 example). */
  grade: z.string().regex(/^g\d{1,2}$/).optional(),
  topicKey: KeySchema,
  /** Focused concept key (`?focus=bio.nucleus`). */
  focus: KeySchema.optional(),
  /** Active non-default mode ids (`?mode=section,labels`). */
  modes: z.array(z.string().min(1)).optional(),
  /** Active process key (`?process=…`). */
  process: KeySchema.optional(),
  /** Current process step index (`?step=2`). */
  step: z.number().int().min(0).optional(),
  view: ViewModeSchema.optional(),
  /** Current tour step in lesson mode (`?lesson=3`). */
  lessonStep: z.number().int().min(0).optional(),
  /** Camera (not encoded in the URL; kept in snapshots). */
  camera: CameraSchema.optional(),
});
export type SceneState = z.infer<typeof SceneStateSchema>;

/** W-51: a snapshot keeps both the picture and the live SceneState. */
export const SnapshotSchema = z.object({
  /** Image URL or `data:image/webp;base64,…` before upload. */
  image: z.string().min(1),
  sceneState: SceneStateSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
