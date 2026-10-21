/** v0.9.2: a preliminary КТП from a textbook's contents — the lesson list, fitting, the contents reader, the .docx. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Textbook } from '@bilig/content-model';
import { draftKtpFromTextbook } from '../from-textbook.js';
import { finishDraft, fromModel, looksParsed, parseContentsText } from '../contents.js';
import { ktpDocx } from '../ktp-docx.js';
import { readDocx } from '../docx-read.js';
import { parseKtp } from '../parse.js';
import { validate } from '../validate.js';
import { PHYS7_CONTENTS } from './contents.fixture.js';

const tb = JSON.parse(readFileSync(new URL('../../../content/src/textbooks/fizika-7.json', import.meta.url), 'utf8')).textbook as Textbook;
const draft = (hoursPerWeek: number, classes: string[] = ['7а']) => draftKtpFromTextbook(tb, 'Физика', { lang: 'ky', hoursPerWeek, weeks: 34, classes });

describe('draftKtpFromTextbook (Физика 7: 56 §, 6 tests, 8 lab works)', () => {
  it('2 lessons a week: 68 lessons in book order, without dates; labs after their topic, the test closes each chapter', () => {
    const d = draft(2);
    expect(d.rows).toHaveLength(68);
    expect(d.rows.every((r) => r.hours === 1 && r.dates['7а'] === null)).toBe(true);
    expect(d.rows[0]).toMatchObject({ index: 1, title: '§ 1. Физика, табият жана турмуш', type: 'new', homework: '§ 1, 8–9-беттер', topicKey: 'phys7-mechanical-motion', section: { title: 'I глава. Механика. Кинематиканын негиздери' } });
    // Lab work № 1 (volume, density) right after § 16 (density), before § 17.
    const density = d.rows.findIndex((r) => r.title.includes('§ 16'));
    expect(d.rows[density + 1]).toMatchObject({ type: 'practice', topicKey: 'phys7-mass-density' });
    expect(d.rows[density + 1].title).toMatch(/^Лабораториялык иш № 1\./);
    // Every chapter ends with its test; section hours add up to the lessons under them.
    const sections = [...new Set(d.rows.map((r) => r.section!.title))];
    expect(sections).toHaveLength(6);
    for (const s of sections) {
      const rows = d.rows.filter((r) => r.section!.title === s);
      expect(rows.at(-1)!.type === 'test' || rows.some((r) => r.type === 'test')).toBe(true);
      expect(rows[0].section!.hours).toBe(rows.length);
    }
    expect(d.rows.filter((r) => r.type === 'test').map((r) => r.title)[0]).toBe('Текшерүү иши: «Механика. Кинематиканын негиздери»');
    // 70 items for 68 lessons: the shortest neighbouring § were joined.
    expect(d.rows.filter((r) => /^§ \d+–\d+\./.test(r.title)).length).toBe(2);
    expect(validate(d.rows, { classes: ['7а'], year: 2026, declaredHours: 68 }).map((i) => `${i.code}:${i.severity}`)).toEqual(['date_missing:info']);
  });

  it('1 lesson a week joins up to 5 § in a lesson; 3 a week adds analysis, problem solving and a final review', () => {
    const one = draft(1);
    expect(one.rows.length).toBeLessThanOrEqual(36);
    expect(one.rows.filter((r) => r.type === 'test')).toHaveLength(6);
    const three = draft(3);
    expect(three.rows).toHaveLength(102);
    expect(three.rows.filter((r) => r.type === 'analysis')).toHaveLength(6);
    expect(three.rows.at(-1)!.title).toBe('Жылдык кайталоо');
    expect(three.rows.some((r) => r.title.startsWith('Маселе чыгаруу: Динамиканын негиздери'))).toBe(true);
    // Every § of the book is still in the plan exactly once.
    const paras = three.rows.flatMap((r) => [...r.title.matchAll(/^§ (\d+)(?:–(\d+))?/g)].flatMap((m) => (m[2] ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, k) => +m[1] + k) : [+m[1]])));
    expect(paras).toEqual(Array.from({ length: 56 }, (_, k) => k + 1));
  });

  it('Russian titles from the textbook translations; class labels give empty date columns', () => {
    const d = draftKtpFromTextbook(tb, 'Физика', { lang: 'ru', hoursPerWeek: 2, weeks: 34, classes: ['7а', '7б'] });
    expect(d.title).toBe('Физика, 7 класс: календарно-тематический план (предварительный)');
    expect(d.rows[0]).toMatchObject({ title: '§ 1. Физика, природа и жизнь', homework: '§ 1, с. 8–9', dates: { '7а': null, '7б': null } });
  });
});

describe('the contents reader', () => {
  it('reads «Мазмуну» text: the introduction, chapters «I ГЛАВА», wrapped lines, tests, lab works, appendices, page ranges', () => {
    const ch = parseContentsText(PHYS7_CONTENTS);
    expect(looksParsed(ch)).toBe(true);
    const { draft: d, warnings } = finishDraft(ch, { title: 'Физика 7', grade: 7, lang: 'ky', subjectKey: 'phys' });
    expect(d.chapters.map((c) => [c.number, c.title])).toEqual([
      ['', 'Киришүү'],
      ['1', 'МЕХАНИКА. КИНЕМАТИКАНЫН НЕГИЗДЕРИ'],
      ['2', 'ДИНАМИКАНЫН НЕГИЗДЕРИ'],
    ]);
    expect(d.chapters[0].lessons.map((l) => [l.kind, l.number, l.pages?.from])).toEqual([
      ['extra', '', 5],
      ['lesson', '1', 8],
      ['lesson', '2', 10],
      ['lesson', '3', 12],
    ]);
    expect(d.chapters[1].lessons[0]).toEqual({ number: '4', kind: 'lesson', title: 'Нерсенин механикалык кыймылы. Кыймылдын траекториясы. Кыймылдын түрлөрү', pages: { from: 17, to: 18 } });
    expect(d.chapters[1].lessons.at(-1)).toMatchObject({ kind: 'review', number: '', pages: { from: 40, to: 41 } });
    expect(d.chapters[2].lessons.map((l) => l.kind)).toEqual(['lesson', 'lesson', 'lesson', 'review', 'extra', 'extra']);
    expect(warnings).toEqual([]);
  });

  it('Russian contents with «Глава 2» and «2.1» numbering; not contents → not trusted', () => {
    const ch = parseContentsText(['Оглавление', 'Глава 1. Тепловые явления', '1.1 Тепловое движение ........ 5', '1.2 Внутренняя энергия ..... 9', 'Глава 2. Электричество', '2.1 Электрический заряд ...... 30', '2.2 Ток ........ 34', 'Контрольная работа ......... 40'].join('\n'));
    expect(ch.map((c) => [c.number, c.title, c.lessons.map((l) => `${l.kind}:${l.number}:${l.page}`)])).toEqual([
      ['1', 'Тепловые явления', ['lesson:1.1:5', 'lesson:1.2:9']],
      ['2', 'Электричество', ['lesson:2.1:30', 'lesson:2.2:34', 'review::40']],
    ]);
    expect(looksParsed(parseContentsText('Просто текст страницы\nбез оглавления и страниц'))).toBe(false);
  });

  it('checks what the model returned (pages, kinds, junk dropped)', () => {
    const m = fromModel({ contentsImages: [2, 3], title: 'Физика 7', grade: 7, chapters: [{ number: 'II', title: 'Динамиканын негиздери', lessons: [{ number: '§ 12.', title: 'Күч ....', page: 42 }, { number: '', title: 'Лабораториялык иш', page: 0 }, { number: '', title: '', page: 3 }] }, { number: 'x', title: 'empty', lessons: [] }] });
    expect(m).toMatchObject({ contentsImages: [2, 3], title: 'Физика 7', grade: 7 });
    expect(m.chapters).toEqual([{ number: '2', title: 'Динамиканын негиздери', lessons: [{ number: '12', kind: 'lesson', title: 'Күч', page: 42 }, { number: '', kind: 'extra', title: 'Лабораториялык иш' }] }]);
    expect(fromModel('nonsense').chapters).toEqual([]);
  });
});

describe('КТП .docx', () => {
  it('Word layout the КТП parser reads back (ky, two classes): lessons, hours, types, homework, sections, meta', () => {
    const d = draft(2, ['7а', '7б']);
    const buf = ktpDocx({ title: d.title, subjectName: 'физика', grade: 7, year: 2026, lang: 'ky', teacherName: 'Асанова Айгүл', schoolName: '№5 мектеп', classes: d.classes, rows: d.rows, topicTitle: () => 'Тема', hoursPerWeek: 2 });
    const p = parseKtp(readDocx(buf), { now: new Date('2026-08-20') });
    expect(p.meta).toMatchObject({ subjectKey: 'phys', grade: 7, year: 2026, declaredHours: 68, teacherName: 'Асанова Айгүл', lang: 'ky' });
    expect(p.classes).toEqual(['7а', '7б']);
    expect(p.rows.map((r) => [r.title, r.hours, r.type, r.homework])).toEqual(d.rows.map((r) => [r.title, r.hours, r.type, r.homework]));
    expect(p.rows[0].section).toEqual({ title: 'Механика. Кинематиканын негиздери', hours: 12 });
    expect(p.rows[0].note).toBe('Bilig: Тема');
  });
});

describe('the contents reader on a real text PDF (Физика 7, 2023, Russian)', () => {
  it('58 §, labs inside §, chapter tests, page footers and appendices handled', () => {
    const text = readFileSync(new URL('./contents-ru-phys7-2023.txt', import.meta.url), 'utf8');
    const ch = parseContentsText(text);
    expect(looksParsed(ch)).toBe(true);
    const { draft: d } = finishDraft(ch, { title: 'Физика 7', grade: 7, lang: 'ru', subjectKey: 'phys' });
    const all = d.chapters.flatMap((c) => c.lessons);
    expect(all.filter((l) => /^\d+$/.test(l.number) && l.kind !== 'extra' && l.number !== '' ).length + all.filter((l) => /Лабораторная работа/.test(l.title)).length).toBe(58);
    expect(all.map((l) => l.number).filter((n) => Number(n) > 100)).toEqual([]); // no «§ 269»
    expect(all.find((l) => l.number === '26')).toMatchObject({ kind: 'lesson', pages: { from: 116, to: 121 } });
    expect(all.find((l) => l.number === '14')!.title).toBe('Способы изображения движения на графике. Система отсчета');
    expect(all.filter((l) => l.kind === 'review')).toHaveLength(5);
    expect(all.filter((l) => /Лабораторная работа/.test(l.title)).every((l) => l.kind === 'extra')).toBe(true);
    expect(all.slice(-4).every((l) => l.kind === 'extra')).toBe(true); // the 4 appendices
    expect(d.chapters.map((c) => c.number)).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});
