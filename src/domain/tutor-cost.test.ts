/**
 * Cost guards for the assistant prompt (contract 0.9.0 audit): the reusable shell
 * (rules → subject guide → topic material), its size on the real content, the
 * cache-friendly prefix and the history budget. A failing budget here means a
 * change made every request more expensive — look before raising it.
 */
import { describe, expect, it } from 'vitest';
import { loadContentDir } from '../services/seed.js';
import { trimHistory } from '../modules/tutor.js';
import { buildSystemPrompt, wrapQuestion } from './tutor.js';

/** DeepSeek-style BPE estimate: ~2.3 chars/token for Cyrillic, ~3.7 for Latin (conservative). */
const tokens = (s: string) => {
  const cyr = (s.match(/[Ѐ-ӿ]/g) ?? []).length;
  return Math.round(cyr / 2.3 + (s.length - cyr) / 3.7);
};
const content = loadContentDir();
const LANGS = ['ky', 'ru', 'en'] as const;

describe('assistant prompt: size on the real content', () => {
  it('every topic × language stays within budget (median was 4.3k tokens before the audit)', () => {
    const sizes = content.packages.flatMap((pkg) => LANGS.map((lang) => ({ key: `${pkg.topic.key}/${lang}`, n: tokens(buildSystemPrompt(pkg, lang)) })));
    const over = sizes.filter((s) => s.n > 4300);
    expect(over, JSON.stringify(over)).toEqual([]);
    const median = sizes.map((s) => s.n).sort((a, b) => a - b)[sizes.length >> 1];
    // v0.9.1: compact material + terse rules (was < 3200).
    expect(median).toBeLessThan(2700);
  });

  it('chat sends the compact material (≥ 15 % smaller); generation keeps the full one', () => {
    const pkg = content.packages.find((p) => p.topic.key === 'speed')!;
    const compact = buildSystemPrompt(pkg, 'ky');
    const full = buildSystemPrompt(pkg, 'ky', '', 'full');
    expect(tokens(compact)).toBeLessThan(tokens(full) * 0.85);
    // What answers are built from stays: every structure, its description and the mistakes with corrections.
    for (const c of pkg.concepts.filter((x) => pkg.topic.conceptKeys.includes(x.key))) expect(compact).toContain(`[[${c.key}]]`);
    expect(compact).toContain('mistake:');
    expect(compact).not.toContain('related:');
    expect(compact).not.toContain('Goal:');
    expect(full).toContain('related:');
  });

  it('sends only the glossary terms the topic uses, in the answer language', () => {
    const pkg = content.packages.find((p) => p.topic.key === 'speed')!;
    const sys = buildSystemPrompt(pkg, 'ky');
    const terms = sys.split('## Terms (use exactly these words)\n')[1] ?? '';
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).not.toMatch(/\(ky: |ru: |en: /);
    // a physics glossary term this topic never mentions is not sent
    const unused = pkg.glossary.find((g) => !sys.includes(g.ky) && g.ky.length > 4);
    if (unused) expect(terms).not.toContain(unused.ky);
  });
});

describe('assistant prompt: a reusable, cache-friendly shell', () => {
  it('the system prompt depends only on topic + language (the question and the screen go to the messages)', () => {
    const pkg = content.packages[0];
    const a = buildSystemPrompt(pkg, 'ru');
    expect(buildSystemPrompt(pkg, 'ru')).toBe(a);
    const q = wrapQuestion('Что такое ядро?', { focus: { key: 'x.y', title: 'X' }, mode: 'lesson' });
    expect(a).not.toContain('Что такое ядро?');
    expect(q).toContain('<question>');
  });

  it('rules + the subject guide come first and are identical for every topic of a subject (shared cache prefix)', () => {
    const phys = content.packages.filter((p) => p.subject.key === 'phys');
    expect(phys.length).toBeGreaterThan(1);
    const prefix = (s: string) => s.slice(0, s.indexOf('=== TOPIC MATERIAL ==='));
    const prefixes = new Set(phys.map((p) => prefix(buildSystemPrompt(p, 'ky'))));
    expect(prefixes.size).toBe(1);
    const [only] = [...prefixes];
    expect(only).toContain('Subject guide — Physics.');
    expect(only).toContain('not Kazakh');
    // another subject shares the rules but has its own guide
    const chem = content.packages.find((p) => p.subject.key === 'chem')!;
    expect(prefix(buildSystemPrompt(chem, 'ky'))).toContain('Subject guide — Chemistry.');
  });
});

describe('history budget', () => {
  it('keeps the latest turns within the budget, trims long ones, starts with the user', () => {
    const long = 'х'.repeat(2000);
    const h = [
      { role: 'user' as const, text: 'q1' },
      { role: 'assistant' as const, text: long },
      { role: 'user' as const, text: 'q2' },
      { role: 'assistant' as const, text: long },
      { role: 'user' as const, text: 'q3' },
      { role: 'assistant' as const, text: 'a3' },
    ];
    const out = trimHistory(h);
    const chars = out.reduce((n, m) => n + m.text.length, 0);
    expect(chars).toBeLessThanOrEqual(2400);
    expect(out.at(-1)).toEqual({ role: 'assistant', text: 'a3' });
    expect(out[0].role).toBe('user');
    expect(out.every((m) => m.text.length <= 601)).toBe(true);
  });
});

describe('usage cost (v0.9.1)', () => {
  it('cache hits are billed at the cache price, the rest of the input at the full price', async () => {
    const { usageCostUsd } = await import('../config.js');
    const prices = { input: 0.15, inputCached: 0.003, output: 0.6 };
    // The measured six questions: 14 502 in (3 072 hits), 697 out.
    expect(usageCostUsd({ inputTokens: 14_502, cachedInputTokens: 3_072, outputTokens: 697 }, prices)).toBeCloseTo(0.002146, 5);
    expect(usageCostUsd({ inputTokens: 1000, outputTokens: 0 }, prices)).toBeCloseTo(0.00015, 8);
    // A provider that reports more hits than input never makes the cost negative.
    expect(usageCostUsd({ inputTokens: 10, cachedInputTokens: 50, outputTokens: 0 }, prices)).toBeCloseTo(0.00000003, 10);
  });
});
