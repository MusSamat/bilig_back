import { describe, expect, it } from 'vitest';
import { animalCellPackage as pkg } from './fixtures/animal-cell.js';
import { draftSignature, glossaryMatches, groundedAnswer, groundedGenerate, suggestQuestions } from './assist.js';
import { LANGS, t } from './i18n.js';
import { topicConcepts } from './package.js';

const nucleus = topicConcepts(pkg).find((c) => c.key === 'bio.nucleus')!;

describe('suggestQuestions', () => {
  it('asks about the focus concept in every language', () => {
    for (const lang of LANGS) {
      const qs = suggestQuestions(pkg, lang, { conceptKey: 'bio.nucleus' });
      expect(qs).toHaveLength(3);
      expect(qs.join(' ').toLocaleLowerCase()).toContain(t(nucleus.title, lang).toLocaleLowerCase());
    }
  });
  it('falls back to the topic without a focus; a process comes first', () => {
    const qs = suggestQuestions(pkg, 'ru');
    expect(qs[0].toLocaleLowerCase()).toContain(t(pkg.topic.title, 'ru').toLocaleLowerCase());
    const p = pkg.processes[0];
    if (p) expect(suggestQuestions(pkg, 'en', { processKey: p.key })[0]).toContain(t(p.title, 'en'));
  });
});

describe('groundedAnswer (dev provider / mock API)', () => {
  it('answers from the matching concept with a citation marker', () => {
    const a = groundedAnswer(pkg, 'ru', { question: `Что делает ${t(nucleus.title, 'ru').toLowerCase()}?` });
    expect(a.noAnswer).toBe(false);
    expect(a.text).toContain('[[bio.nucleus]]');
    expect(a.text).toContain(t(nucleus.description, 'ru'));
  });
  it('off-topic without focus or quote → no answer', () => {
    const a = groundedAnswer(pkg, 'en', { question: 'Who won the football match?' });
    expect(a).toEqual({ text: expect.stringContaining('[[no-answer]]'), noAnswer: true });
  });
  it('a vague follow-up is answered about the focus; intents change the shape', () => {
    expect(groundedAnswer(pkg, 'ru', { question: 'А сколько их?', conceptKey: 'bio.nucleus' }).text).toContain('[[bio.nucleus]]');
    const simpler = groundedAnswer(pkg, 'ru', { question: 'Проще', conceptKey: 'bio.nucleus', intent: 'simpler' });
    expect(simpler.text).toMatch(/^Проще говоря:/);
    const ex = groundedAnswer(pkg, 'en', { question: 'Example', quote: t(nucleus.description, 'en'), intent: 'example' });
    expect(ex.text).toContain('For example:');
  });
});

describe('groundedGenerate', () => {
  it('quiz: valid single-choice items, answer among options, deterministic, avoid list respected', () => {
    const a = groundedGenerate(pkg, 'ru', 'quiz', { conceptKey: 'bio.nucleus', count: 3 });
    expect(a.quiz.length).toBeGreaterThan(0);
    for (const q of a.quiz) {
      expect(q.options.map((o) => o.key)).toContain(q.answer);
      expect(new Set(q.options.map((o) => o.key)).size).toBe(q.options.length);
      expect(q.prompt).not.toContain('[[');
    }
    expect(a.quiz[0].conceptKey).toBe('bio.nucleus');
    expect(groundedGenerate(pkg, 'ru', 'quiz', { conceptKey: 'bio.nucleus', count: 3 })).toEqual(a);
    const b = groundedGenerate(pkg, 'ru', 'quiz', { conceptKey: 'bio.nucleus', count: 3, avoid: a.quiz.map((q) => draftSignature(q.prompt)) });
    expect(b.quiz.map((q) => q.prompt)).not.toContain(a.quiz[0].prompt);
  });
  it('examples never repeat what the card shows', () => {
    for (const kind of ['simple', 'stem'] as const) {
      const r = groundedGenerate(pkg, 'en', kind, { conceptKey: 'bio.nucleus', count: 5 });
      const shown = nucleus.examples[kind].map((e) => t(e.text, 'en'));
      expect(r.examples.length).toBeGreaterThan(0);
      for (const e of r.examples) expect(shown).not.toContain(e.text);
      if (kind === 'stem') expect(r.examples.every((e) => !e.field || ['s', 't', 'e', 'm'].includes(e.field))).toBe(true);
    }
  });
});

describe('glossaryMatches', () => {
  it('finds glossary terms in a selection in any language', () => {
    const g = pkg.glossary[0];
    if (!g) return;
    expect(glossaryMatches(pkg, `Текст про ${g.ru} и не только`).map((m) => m.id)).toContain(g.id);
    expect(glossaryMatches(pkg, '   ')).toEqual([]);
  });
});
