/**
 * Item bank (TZ W-45, A-10, §8 Item): five question types, pure answer
 * checking and deterministic random sampling (same seed → same quiz, so an
 * offline attempt and its server re-check agree).
 */
import { z } from 'zod';
import { KeySchema } from './common.js';
import { LocalizedSchema } from './i18n.js';

export const ITEM_TYPES = ['single', 'multiple', 'match', 'find-on-model', 'numeric'] as const;
export const ItemTypeSchema = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const ItemOptionSchema = z.object({ key: KeySchema, text: LocalizedSchema });
export type ItemOption = z.infer<typeof ItemOptionSchema>;

/** A match pair; the correct answer maps each pair's left side to its own right side. */
export const MatchPairSchema = z.object({
  key: KeySchema,
  left: LocalizedSchema,
  right: LocalizedSchema,
});
export type MatchPair = z.infer<typeof MatchPairSchema>;

const base = {
  key: KeySchema,
  prompt: LocalizedSchema,
  explanation: LocalizedSchema,
  objectiveKeys: z.array(KeySchema),
  /** Key of a Concept misconception this item diagnoses. */
  misconceptionKey: KeySchema.optional(),
  difficulty: z.number().int().min(1).max(5),
};

export const ItemSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('single'),
    options: z.array(ItemOptionSchema).min(2),
    answer: KeySchema,
  }),
  z.object({
    ...base,
    type: z.literal('multiple'),
    options: z.array(ItemOptionSchema).min(2),
    answer: z.array(KeySchema).min(1),
  }),
  z.object({ ...base, type: z.literal('match'), pairs: z.array(MatchPairSchema).min(2) }),
  z.object({ ...base, type: z.literal('find-on-model'), targetConceptKey: KeySchema }),
  z.object({
    ...base,
    type: z.literal('numeric'),
    answer: z.number().finite(),
    /** Absolute tolerance: |response − answer| ≤ tolerance. */
    tolerance: z.number().min(0),
    unit: z.string().optional(),
  }),
]);
export type Item = z.infer<typeof ItemSchema>;

/** A learner's response, discriminated by the same `type` as the item. */
export const ItemResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('single'), value: z.string() }),
  z.object({ type: z.literal('multiple'), value: z.array(z.string()) }),
  /** `{ [leftPairKey]: chosenRightPairKey }` */
  z.object({ type: z.literal('match'), value: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('find-on-model'), value: z.string() }),
  z.object({ type: z.literal('numeric'), value: z.number() }),
]);
export type ItemResponse = z.infer<typeof ItemResponseSchema>;

export interface CheckResult {
  correct: boolean;
  /** 0..1. Partial credit only for `match` (share of correct pairs). */
  score: number;
}

const WRONG: CheckResult = { correct: false, score: 0 };

/** Pure answer check, identical on client (offline) and server. */
export function checkAnswer(item: Item, response: ItemResponse): CheckResult {
  if (item.type !== response.type) return WRONG;
  switch (item.type) {
    case 'single': {
      const ok = response.value === item.answer;
      return { correct: ok, score: ok ? 1 : 0 };
    }
    case 'multiple': {
      const got = new Set(response.value as string[]);
      const want = new Set(item.answer);
      const ok = got.size === want.size && [...want].every((k) => got.has(k));
      return { correct: ok, score: ok ? 1 : 0 };
    }
    case 'match': {
      const value = response.value as Record<string, string>;
      const right = item.pairs.filter((p) => value[p.key] === p.key).length;
      const score = right / item.pairs.length;
      return { correct: score === 1, score };
    }
    case 'find-on-model': {
      const ok = response.value === item.targetConceptKey;
      return { correct: ok, score: ok ? 1 : 0 };
    }
    case 'numeric': {
      const v = response.value as number;
      const ok = Number.isFinite(v) && Math.abs(v - item.answer) <= item.tolerance + 1e-12;
      return { correct: ok, score: ok ? 1 : 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string → unsigned int seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const toSeed = (seed: number | string): number =>
  typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;

/** Deterministic Fisher–Yates shuffle (returns a new array). */
export function seededShuffle<T>(list: readonly T[], seed: number | string): T[] {
  const rnd = mulberry32(toSeed(seed));
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick `n` items deterministically (W-45 «случайная выборка»). n ≥ length → all, shuffled. */
export function sampleItems<T>(items: readonly T[], n: number, seed: number | string): T[] {
  return seededShuffle(items, seed).slice(0, Math.max(0, Math.floor(n)));
}
