import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  DEFAULT_LANG,
  ConceptSchema,
  ExamplesSchema,
  L,
  LANGS,
  LocalizedSchema,
  PROPERTY_TYPES,
  SceneSpecSchema,
  SubjectSchema,
  TopicSchema,
  QuizSpecSchema,
  applyOverride,
  conceptForNode,
  findConcept,
  findForbidden,
  formatPropValue,
  gradeSegment,
  isLang,
  matchesNodeMask,
  missingLangs,
  parseContentPackage,
  parseGradeSegment,
  propertyType,
  subjectModelCount,
  summarizeTopic,
  t,
  topicConcepts,
  topicsOfSubject,
  unreviewedLangs,
  type Catalog,
  type ConceptProp,
} from './index.js';
import { CONTRACT_VERSION as PERM_VERSION } from '@bilig/permissions';
import { animalCellCatalog, animalCellPackage } from './fixtures/animal-cell.js';

describe('contract version', () => {
  it('matches package.json and @bilig/permissions', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(CONTRACT_VERSION).toBe(pkg.version);
    expect(CONTRACT_VERSION).toBe(PERM_VERSION);
  });
});

describe('i18n', () => {
  it('t() resolves lang → ky → ru → en, skipping empty strings', () => {
    const v = { ky: 'Суу', ru: 'Вода', en: 'Water' };
    expect(t(v, 'en')).toBe('Water');
    expect(t({ ky: '', ru: 'Вода', en: 'Water' }, 'ky')).toBe('Вода');
    expect(t({ ky: '', ru: '', en: 'Water' }, 'ru')).toBe('Water');
    expect(t({ ky: 'Суу', ru: '', en: '' }, 'en')).toBe('Суу');
    expect(t(undefined, 'ky')).toBe('');
    expect(t({}, 'ky')).toBe('');
  });

  it('ky is primary; isLang guards', () => {
    expect(DEFAULT_LANG).toBe('ky');
    expect(LANGS).toEqual(['ky', 'ru', 'en']);
    expect(isLang('ru')).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang(3)).toBe(false);
  });

  it('LocalizedSchema requires all keys and at least one value', () => {
    expect(LocalizedSchema.safeParse(L('a')).success).toBe(true);
    expect(LocalizedSchema.safeParse({ ky: '', ru: 'x', en: '' }).success).toBe(true);
    expect(LocalizedSchema.safeParse({ ky: '', ru: '', en: '' }).success).toBe(false);
    expect(LocalizedSchema.safeParse({ ru: 'x' }).success).toBe(false);
  });

  it('missingLangs / unreviewedLangs', () => {
    expect(missingLangs({ ky: 'a', ru: ' ', en: '' })).toEqual(['ru', 'en']);
    expect(missingLangs(undefined)).toEqual(['ky', 'ru', 'en']);
    expect(unreviewedLangs({ ky: 'reviewed', ru: 'machine' })).toEqual(['ru', 'en']);
  });
});

describe('curriculum', () => {
  it('grade segments round-trip', () => {
    expect(gradeSegment(7)).toBe('g7');
    expect(parseGradeSegment('g7')).toBe(7);
    expect(parseGradeSegment('g12')).toBeNull();
    expect(parseGradeSegment('7')).toBeNull();
  });

  it('subject hue must be 0–359 and status soon|live', () => {
    const s = animalCellPackage.subject;
    expect(SubjectSchema.safeParse({ ...s, hue: 360 }).success).toBe(false);
    expect(SubjectSchema.safeParse({ ...s, hue: 0 }).success).toBe(true);
    expect(SubjectSchema.safeParse({ ...s, status: 'coming' }).success).toBe(false);
    expect(SubjectSchema.safeParse({ ...s, key: 'Bio Logy' }).success).toBe(false);
  });
});

describe('concepts & property types', () => {
  it('dictionary carries the TZ property types with icon, value kind and unit', () => {
    for (const k of [
      'size', 'location', 'foundIn', 'analogy', 'atomicNumber', 'electronegativity',
      'formula', 'molarMass', 'shape', 'volume', 'mass', 'temperature',
    ]) {
      expect(PROPERTY_TYPES[k], k).toBeDefined();
      expect(PROPERTY_TYPES[k].icon).toBeTruthy();
    }
    expect(PROPERTY_TYPES.molarMass).toMatchObject({ valueKind: 'quantity', unit: 'g/mol' });
    expect(PROPERTY_TYPES.formula.valueKind).toBe('formula');
    expect(PROPERTY_TYPES.location.valueKind).toBe('text');
  });

  it('propertyType: package extensions win over built-ins', () => {
    const extra = [{ key: 'size', label: L('x'), icon: 'i', valueKind: 'text' as const }];
    expect(propertyType('size', extra)?.valueKind).toBe('text');
    expect(propertyType('nope')).toBeUndefined();
  });

  it('formatPropValue formats numbers per language with dictionary units', () => {
    const q: ConceptProp = { kind: 'quantity', type: 'molarMass', value: 18.015 };
    expect(formatPropValue(q, 'en')).toBe('18.015 g/mol');
    expect(formatPropValue(q, 'ru')).toBe('18,015 g/mol');
    expect(formatPropValue({ kind: 'quantity', type: 'size', value: 7, max: 10, unit: 'nm' }, 'en')).toBe('7–10 nm');
    expect(formatPropValue({ kind: 'quantity', type: 'count', value: 1200, approx: true }, 'en')).toBe('≈1,200');
    expect(formatPropValue({ kind: 'text', type: 'location', value: L('ky', 'ru', 'en') }, 'ru')).toBe('ru');
    expect(formatPropValue({ kind: 'formula', type: 'formula', value: 'H_2O' }, 'ky')).toBe('H_2O');
  });

  it('every concept requires stem + simple examples', () => {
    const c = animalCellPackage.concepts[0];
    expect(ConceptSchema.safeParse(c).success).toBe(true);
    expect(ConceptSchema.safeParse({ ...c, examples: { stem: [], simple: c.examples.simple } }).success).toBe(false);
    const { examples: _e, ...noExamples } = c;
    expect(ConceptSchema.safeParse(noExamples).success).toBe(false);
    expect(
      ExamplesSchema.safeParse({ stem: [{ title: L('a'), text: L('b'), field: 'x' }], simple: [{ title: L('a'), text: L('b') }] }).success,
    ).toBe(false);
  });

  it('applyOverride merges field by field and adds anchor/nodes', () => {
    const mito = animalCellPackage.concepts.find((c) => c.key === 'bio.mitochondrion')!;
    const r = applyOverride(mito, animalCellPackage.topic.overrides['bio.mitochondrion']);
    expect(r.subtitle?.en).toBe('Power station');
    expect(r.anchor).toEqual([1.4, -0.3, 0.6]);
    expect(r.title).toEqual(mito.title);
    expect(applyOverride(mito)).toEqual(mito);
    expect(applyOverride(mito, { hue: undefined }).hue).toBe(mito.hue);
  });

  it('node masks bind GLB nodes to concepts (A-06 Mito_*)', () => {
    expect(matchesNodeMask('Mito_03', 'Mito_*')).toBe(true);
    expect(matchesNodeMask('Mito', 'Mito_*')).toBe(false);
    expect(matchesNodeMask('a.b', 'a?b')).toBe(true);
    expect(matchesNodeMask('axb', 'a.b')).toBe(false);
    const concepts = topicConcepts(animalCellPackage);
    expect(conceptForNode('Mito_12', concepts)).toBe('bio.mitochondrion');
    expect(conceptForNode('Nucleus', concepts)).toBe('bio.nucleus');
    expect(conceptForNode('Golgi', concepts)).toBeNull();
  });
});

describe('topic schema', () => {
  const topic = animalCellPackage.topic;

  it('accepts the fixture topic and requires examples', () => {
    expect(TopicSchema.safeParse(topic).success).toBe(true);
    const { examples: _e, ...rest } = topic;
    expect(TopicSchema.safeParse(rest).success).toBe(false);
  });

  it('scene plugin is an open string; gltf requires an asset, generators need params', () => {
    expect(SceneSpecSchema.safeParse({ plugin: 'gltf', modes: [] }).success).toBe(false);
    expect(SceneSpecSchema.safeParse({ plugin: 'molecule', params: { smiles: 'O' }, modes: [] }).success).toBe(true);
    expect(SceneSpecSchema.safeParse({ plugin: 'my-new-plugin', params: {}, modes: [] }).success).toBe(true);
    expect(SceneSpecSchema.safeParse({ plugin: 'crystal', modes: [] }).success).toBe(false);
    expect(SceneSpecSchema.safeParse({ plugin: 'Bad Plugin', params: {}, modes: [] }).success).toBe(false);
  });

  it('quiz sampleSize cannot exceed the item list', () => {
    expect(QuizSpecSchema.safeParse({ itemKeys: ['a'], sampleSize: 2 }).success).toBe(false);
    expect(QuizSpecSchema.safeParse({ itemKeys: ['a', 'b'], sampleSize: 2 }).success).toBe(true);
  });

  it('i18n map only accepts known locales and statuses', () => {
    expect(TopicSchema.safeParse({ ...topic, i18n: { de: 'reviewed' } }).success).toBe(false);
    expect(TopicSchema.safeParse({ ...topic, i18n: { ky: 'done' } }).success).toBe(false);
  });
});

describe('package helpers & catalog', () => {
  it('parseContentPackage returns the typed package / throws on garbage', () => {
    expect(parseContentPackage(animalCellPackage).topic.key).toBe('animal-cell');
    expect(() => parseContentPackage({ manifest: {} })).toThrow();
  });

  it('summarizeTopic carries counts for the catalog card (W-02)', () => {
    const s = summarizeTopic(animalCellPackage);
    expect(s).toMatchObject({
      key: 'animal-cell',
      subjectKey: 'bio',
      version: '1.0.0',
      counts: { concepts: 3, models: 2, processes: 1, items: 5 },
      thumb: 'thumbs/animal-cell.webp',
    });
  });

  it('topicsOfSubject orders by grade then unit order; subjectModelCount sums models', () => {
    const base = animalCellCatalog.topics[0];
    const catalog: Catalog = {
      ...animalCellCatalog,
      courses: [...animalCellCatalog.courses, { ...animalCellCatalog.courses[0], key: 'bio.g6', grade: 6 }],
      units: [...animalCellCatalog.units, { key: 'bio.g6.u', courseKey: 'bio.g6', order: 5, title: L('u') }],
      topics: [
        base,
        { ...base, key: 'z-early', unitKey: 'bio.g6.u' },
        { ...base, key: 'orphan', unitKey: 'nowhere' },
        { ...base, key: 'chem-x', subjectKey: 'chem' },
      ],
    };
    expect(topicsOfSubject(catalog, 'bio').map((x) => x.key)).toEqual(['z-early', 'animal-cell', 'orphan']);
    expect(subjectModelCount(catalog, 'bio')).toBe(6);
    expect(subjectModelCount(catalog, 'phys')).toBe(0);
  });

  it('topicConcepts follows conceptKeys order with overrides; findConcept', () => {
    expect(topicConcepts(animalCellPackage).map((c) => c.key)).toEqual([
      'bio.membrane', 'bio.nucleus', 'bio.mitochondrion',
    ]);
    expect(findConcept(animalCellPackage, 'bio.nucleus')?.anchor).toEqual([0, 0.2, 0]);
    expect(findConcept(animalCellPackage, 'nope')).toBeUndefined();
  });
});

describe('glossary', () => {
  it('finds forbidden variants as whole words and suggests the approved term', () => {
    const g = animalCellPackage.glossary;
    expect(findForbidden('Каждый органоид важен', g, 'ru')).toEqual([
      { termId: 'g-organelle', variant: 'органоид', suggestion: 'органелла' },
    ]);
    expect(findForbidden('органоиды', g, 'ru')).toEqual([]);
    expect(findForbidden('all good', g, 'en')).toEqual([]);
  });
});
