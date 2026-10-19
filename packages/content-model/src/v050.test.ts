import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from './i18n.js';
import { animalCellPackage } from './fixtures/animal-cell.js';
import { sceneForSample, type SceneSpec } from './topic.js';
import { validatePackage } from './validate.js';
import { CatalogSchema } from './package.js';
import {
  TextbookSchema,
  filterTextbookTopics,
  placesOfTopic,
  textbookSubjects,
  textbookTopicKeys,
  type Textbook,
} from './textbook.js';
import { ENDPOINTS, AdminTextbookPatchSchema } from './api/index.js';

const L = (s: string) => ({ ky: s, ru: s, en: s });

const book = (): Textbook => ({
  key: 'nat-8-1',
  title: L('Natural sciences 8'),
  grade: 8,
  lang: 'ky',
  part: 1,
  order: 0,
  chapters: [
    {
      key: 'ch1',
      number: '1',
      title: L('Cells'),
      subjectKey: 'bio',
      pages: { from: 8, to: 29 },
      lessons: [
        { key: 'ch1.l1', number: '1.1', kind: 'lesson', title: L('Animal cell'), pages: { from: 8, to: 17 }, topicKeys: ['animal-cell'] },
        { key: 'ch1.l2', number: '1.2', kind: 'lesson', title: L('Plant cell'), topicKeys: ['plant-cell', 'animal-cell'] },
        { key: 'ch1.r', number: '', kind: 'review', title: L('Review'), topicKeys: ['animal-cell', 'plant-cell'] },
      ],
    },
    {
      key: 'ch2',
      number: '2',
      title: L('Water'),
      subjectKey: 'chem',
      lessons: [{ key: 'ch2.l1', number: '2.1', kind: 'extra', title: L('Water'), topicKeys: ['water'] }],
    },
  ],
});

describe('contract 0.5.0: textbooks', () => {
  it('version', () => expect(CONTRACT_VERSION).toBe('0.5.0'));
  it('accepts an optional shortTitle', () => expect(TextbookSchema.safeParse({ ...book(), shortTitle: L('NS 8') }).success).toBe(true));
  it('validates a textbook; chapter and lesson keys are unique inside it', () => {
    expect(TextbookSchema.safeParse(book()).success).toBe(true);
    const dupLesson = book();
    dupLesson.chapters[1].lessons[0].key = 'ch1.l1';
    const r = TextbookSchema.safeParse(dupLesson);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(['chapters', 1, 'lessons', 0, 'key']);
    const dupChapter = book();
    dupChapter.chapters[1].key = 'ch1';
    expect(TextbookSchema.safeParse(dupChapter).error!.issues[0].path).toEqual(['chapters', 1, 'key']);
    // a lesson key may not collide with a chapter key either
    const cross = book();
    cross.chapters[1].lessons[0].key = 'ch1';
    expect(TextbookSchema.safeParse(cross).success).toBe(false);
    const badPages = book();
    badPages.chapters[0].pages = { from: 30, to: 8 };
    expect(TextbookSchema.safeParse(badPages).success).toBe(false);
    expect(TextbookSchema.safeParse({ ...book(), grade: 12 }).success).toBe(false);
    expect(TextbookSchema.safeParse({ ...book(), chapters: [] }).success).toBe(false);
  });

  it('subjects and topic keys in reading order, without repeats', () => {
    expect(textbookSubjects(book())).toEqual(['bio', 'chem']);
    expect(textbookTopicKeys(book())).toEqual(['animal-cell', 'plant-cell', 'water']);
  });

  it('filterTextbookTopics keeps chapters and lessons, drops topic keys', () => {
    const published = new Set(['animal-cell']);
    const f = filterTextbookTopics(book(), (k) => published.has(k));
    expect(f.chapters.map((c) => c.lessons.length)).toEqual([3, 1]);
    expect(f.chapters[0].lessons.map((l) => l.topicKeys)).toEqual([['animal-cell'], ['animal-cell'], ['animal-cell']]);
    expect(f.chapters[1].lessons[0].topicKeys).toEqual([]);
    expect(f.key).toBe('nat-8-1');
    expect(book().chapters[1].lessons[0].topicKeys).toEqual(['water']);
  });

  it('placesOfTopic lists lessons (not reviews) with pages', () => {
    const other = { ...book(), key: 'bio-7' };
    expect(placesOfTopic([book(), other], 'animal-cell')).toEqual([
      { textbookKey: 'nat-8-1', chapterKey: 'ch1', lessonKey: 'ch1.l1', number: '1.1', pages: { from: 8, to: 17 } },
      { textbookKey: 'nat-8-1', chapterKey: 'ch1', lessonKey: 'ch1.l2', number: '1.2' },
      { textbookKey: 'bio-7', chapterKey: 'ch1', lessonKey: 'ch1.l1', number: '1.1', pages: { from: 8, to: 17 } },
      { textbookKey: 'bio-7', chapterKey: 'ch1', lessonKey: 'ch1.l2', number: '1.2' },
    ]);
    expect(placesOfTopic([book()], 'nope')).toEqual([]);
  });

  it('catalog textbooks are optional; endpoints and admin patch', () => {
    const base = { groups: [], subjects: [], courses: [], units: [], topics: [] };
    expect(CatalogSchema.safeParse(base).success).toBe(true);
    expect(CatalogSchema.safeParse({ ...base, textbooks: [book()] }).success).toBe(true);
    expect(ENDPOINTS.textbooks.path).toBe('/textbooks');
    expect(ENDPOINTS.textbook.path).toBe('/textbooks/:key');
    expect(ENDPOINTS.adminTextbookCreate.auth).toBe('content.publish');
    expect(AdminTextbookPatchSchema.safeParse({ version: 1, order: 3 }).success).toBe(true);
    expect(AdminTextbookPatchSchema.safeParse({ version: 1, key: 'x' }).data).not.toHaveProperty('key');
  });
});

describe('contract 0.5.0: sample scenes', () => {
  const scene: SceneSpec = { plugin: 'sim', params: { model: 'separation', method: 'filtration' }, camera: { position: [0, 1, 5], target: [0, 0, 0] }, modes: ['run'] };

  it('sceneForSample merges params and replaces the camera', () => {
    const s = sceneForSample(scene, { scene: { params: { method: 'distillation' }, camera: { position: [1, 1, 1], target: [0, 0, 0] } } });
    expect(s.params).toEqual({ model: 'separation', method: 'distillation' });
    expect(s.camera?.position).toEqual([1, 1, 1]);
    expect(sceneForSample(scene, null)).toBe(scene);
    expect(sceneForSample(scene, {})).toBe(scene);
  });

  it('a tour step may show a sample; an unknown sample is an error', () => {
    const pkg = structuredClone(animalCellPackage);
    const sampleKey = pkg.topic.samples[0]!.key;
    pkg.topic.activities.tour!.steps[0]!.sample = sampleKey;
    expect(validatePackage(pkg).issues.filter((i) => i.code === 'sample_missing')).toEqual([]);
    pkg.topic.activities.tour!.steps[0]!.sample = 'no-such-sample';
    expect(validatePackage(pkg).issues.some((i) => i.code === 'sample_missing' && i.severity === 'error')).toBe(true);
  });
});
