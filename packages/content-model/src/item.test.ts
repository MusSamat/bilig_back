import { describe, it, expect } from 'vitest';
import {
  ItemSchema,
  ItemResponseSchema,
  checkAnswer,
  hashSeed,
  mulberry32,
  sampleItems,
  seededShuffle,
  type Item,
} from './index.js';
import { animalCellPackage } from './fixtures/animal-cell.js';

const items = animalCellPackage.items;
const byType = <T extends Item['type']>(type: T) =>
  items.find((i) => i.type === type) as Extract<Item, { type: T }>;

describe('ItemSchema (W-45: five types)', () => {
  it('accepts all five fixture items', () => {
    expect(new Set(items.map((i) => i.type))).toEqual(
      new Set(['single', 'multiple', 'match', 'find-on-model', 'numeric']),
    );
    for (const i of items) expect(ItemSchema.safeParse(i).success, i.key).toBe(true);
  });

  it('rejects < 2 options, bad difficulty, negative tolerance, unknown type', () => {
    const single = byType('single');
    expect(ItemSchema.safeParse({ ...single, options: [single.options[0]] }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...single, difficulty: 6 }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...byType('numeric'), tolerance: -1 }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...single, type: 'essay' }).success).toBe(false);
  });

  it('responses are discriminated by type', () => {
    expect(ItemResponseSchema.safeParse({ type: 'numeric', value: '6' }).success).toBe(false);
    expect(ItemResponseSchema.safeParse({ type: 'match', value: { a: 'b' } }).success).toBe(true);
  });
});

describe('checkAnswer', () => {
  it('single', () => {
    const it1 = byType('single');
    expect(checkAnswer(it1, { type: 'single', value: 'b' })).toEqual({ correct: true, score: 1 });
    expect(checkAnswer(it1, { type: 'single', value: 'a' })).toEqual({ correct: false, score: 0 });
  });

  it('multiple: exact set, order-insensitive, duplicates collapse', () => {
    const m = byType('multiple');
    expect(checkAnswer(m, { type: 'multiple', value: ['b', 'a'] }).correct).toBe(true);
    expect(checkAnswer(m, { type: 'multiple', value: ['a', 'a', 'b'] }).correct).toBe(true);
    expect(checkAnswer(m, { type: 'multiple', value: ['a'] }).correct).toBe(false);
    expect(checkAnswer(m, { type: 'multiple', value: ['a', 'b', 'c'] }).correct).toBe(false);
  });

  it('match: partial credit', () => {
    const m = byType('match');
    expect(checkAnswer(m, { type: 'match', value: { nucleus: 'nucleus', mito: 'mito' } })).toEqual({ correct: true, score: 1 });
    expect(checkAnswer(m, { type: 'match', value: { nucleus: 'nucleus', mito: 'nucleus' } })).toEqual({ correct: false, score: 0.5 });
    expect(checkAnswer(m, { type: 'match', value: {} }).score).toBe(0);
  });

  it('find-on-model', () => {
    const f = byType('find-on-model');
    expect(checkAnswer(f, { type: 'find-on-model', value: 'bio.nucleus' }).correct).toBe(true);
    expect(checkAnswer(f, { type: 'find-on-model', value: 'bio.membrane' }).correct).toBe(false);
  });

  it('numeric with tolerance (inclusive)', () => {
    const n = byType('numeric'); // 6 ± 1
    expect(checkAnswer(n, { type: 'numeric', value: 7 }).correct).toBe(true);
    expect(checkAnswer(n, { type: 'numeric', value: 5 }).correct).toBe(true);
    expect(checkAnswer(n, { type: 'numeric', value: 7.01 }).correct).toBe(false);
    expect(checkAnswer(n, { type: 'numeric', value: NaN }).correct).toBe(false);
  });

  it('type mismatch is wrong', () => {
    expect(checkAnswer(byType('single'), { type: 'numeric', value: 1 })).toEqual({ correct: false, score: 0 });
  });
});

describe('deterministic sampling', () => {
  it('hashSeed and mulberry32 are deterministic and in [0,1)', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('sampleItems: same seed → same sample; different seeds differ; no duplicates', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const s1 = sampleItems(keys, 5, 'attempt-1');
    expect(s1).toEqual(sampleItems(keys, 5, 'attempt-1'));
    expect(new Set(s1).size).toBe(5);
    expect(s1).not.toEqual(sampleItems(keys, 5, 'attempt-2'));
    expect(sampleItems(keys, 5, 7)).toEqual(sampleItems(keys, 5, 7));
  });

  it('n ≥ length returns all (shuffled); n ≤ 0 returns none; input untouched', () => {
    const keys = ['a', 'b', 'c'];
    expect(sampleItems(keys, 10, 1).sort()).toEqual(['a', 'b', 'c']);
    expect(sampleItems(keys, 0, 1)).toEqual([]);
    expect(sampleItems(keys, -3, 1)).toEqual([]);
    expect(keys).toEqual(['a', 'b', 'c']);
    expect(seededShuffle([], 's')).toEqual([]);
  });
});
