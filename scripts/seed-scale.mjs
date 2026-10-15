#!/usr/bin/env node
/**
 * Synthetic content for the TZ §10 scale test: 20 subjects, 2000 topics,
 * 10 000 concepts, 5 languages — valid per @bilig/content-model.
 *
 *   npx tsx scripts/seed-scale.mjs [outDir] [--subjects=20] [--topics=2000] [--concepts=10000] [--no-validate]
 *
 * Writes the same layout as content/ (catalog.json + packages/<topicKey>.json)
 * into outDir (default: a fresh directory under the OS temp dir), validates
 * every package with validatePackage, then loads the directory through the
 * server's content repo and prints timings, so `CONTENT_DIR=<outDir>` style
 * tests and e2e runs can point at it.
 *
 * Note: the contract's Localized type has exactly ky/ru/en. The two extra
 * languages (uz, tr) are written as additional keys; Zod accepts and strips
 * them, so they prove the data volume but are not yet servable (see README).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ITEM_TYPES, validatePackage } from '@bilig/content-model';
import { loadContentRepo } from '../src/content-repo.ts';

const args = process.argv.slice(2);
const opt = (name, def) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const N_SUBJECTS = opt('subjects', 20);
const N_TOPICS = opt('topics', 2000);
const N_CONCEPTS = opt('concepts', 10000);
const VALIDATE = !args.includes('--no-validate');
const outArg = args.find((a) => !a.startsWith('--'));
const OUT = outArg ? resolve(outArg) : mkdtempSync(join(tmpdir(), 'bilig-scale-'));

const LANGS5 = ['ky', 'ru', 'en', 'uz', 'tr'];
const WORD = {
  ky: ['Тема', 'Түшүнүк', 'Предмет', 'Бөлүм', 'Курс', 'Мисал', 'Окшоштук', 'Суроо', 'Жооп', 'Түшүндүрмө', 'Кадам', 'Жыйынтык'],
  ru: ['Тема', 'Понятие', 'Предмет', 'Раздел', 'Курс', 'Пример', 'Аналогия', 'Вопрос', 'Ответ', 'Пояснение', 'Шаг', 'Результат'],
  en: ['Topic', 'Concept', 'Subject', 'Unit', 'Course', 'Example', 'Analogy', 'Question', 'Answer', 'Explanation', 'Step', 'Result'],
  uz: ['Mavzu', 'Tushuncha', 'Fan', "Bo'lim", 'Kurs', 'Misol', "O'xshatish", 'Savol', 'Javob', 'Izoh', 'Qadam', 'Natija'],
  tr: ['Konu', 'Kavram', 'Ders', 'Ünite', 'Kurs', 'Örnek', 'Benzetme', 'Soru', 'Cevap', 'Açıklama', 'Adım', 'Sonuç'],
};
const W = { topic: 0, concept: 1, subject: 2, unit: 3, course: 4, example: 5, analogy: 6, question: 7, answer: 8, explanation: 9, step: 10, result: 11 };
/** Localized value in 5 languages: `<word> <n>` (long Kyrgyz-like suffix to stress layouts). */
const L = (w, n, suffix = '') =>
  Object.fromEntries(LANGS5.map((l) => [l, `${WORD[l][W[w]]} ${n}${suffix}${l === 'ky' ? ' — узундугу текшерилүүчү' : ''}`]));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ex = (n) => ({
  stem: ['s', 't', 'e', 'm'].slice(0, 2).map((field, i) => ({ field, title: L('example', `${n}.${i}`), text: L('explanation', `${n}.${i}`) })),
  simple: [0, 1].map((i) => ({ title: L('analogy', `${n}.${i}`), text: L('explanation', `${n}.a${i}`) })),
});

const t0 = performance.now();
rmSync(join(OUT, 'packages'), { recursive: true, force: true });
mkdirSync(join(OUT, 'packages'), { recursive: true });

const groups = ['natural', 'exact', 'earth-space', 'humanities'].map((key, order) => ({ key, order, title: L('subject', `group ${key}`) }));
const subjects = [];
const courses = [];
const units = [];
for (let s = 0; s < N_SUBJECTS; s++) {
  const key = `s${s}`;
  subjects.push({ key, title: L('subject', s), icon: 'shapes', hue: Math.round((s * 360) / N_SUBJECTS) % 360, group: groups[s % groups.length].key, order: s, status: s % 10 === 9 ? 'soon' : 'live' });
}
const live = subjects.filter((s) => s.status === 'live');
for (const s of live)
  for (const grade of [5, 6, 7, 8, 9, 10, 11]) {
    const course = { key: `${s.key}.g${grade}`, subjectKey: s.key, grade, curriculum: 'kg-2024', title: L('course', `${s.key}-${grade}`) };
    courses.push(course);
    for (let u = 1; u <= 3; u++) units.push({ key: `${course.key}.u${u}`, courseKey: course.key, order: u, title: L('unit', `${course.key}-${u}`) });
  }

const perTopic = Math.max(1, Math.floor(N_CONCEPTS / N_TOPICS));
let conceptCounter = 0;
let errors = 0;
let bytes = 0;
for (let t = 0; t < N_TOPICS; t++) {
  const unit = units[t % units.length];
  const course = courses.find((c) => c.key === unit.courseKey);
  const subject = subjects.find((s) => s.key === course.subjectKey);
  const key = `topic-${t}`;
  const objective = { key: `${unit.key}.o1`, code: `${subject.key.toUpperCase()}-${course.grade}.${unit.order}.1`, unitKey: unit.key, text: L('explanation', `objective ${unit.key}`) };
  const n = t === N_TOPICS - 1 ? N_CONCEPTS - conceptCounter : perTopic;
  const concepts = Array.from({ length: n }, (_, i) => {
    const ck = `${subject.key}.c${conceptCounter + i}`;
    return {
      key: ck,
      kind: i === 0 ? 'shell' : 'part',
      hue: (conceptCounter + i) % 360,
      isContainer: i === 0,
      title: L('concept', conceptCounter + i),
      description: L('explanation', `c${conceptCounter + i}`),
      props: [
        { kind: 'quantity', type: 'size', value: 1 + i, unit: 'µm' },
        { kind: 'text', type: 'function', value: L('result', `f${i}`) },
      ],
      related: n > 1 ? [`${subject.key}.c${conceptCounter + ((i + 1) % n)}`] : [],
      misconceptions: [{ key: `${subject.key}.m${conceptCounter + i}`, text: L('question', `m${i}`), correction: L('answer', `m${i}`) }],
      funFact: L('result', `fact ${i}`),
      analogy: L('analogy', i),
      examples: ex(`c${conceptCounter + i}`),
    };
  });
  conceptCounter += n;
  const ck = concepts.map((c) => c.key);
  const base = (k, type, extra) => ({ key: `${key}.q.${k}`, type, prompt: L('question', `${key}-${k}`), explanation: L('explanation', k), objectiveKeys: [objective.key], difficulty: 1 + (t % 5), ...extra });
  const opts = [0, 1, 2].map((o) => ({ key: `o${o}`, text: L('answer', o) }));
  const items = [
    base('single', 'single', { options: opts, answer: 'o1' }),
    base('multiple', 'multiple', { options: opts, answer: ['o0', 'o2'] }),
    base('match', 'match', { pairs: [0, 1].map((p) => ({ key: `p${p}`, left: L('concept', p), right: L('result', p) })) }),
    base('find', 'find-on-model', { targetConceptKey: ck[ck.length - 1] }),
    base('numeric', 'numeric', { answer: 42, tolerance: 0.5, unit: 'g/mol' }),
    base('single2', 'single', { options: opts, answer: 'o0', misconceptionKey: concepts[0].misconceptions[0].key }),
  ];
  const process = {
    key: `${key}.process`,
    engine: ['timeline', 'stoich', 'ode'][t % 3],
    title: L('topic', `process ${t}`),
    icon: 'play',
    description: L('explanation', `process ${t}`),
    inputs: L('step', 'in'),
    outputs: L('result', 'out'),
    steps: ck.slice(0, 3).map((c, i) => ({ key: `s${i}`, title: L('step', i), result: L('result', i), description: L('explanation', `s${i}`), conceptKey: c, altText: L('explanation', `alt ${i}`), duration: 1 + i })),
    metrics: [{ key: 'm1', label: L('result', 'metric'), unit: 'J', min: 0, max: 10, precision: 1 }],
    params: { k: t, g: 9.81 },
  };
  const thumb = `thumbs/${key}.webp`;
  const topic = {
    key,
    unitKey: unit.key,
    status: 'published',
    title: L('topic', t),
    classification: L('subject', `class ${t}`),
    description: L('explanation', `topic ${t}`),
    goal: L('explanation', `goal ${t} (${objective.code})`),
    objectiveKeys: [objective.key],
    durationMin: 40,
    scene: { plugin: ['molecule', 'crystal', 'geometry', 'sim'][t % 4], params: { seed: t }, modes: [] },
    conceptKeys: ck,
    overrides: {},
    samples: [{ key: 'main', title: L('topic', t), thumb }],
    activities: {
      tour: { steps: ck.slice(0, 4).map((c, i) => ({ key: `t${i}`, focus: c, camera: { position: [0, 1, 5 - i], target: [0, 0, 0] }, text: L('step', i), teacherNote: L('explanation', `note ${i}`), altText: L('explanation', `alt ${i}`) })) },
      processKeys: [process.key],
      comparison: { columns: ck.slice(0, 2).map((c) => ({ kind: 'concept', key: c })), rows: ['size', 'function'] },
      quiz: { itemKeys: items.map((i) => i.key), sampleSize: 5 },
    },
    examples: ex(key),
    i18n: { ky: 'machine', ru: 'draft', en: 'draft' },
  };
  const pkg = {
    manifest: { topicKey: key, version: '1.0.0', hash: '0'.repeat(64), files: [{ path: thumb, hash: sha(thumb), size: 0 }], builtAt: '2026-10-15T00:00:00Z' },
    subject,
    course,
    unit,
    objectives: [objective],
    topic,
    concepts,
    processes: [process],
    items,
    glossary: [{ id: `g-${key}`, ky: 'термин', ru: 'термин', en: 'term', forbidden: [] }],
  };
  pkg.manifest.hash = sha(JSON.stringify(pkg));
  if (VALIDATE) {
    const res = validatePackage(pkg);
    const errs = res.issues.filter((i) => i.severity === 'error');
    if (errs.length) {
      errors += errs.length;
      if (errors <= 10) console.error(key, errs.slice(0, 3));
    }
  }
  const s = JSON.stringify(pkg);
  bytes += s.length;
  writeFileSync(join(OUT, 'packages', `${key}.json`), s);
}
writeFileSync(join(OUT, 'catalog.json'), JSON.stringify({ groups, subjects, courses, units }));
const tGen = performance.now();

const repo = loadContentRepo(OUT);
const cat = repo.catalog();
const tLoad = performance.now();

const files = readdirSync(join(OUT, 'packages'));
console.log(
  JSON.stringify(
    {
      outDir: OUT,
      subjects: subjects.length,
      liveSubjects: live.length,
      courses: courses.length,
      units: units.length,
      topics: files.length,
      catalogTopics: cat.topics.length,
      concepts: conceptCounter,
      itemTypes: ITEM_TYPES.length,
      languages: LANGS5,
      packageBytesTotal: bytes,
      largestPackageBytes: Math.max(...files.map((f) => statSync(join(OUT, 'packages', f)).size)),
      validationErrors: VALIDATE ? errors : 'skipped',
      generateAndValidateMs: Math.round(tGen - t0),
      loadRepoMs: Math.round(tLoad - tGen),
    },
    null,
    2,
  ),
);
if (errors || conceptCounter !== N_CONCEPTS || cat.topics.length !== N_TOPICS) process.exit(1);
