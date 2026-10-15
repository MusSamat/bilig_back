import { describe, it, expect } from 'vitest';
import {
  assertValidPackage,
  checkExamples,
  validatePackage,
  L,
  type ContentPackage,
  type ValidationIssue,
} from './index.js';
import { animalCellPackage } from './fixtures/animal-cell.js';

const clone = (): ContentPackage => structuredClone(animalCellPackage);
const errors = (pkg: unknown): ValidationIssue[] =>
  validatePackage(pkg).issues.filter((i) => i.severity === 'error');
const warnings = (pkg: unknown): ValidationIssue[] =>
  validatePackage(pkg).issues.filter((i) => i.severity === 'warning');
const has = (issues: ValidationIssue[], code: string, path: (string | number)[]) =>
  issues.some((i) => i.code === code && i.path.join('.') === path.join('.'));

describe('validatePackage — Stage-0 acceptance (TZ §11)', () => {
  it('the migrated animal-cell fixture validates with no issues', () => {
    const res = validatePackage(animalCellPackage);
    expect(res.issues).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.data?.topic.key).toBe('animal-cell');
  });

  it('schema failures are reported with paths and no data', () => {
    const bad = clone() as unknown as { subject: { hue: number } };
    bad.subject.hue = 400;
    const res = validatePackage(bad);
    expect(res.ok).toBe(false);
    expect(res.data).toBeUndefined();
    expect(has(res.issues, 'schema', ['subject', 'hue'])).toBe(true);
  });

  it('assertValidPackage throws with the first error', () => {
    const bad = clone();
    bad.topic.conceptKeys.push('bio.ghost');
    expect(() => assertValidPackage(bad)).toThrow(/topic\.conceptKeys\.3/);
    expect(assertValidPackage(animalCellPackage).topic.key).toBe('animal-cell');
    expect(() => assertValidPackage({})).toThrow(/Invalid content package/);
  });
});

describe('cross-reference checks', () => {
  const cases: [string, (p: ContentPackage) => void, string, (string | number)[]][] = [
    ['topic concept key', (p) => p.topic.conceptKeys.push('bio.ghost'), 'concept_missing', ['topic', 'conceptKeys', 3]],
    ['duplicate concept', (p) => p.concepts.push(structuredClone(p.concepts[0])), 'duplicate_key', ['concepts', 3]],
    ['related missing', (p) => p.concepts[0].related.push('bio.ghost'), 'related_missing', ['concepts', 0, 'related', 1]],
    ['related self', (p) => p.concepts[0].related.push('bio.membrane'), 'related_self', ['concepts', 0, 'related', 1]],
    ['override unknown', (p) => (p.topic.overrides['bio.ghost'] = { hue: 1 }), 'override_unknown', ['topic', 'overrides', 'bio.ghost']],
    ['process key', (p) => p.topic.activities.processKeys.push('bio.ghost'), 'process_missing', ['topic', 'activities', 'processKeys', 1]],
    ['process step concept', (p) => (p.processes[0].steps[1].conceptKey = 'bio.ghost'), 'concept_missing', ['processes', 0, 'steps', 1, 'conceptKey']],
    ['duplicate step', (p) => (p.processes[0].steps[1].key = 'glycolysis'), 'duplicate_key', ['processes', 0, 'steps', 1]],
    ['comparison concept column', (p) => (p.topic.activities.comparison!.columns[0] = { kind: 'concept', key: 'bio.ghost' }), 'column_missing', ['topic', 'activities', 'comparison', 'columns', 0]],
    ['comparison sample column', (p) => (p.topic.activities.comparison!.columns[1] = { kind: 'sample', key: 'ghost' }), 'column_missing', ['topic', 'activities', 'comparison', 'columns', 1]],
    ['comparison row type', (p) => p.topic.activities.comparison!.rows.push('colour'), 'property_type_unknown', ['topic', 'activities', 'comparison', 'rows', 2]],
    ['manual cell column', (p) => (p.topic.activities.comparison!.manual = [{ column: 'x', row: 'size', value: L('a') }]), 'column_missing', ['topic', 'activities', 'comparison', 'manual', 0, 'column']],
    ['manual cell row', (p) => (p.topic.activities.comparison!.manual = [{ column: 'bio.nucleus', row: 'mass', value: L('a') }]), 'row_missing', ['topic', 'activities', 'comparison', 'manual', 0, 'row']],
    ['quiz item', (p) => (p.topic.activities.quiz!.itemKeys[0] = 'bio.q.ghost'), 'item_missing', ['topic', 'activities', 'quiz', 'itemKeys', 0]],
    ['single answer not in options', (p) => { const i = p.items[0]; if (i.type === 'single') i.answer = 'z'; }, 'answer_not_in_options', ['items', 0, 'answer']],
    ['multiple answer not in options', (p) => { const i = p.items[1]; if (i.type === 'multiple') i.answer.push('z'); }, 'answer_not_in_options', ['items', 1, 'answer', 2]],
    ['duplicate option', (p) => { const i = p.items[0]; if (i.type === 'single') i.options[1].key = 'a'; }, 'duplicate_key', ['items', 0, 'options', 1]],
    ['duplicate match pair', (p) => { const i = p.items[2]; if (i.type === 'match') i.pairs[1].key = 'nucleus'; }, 'duplicate_key', ['items', 2, 'pairs', 1]],
    ['find-on-model target', (p) => { const i = p.items[3]; if (i.type === 'find-on-model') i.targetConceptKey = 'bio.ghost'; }, 'concept_missing', ['items', 3, 'targetConceptKey']],
    ['misconception', (p) => (p.items[0].misconceptionKey = 'bio.m.ghost'), 'misconception_missing', ['items', 0, 'misconceptionKey']],
    ['tour focus', (p) => (p.topic.activities.tour!.steps[1].focus = 'bio.ghost'), 'concept_missing', ['topic', 'activities', 'tour', 'steps', 1, 'focus']],
    ['tour visibility', (p) => (p.topic.activities.tour!.steps[1].visibility = { hide: ['bio.ghost'] }), 'concept_missing', ['topic', 'activities', 'tour', 'steps', 1, 'visibility', 'hide', 0]],
    ['duplicate tour step', (p) => (p.topic.activities.tour!.steps[2].key = 'overview'), 'duplicate_key', ['topic', 'activities', 'tour', 'steps', 2]],
    ['property type', (p) => p.concepts[1].props.push({ kind: 'text', type: 'colour', value: L('a') }), 'property_type_unknown', ['concepts', 1, 'props', 3, 'type']],
    ['property kind', (p) => p.concepts[1].props.push({ kind: 'text', type: 'mass', value: L('a') }), 'property_kind_mismatch', ['concepts', 1, 'props', 3, 'kind']],
    ['override prop type', (p) => (p.topic.overrides['bio.nucleus'].props = [{ kind: 'text', type: 'colour', value: L('a') }]), 'property_type_unknown', ['topic', 'overrides', 'bio.nucleus', 'props', 0, 'type']],
    ['topic example ky', (p) => (p.topic.examples.stem[0].text.ky = ''), 'example_translation_missing', ['topic', 'examples', 'stem', 0, 'text']],
    ['concept example en', (p) => (p.concepts[2].examples.simple[0].title.en = ' '), 'example_translation_missing', ['concepts', 2, 'examples', 'simple', 0, 'title']],
    ['override example', (p) => (p.topic.overrides['bio.nucleus'].examples = { stem: [{ title: L('a', '', 'c'), text: L('a') }], simple: [{ title: L('a'), text: L('b') }] }), 'example_translation_missing', ['topic', 'overrides', 'bio.nucleus', 'examples', 'stem', 0, 'title']],
    ['manifest topic', (p) => (p.manifest.topicKey = 'other'), 'manifest_topic_mismatch', ['manifest', 'topicKey']],
    ['unit mismatch', (p) => (p.unit!.key = 'bio.g7.other'), 'unit_mismatch', ['unit', 'key']],
    ['course mismatch', (p) => (p.unit!.courseKey = 'bio.g8'), 'course_mismatch', ['unit', 'courseKey']],
    ['subject mismatch', (p) => (p.course!.subjectKey = 'chem'), 'subject_mismatch', ['course', 'subjectKey']],
    ['topic objective', (p) => p.topic.objectiveKeys.push('bio.o.ghost'), 'objective_missing', ['topic', 'objectiveKeys', 1]],
    ['duplicate glossary', (p) => p.glossary.push(structuredClone(p.glossary[0])), 'duplicate_key', ['glossary', 1]],
  ];

  it.each(cases)('%s', (_name, mutate, code, path) => {
    const pkg = clone();
    mutate(pkg);
    const res = validatePackage(pkg);
    expect(res.ok).toBe(false);
    expect(
      res.issues.filter((i) => i.severity === 'error').map((i) => `${i.code}@${i.path.join('.')}`),
    ).toContain(`${code}@${path.join('.')}`);
  });

  it('warnings do not fail validation', () => {
    const pkg = clone();
    pkg.processes.push({ ...structuredClone(pkg.processes[0]), key: 'bio.unused' });
    pkg.concepts.push({ ...structuredClone(pkg.concepts[0]), key: 'bio.lonely', related: [] });
    pkg.topic.scene.asset = 'models/missing.glb';
    pkg.topic.activities.tour!.steps[0].altText = L('only ky', '', '');
    pkg.topic.i18n = { en: 'machine' };
    pkg.topic.activities.comparison!.manual = [{ column: 'bio.nucleus', row: 'size', value: L('x') }];
    pkg.items[0].objectiveKeys.push('bio.o.ghost');
    const res = validatePackage(pkg);
    expect(res.ok).toBe(true);
    const w = warnings(pkg).map((i) => i.code);
    expect(w).toEqual(
      expect.arrayContaining([
        'process_unused',
        'concept_unused',
        'asset_not_in_manifest',
        'alt_text_incomplete',
        'machine_translation',
        'manual_shadows_dictionary',
        'objective_missing',
      ]),
    );
    expect(errors(pkg)).toEqual([]);
  });

  it('concepts referenced only via process steps/comparison count as used', () => {
    const pkg = clone();
    pkg.topic.conceptKeys = ['bio.membrane', 'bio.nucleus'];
    delete pkg.topic.overrides['bio.mitochondrion'];
    pkg.items = pkg.items.filter((i) => i.type !== 'find-on-model' || i.targetConceptKey !== 'bio.mitochondrion');
    expect(warnings(pkg).map((i) => i.code)).not.toContain('concept_unused');
  });

  it('checkExamples reports nothing for complete examples', () => {
    expect(checkExamples(animalCellPackage.topic.examples, ['x'])).toEqual([]);
  });
});
