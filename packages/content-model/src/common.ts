/** Shared primitive schemas: content keys, vectors, camera, hashes, versions. */
import { z } from 'zod';

/**
 * Readable, unique, immutable content key (TZ §8: `bio.nucleus`).
 * Lowercase alphanumerics separated by `.`, `-` or `_`. URL-safe.
 */
export const KEY_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const KeySchema = z.string().regex(KEY_RE, 'Invalid key');
export type Key = z.infer<typeof KeySchema>;

export const HueSchema = z.number().int().min(0).max(359);

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/** A saved camera view (A-06 «сохранить текущий вид», A-07 tour steps). */
export const CameraSchema = z.object({
  position: Vec3Schema,
  target: Vec3Schema,
  fov: z.number().positive().max(179).optional(),
});
export type Camera = z.infer<typeof CameraSchema>;

/** Lowercase hex sha256. */
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected sha256 hex');

export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Expected semver');

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/** Package-relative file path (no leading slash, no `..`). */
export const RelPathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'Invalid relative path');
