/**
 * КТП → lesson plans: unit tests. Each finding of the prototype review
 * (F1…F14) has a test named after it.
 */
import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { loadContentDir } from '../../services/seed.js';
import { DocxError, readDocx, unzipEntry, DEFAULT_DOCX_LIMITS, type DocxTable } from '../docx-read.js';
import { lessonType } from '../lesson-type.js';
import { buildTopicIndex, matchTitle, applyMatches, similarity, tokens, wordMatch, wordWeight, MATCH_THRESHOLD } from '../match.js';
import { classLabel, dateTokens, detectLang, findDeclaredHours, findTeacher, findYear, lessonNumbers, parseKtp, splitHours, splitSection, subjectKeyOf } from '../parse.js';
import { buildPlanContent, STAGE_TIMES, PLAN_TEXTS, type PlanInput } from '../plan-content.js';
import { PLAN_LABELS, renderPlansDocx } from '../plan-docx.js';
import { patchPlanDoc, createPlanDoc } from '../teaching-plan.js';
import { validate, KG_HOLIDAYS } from '../validate.js';
import { buildDocx, documentXml, dumpDocx, zipDocx } from './docx-builder.js';
import { algebraKtp, russianKtp, scienceKtp } from './fixtures.js';
import type { KtpRow } from '@bilig/content-model/api';

const NOW = new Date('2026-10-19T08:00:00Z');
const parse = (buf: Buffer) => parseKtp(readDocx(buf), { now: NOW });
const tableOf = (buf: Buffer): DocxTable => {
  const b = readDocx(buf).blocks.find((x) => x.kind === 'table');
  if (!b || b.kind !== 'table') throw new Error('no table');
  return b.table;
};

const content = loadContentDir();
const published = content.packages.filter((p) => p.topic.status === 'published');
const index = buildTopicIndex(published, content.base.textbooks ?? []);
const subjectKeys = new Set(content.base.subjects.map((s) => s.key));

// ---------------------------------------------------------------------------
// docx reader
// ---------------------------------------------------------------------------

/** Patch the uncompressed size an entry declares in the central directory. */
function setDeclaredSize(zip: Buffer, entry: string, size: number): Buffer {
  const buf = Buffer.from(zip);
  const name = Buffer.from(entry);
  for (let i = 0; i < buf.length - 46; i++)
    if (buf.readUInt32LE(i) === 0x02014b50 && buf.subarray(i + 46, i + 46 + name.length).equals(name)) buf.writeUInt32LE(size, i + 24);
  return buf;
}

describe('docx reader', () => {
  it('resolves gridSpan, vMerge and gridBefore onto the table grid', () => {
    const t = tableOf(
      buildDocx([
        {
          table: [
            [{ text: '№', vMerge: 'restart' }, { text: 'Дата', span: 2 }, 'x'],
            [{ vMerge: 'continue' }, '8б', '8в', 'y'],
            ['1', 'z'],
          ],
          gridBefore: { 2: 2 },
        },
      ]),
    );
    expect(t.cols).toBe(4);
    expect(t.rows[0].map((c) => c.text)).toEqual(['№', 'Дата', 'Дата', 'x']);
    expect(t.rows[0][2].colSpanned).toBe(true);
    expect(t.rows[1][0]).toEqual({ text: '№', colSpanned: false, rowSpanned: true });
    expect(t.rows[2].map((c) => c.text)).toEqual(['', '', '1', 'z']);
  });

  it('F3: cell text = all paragraphs joined by \\n, every run counts whatever wraps it', () => {
    const t = tableOf(
      buildDocx([{ table: [['{{ins:Квадраттык функциянын}}{{smart: графиктери}}', 'А{{link:лгебра}}{{del:XYZ}}', 'a{{tab}}b{{nbsp}}c', '{{split:Пифагордун теоремасы}}', 'бир\n\nэки{{br}}үч']] }]),
    );
    expect(t.rows[0].map((c) => c.text)).toEqual(['Квадраттык функциянын графиктери', 'Алгебра', 'a b c', 'Пифагордун теоремасы', 'бир\nэки\nүч']);
  });

  it('paragraph tab stops are not text; nested tables flatten into the cell; entities decode', () => {
    const inner = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>ички</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const xml = documentXml([{ table: [['A']] }]).replace('<w:t xml:space="preserve">A</w:t></w:r></w:p>', `<w:t xml:space="preserve">A &amp; &#1199;</w:t></w:r></w:p>${inner}`);
    const doc = readDocx(zipDocx({ 'word/document.xml': xml }));
    const t = doc.blocks[0];
    expect(t.kind === 'table' && t.table.rows[0][0].text).toBe('A & ү\nички');
  });

  describe('F14: untrusted zip', () => {
    const ok = buildDocx([{ p: 'Салам' }]);
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof DocxError ? e.code : `other: ${String(e)}`;
      }
      return 'no error';
    };

    it('reads a valid file (deflate and store)', () => {
      expect(readDocx(ok).blocks).toEqual([{ kind: 'p', text: 'Салам' }]);
      expect(readDocx(zipDocx({ 'word/document.xml': documentXml([{ p: 'x' }]) }, 'STORE')).blocks).toEqual([{ kind: 'p', text: 'x' }]);
    });
    it('checks the PK magic and the compressed size', () => {
      expect(code(() => readDocx(Buffer.from('%PDF-1.7 not a zip at all, sorry')))).toBe('not_docx');
      expect(code(() => readDocx(Buffer.alloc(DEFAULT_DOCX_LIMITS.maxBytes + 1)))).toBe('too_large');
    });
    it('needs word/document.xml', () => {
      expect(code(() => readDocx(zipDocx({ 'a.txt': 'x' })))).toBe('not_docx');
    });
    it('caps the entry count and the total uncompressed size (zip bomb)', () => {
      const many = zipDocx(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.xml`, 'x'])));
      expect(code(() => unzipEntry(many, 'f1.xml', { ...DEFAULT_DOCX_LIMITS, maxEntries: 10 }))).toBe('too_large');
      // a small file declaring > 30 MB uncompressed in total
      const bomb = setDeclaredSize(zipDocx({ 'word/document.xml': documentXml([{ p: 'x' }]), 'bomb.bin': Buffer.alloc(1000) }), 'bomb.bin', DEFAULT_DOCX_LIMITS.maxTotalUncompressed + 1);
      expect(code(() => readDocx(bomb))).toBe('too_large');
      const real = zipDocx({ 'word/document.xml': documentXml([{ p: 'x' }]), 'bomb.bin': Buffer.alloc(3_000_000) });
      expect(real.length).toBeLessThan(50_000);
      expect(code(() => readDocx(real, { ...DEFAULT_DOCX_LIMITS, maxTotalUncompressed: 2_000_000 }))).toBe('too_large');
      const bigXml = zipDocx({ 'word/document.xml': documentXml([{ p: 'x'.repeat(2_000_000) }]) });
      expect(code(() => readDocx(bigXml, { ...DEFAULT_DOCX_LIMITS, maxDocumentXml: 1_000_000 }))).toBe('too_large');
    });
    it('never inflates past the declared size (a lying header)', () => {
      const buf = setDeclaredSize(zipDocx({ 'word/document.xml': documentXml([{ p: 'y'.repeat(100_000) }]) }), 'word/document.xml', 100);
      expect(code(() => readDocx(buf))).toBe('too_large');
    });
    it('rejects encrypted entries, truncated files and DTDs', () => {
      const enc = Buffer.from(ok);
      for (let i = 0; i < enc.length - 4; i++) if (enc.readUInt32LE(i) === 0x02014b50) enc.writeUInt16LE(enc.readUInt16LE(i + 8) | 1, i + 8);
      expect(code(() => readDocx(enc))).toBe('unsupported');
      expect(code(() => readDocx(ok.subarray(0, ok.length - 30)))).toBe('corrupt');
      const dtd = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><w:document><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>';
      expect(code(() => readDocx(zipDocx({ 'word/document.xml': dtd })))).toBe('corrupt');
    });
  });
});

// ---------------------------------------------------------------------------
// the real algebra КТП (structure of the prototype's parsed.json)
// ---------------------------------------------------------------------------

describe('parse: algebra КТП (8б, 8в)', () => {
  const p = parse(algebraKtp());
  const byTitle = (re: RegExp) => p.rows.filter((r) => re.test(r.title));

  it('counts lessons, classes and sections', () => {
    expect(p.classes).toEqual(['8б', '8в']);
    expect(p.rows).toHaveLength(138);
    expect(p.rows.reduce((s, r) => s + r.hours, 0)).toBe(138);
    const sections = [...new Set(p.rows.filter((r) => r.section).map((r) => r.section!.title))];
    expect(sections).toEqual([
      'Сан',
      'Бөлчөктөр. Ондук бөлчөктөр жана проценттер',
      'Катыштар жана пропорция',
      'Алгебралык өзгөртүп түзүүлөр',
      'Барабарсыздыктар,удаалаштыктар, функциялар жана графиктер',
      'Ченөөлөр, аралыктар жана бурчтар',
      '3D фигуралар (мүнөздөмө жана касиеттери)',
      'Координаталар жана өзгөртүп түзүүлөр',
      'Статистика',
      'Ыктымалдуулук',
      'Кайталоо',
    ]);
    expect(p.rows.every((r) => r.section)).toBe(true);
  });

  it('F1: index is global across tables, the printed number restarts', () => {
    expect(p.rows.map((r) => r.index)).toEqual(Array.from({ length: 138 }, (_, i) => i + 1));
    expect(p.rows.filter((r) => r.number === 1).map((r) => r.index)).toEqual([1, 35, 64, 95]);
    expect(p.rows[34]).toMatchObject({ index: 35, number: 1, title: 'Кашааларды ачуу жана көбөйтүүчүлөргө ажыратуу' });
  });

  it('F2: section headings are split off titles; a numbered heading-only row keeps its lesson', () => {
    expect(p.rows[0]).toMatchObject({ number: 1, title: 'Сандар системасы', section: { title: 'Сан', hours: 10 } });
    expect(p.rows[10]).toMatchObject({ title: '0,1 жана 0,01 ге көбөйтүү жана бөлүү', section: { title: 'Бөлчөктөр. Ондук бөлчөктөр жана проценттер', hours: 12 } });
    expect(byTitle(/^Үч бурчтук$/)[0].section).toEqual({ title: 'Ченөөлөр, аралыктар жана бурчтар', hours: 14 });
    expect(byTitle(/Координата жөнүндө/)[0].section).toEqual({ title: 'Координаталар жана өзгөртүп түзүүлөр', hours: 8 });
    // «10. Ыктымалдуулук (9 саат)» alone in a numbered, dated row: starts the section and stays a lesson (the section's 9 hours count it)
    const prob = p.rows.find((r) => r.section?.title === 'Ыктымалдуулук')!;
    expect(prob).toMatchObject({ number: 25, title: 'Ыктымалдуулук', dates: { '8б': '2027-04-17' } });
    expect(p.rows.filter((r) => r.section?.title === 'Ыктымалдуулук')).toHaveLength(9);
    expect(p.rows.some((r) => /саат\)|\(\d+ саат/.test(r.title) || /^\d+\./.test(r.title))).toBe(false);
  });

  it('F2: heading rows without a number start a section and are not lessons', () => {
    const doc = parse(
      buildDocx([
        { p: 'Физика предмети боюнча 7-класс үчүн календардык-тематикалык план, 2026-2027-окуу жылы' },
        {
          table: [
            ['№', 'Сабактын темасы', 'Саат', '7а'],
            [{ text: 'I бөлүм. Механикалык кыймыл (2 саат)', span: 4 }],
            ['1', 'Кыймыл', '1', '02.09'],
            ['', 'Ылдамдык (2 саат)', '', ''],
            ['2', 'Ылдамдык', '2', '04.09'],
          ],
        },
      ]),
    );
    expect(doc.rows.map((r) => [r.title, r.section])).toEqual([
      ['Кыймыл', { title: 'Механикалык кыймыл', hours: 2 }],
      ['Ылдамдык', { title: 'Ылдамдык', hours: 2 }],
    ]);
  });

  it('F2: section hours are validated (only «Кайталоо (8 саат)» has 11 lessons)', () => {
    const issues = validate(p.rows, { classes: p.classes, year: p.meta.year, declaredHours: p.meta.declaredHours }, p.invalidDates);
    expect(issues.filter((i) => i.code === 'section_hours_mismatch')).toEqual([
      { code: 'section_hours_mismatch', severity: 'warning', row: 128, params: { section: 'Кайталоо', declared: 8, actual: 11 } },
    ]);
  });

  it('F3: a title split across wrapped runs is whole', () => {
    expect(p.rows[67]).toMatchObject({ number: 5, title: 'Квадраттык функциянын графиктери' });
  });

  it('F4: merged «43\\n44» row → two lessons with their own dates and 1 hour each', () => {
    expect(p.rows.slice(-2).map((r) => [r.number, r.title, r.hours, r.dates])).toEqual([
      [43, 'Жалпы кайталоо', 1, { '8б': '2027-05-24', '8в': '2027-05-24' }],
      [44, 'Жалпы кайталоо', 1, { '8б': '2027-05-25', '8в': '2027-05-25' }],
    ]);
  });

  it('F6/F7/F8: issues of the real file: hours 136 ≠ 138, 31.04.27 impossible, holidays; Saturdays are fine', () => {
    const issues = validate(p.rows, { classes: p.classes, year: p.meta.year, declaredHours: p.meta.declaredHours }, p.invalidDates);
    expect(issues.map((i) => `${i.code}:${i.row ?? ''}:${i.class ?? ''}`)).toEqual([
      'hours_mismatch::',
      'date_holiday:90:8б',
      'date_holiday:90:8в',
      'date_holiday:103:8б',
      'date_holiday:103:8в',
      'date_invalid:109:8в',
      'section_hours_mismatch:128:',
    ]);
    expect(issues[0]).toMatchObject({ severity: 'warning', params: { declared: 136, actual: 138 } });
    expect(issues.find((i) => i.code === 'date_invalid')).toMatchObject({ severity: 'error', params: { date: '31.04.27' } });
    expect(p.rows[108]).toMatchObject({ number: 15, dates: { '8б': '2027-04-01', '8в': null } });
    // 17.10.26 (ишемби) is a Saturday: no issue, no flag
    expect(p.rows.find((r) => r.dates['8б'] === '2026-10-17')).not.toHaveProperty('saturday');
  });

  it('F10: subject from the title, teacher from the «Мугалим:» line, school year, grade, declared hours', () => {
    expect(p.meta).toMatchObject({
      subjectName: 'алгебра',
      subjectKey: 'math',
      teacherName: 'Асанов Бакыт Урматович',
      schoolName: '№12 жалпы билим берүү мектеби',
      year: 2026,
      grade: 8,
      declaredHours: 136,
      lang: 'ky',
    });
    expect(p.meta.title).toBe('№12 жалпы билим берүү мектебинин 8-класстарынын алгебра предмети боюнча 2026-2027-окуу жылы үчүн календардык-тематикалык планы');
  });

  it('F12: lesson types (ky), including the typo «Мисал ишөө»', () => {
    expect(byTitle(/^Мисал ишөө$/)[0].type).toBe('practice');
    expect(byTitle(/^Текшерүү иши №1$/)[0].type).toBe('test');
    expect(byTitle(/^Текшерүү ишти анализдөө$/)[0].type).toBe('analysis');
    expect(byTitle(/^Өз алдынча иштөө$/)[0].type).toBe('test');
    expect(byTitle(/^Функция$/)[0].type).toBe('new');
    const counts = p.rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.type]: (a[r.type] ?? 0) + 1 }), {});
    expect(counts).toEqual({ new: 55, practice: 56, test: 14, analysis: 13 });
  });
});

// ---------------------------------------------------------------------------
// Russian КТП
// ---------------------------------------------------------------------------

describe('parse: Russian КТП (8 «Б», 8 «В», «Дата» spanning the class columns)', () => {
  const p = parse(russianKtp());

  it('F12/F13: ru header words, class labels under a gridSpan «Дата», section banner, quarter row', () => {
    expect(p.classes).toEqual(['8Б', '8В']);
    expect(p.meta).toMatchObject({ lang: 'ru', subjectName: 'физика', subjectKey: 'phys', teacherName: 'Иванова Мария Петровна', schoolName: 'Средняя школа № 5 им. Ч. Айтматова', year: 2026, grade: 8, declaredHours: 6 });
    expect(p.rows.map((r) => [r.number, r.title, r.type])).toEqual([
      [1, 'Скорость. Единицы скорости', 'new'],
      [2, 'Решение задач на расчет скорости', 'practice'],
      [3, 'Контрольная работа №1', 'test'],
      [4, 'Анализ контрольной работы', 'analysis'],
      [5, 'Сила тяжести', 'new'],
      [6, 'Лабораторная работа «Измерение силы трения»', 'practice'],
    ]);
    expect(p.rows[0].section).toEqual({ title: 'Движение и силы', hours: 5 });
    expect(p.rows[1]).toMatchObject({ homework: '§ 8.1, № 3', note: 'перенос' });
  });

  it('F7: date formats (no year → school year, dd/mm/yy, dd-mm-yyyy)', () => {
    expect(p.rows[0].dates).toEqual({ '8Б': '2026-09-02', '8В': '2026-09-03' });
    expect(p.rows[1].dates).toEqual({ '8Б': '2026-09-07', '8В': '2026-09-06' });
  });

  it('F5/F6: same day = info, earlier = error, Sunday and holiday = warnings, missing = error', () => {
    const issues = validate(p.rows, { classes: p.classes, year: p.meta.year, declaredHours: p.meta.declaredHours }, p.invalidDates);
    expect(issues).toEqual([
      { code: 'section_hours_mismatch', severity: 'warning', row: 1, params: { section: 'Движение и силы', declared: 5, actual: 6 } },
      { code: 'date_sunday', severity: 'warning', row: 2, class: '8В', params: { date: '2026-09-06' } },
      { code: 'date_same_day', severity: 'info', row: 4, class: '8Б', params: { date: '2026-09-09' } },
      { code: 'date_holiday', severity: 'warning', row: 4, class: '8В', params: { date: '2026-11-07', holiday: 'history_day' } },
      { code: 'date_missing', severity: 'error', row: 5, class: '8В' },
      { code: 'date_order', severity: 'error', row: 6, class: '8В', params: { date: '2026-09-16', prev: '2026-11-07' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------

describe('F13: header detection', () => {
  it('one header row with the classes; a continuation table without a header; a repeated header', () => {
    const p = parse(
      buildDocx([
        { p: 'Химия боюнча КТП, 9-класс' },
        { table: [['№', 'Темасы', 'Саат', '9а', '9б', 'Үй тапшырма'], ['1', 'Суу', '1', '02.09.26', '03.09.26', '§1']] },
        { table: [['2', 'Метан', '1', '04.09.26', '05.09.26', '§2'], ['№', 'Темасы', 'Саат', '9а', '9б', 'Үй тапшырма'], ['3', 'Аш тузу', '1', '07.09.26', '08.09.26', '§3']] },
      ]),
    );
    expect(p.classes).toEqual(['9а', '9б']);
    expect(p.rows.map((r) => [r.index, r.number, r.title, r.homework])).toEqual([
      [1, 1, 'Суу', '§1'],
      [2, 2, 'Метан', '§2'],
      [3, 3, 'Аш тузу', '§3'],
    ]);
    expect(p.meta).toMatchObject({ subjectName: 'химия', subjectKey: 'chem', grade: 9 });
  });

  it('a single «Датасы» column without class labels uses the grade as the class', () => {
    const p = parse(buildDocx([{ p: '7-класс, биология' }, { table: [['№', 'Сабактын темасы', 'Саат', 'Датасы'], ['1', 'Клетка', '1', '02.09.2026']] }]));
    expect(p.classes).toEqual(['7']);
    expect(p.rows[0].dates).toEqual({ '7': '2026-09-02' });
  });

  it('class labels as printed, spaces and quotes removed', () => {
    expect(['8б', '8 «Б»', '8-Б', '8Б', '10 А', '11"В"', '8 б класс'].map(classLabel)).toEqual(['8б', '8Б', '8Б', '8Б', '10А', '11В', '8б']);
    expect(['№', 'Дата', '8', '2026'].map(classLabel)).toEqual([null, null, null, null]);
  });

  it('a document without a КТП table has no lessons (no_lessons)', () => {
    const p = parse(buildDocx([{ p: 'Жөн гана текст' }, { table: [['a', 'b']] }]));
    expect(p.rows).toEqual([]);
    expect(validate(p.rows, { classes: p.classes, year: null, declaredHours: null })).toEqual([{ code: 'no_lessons', severity: 'error' }]);
  });
});

describe('F4: lesson numbers and hours of merged rows', () => {
  it('numbers', () => {
    expect(lessonNumbers('43\n44')).toEqual([43, 44]);
    expect(lessonNumbers('12.')).toEqual([12]);
    expect(lessonNumbers('43-44')).toEqual([43, 44]);
    expect(lessonNumbers('5, 6')).toEqual([5, 6]);
    expect(lessonNumbers('I чейрек')).toEqual([]);
  });
  it('hours split evenly with the remainder first, ≥ 1 each', () => {
    expect(splitHours('2', 2)).toEqual([1, 1]);
    expect(splitHours('1', 2)).toEqual([1, 1]);
    expect(splitHours('3', 2)).toEqual([2, 1]);
    expect(splitHours('1\n2', 2)).toEqual([1, 2]);
    expect(splitHours('', 1)).toEqual([1]);
    expect(splitHours('2', 1)).toEqual([2]);
  });
  it('a merged row with hours «1» and one date per line', () => {
    const p = parse(buildDocx([{ table: [['№', 'Тема', 'Саат', '5а'], ['7\n8', 'Кайталоо', '1', '10.09.26\n11.09.26']] }]));
    expect(p.rows.map((r) => [r.number, r.hours, r.dates['5а']])).toEqual([
      [7, 1, '2026-09-10'],
      [8, 1, '2026-09-11'],
    ]);
  });
});

describe('F7: dates', () => {
  it('formats and the school year', () => {
    const iso = (s: string) => dateTokens(s, 2026).map((t) => t.iso ?? `invalid ${t.raw}`);
    expect(iso('15.09.26')).toEqual(['2026-09-15']);
    expect(iso('15.09.2026')).toEqual(['2026-09-15']);
    expect(iso('15/09/26')).toEqual(['2026-09-15']);
    expect(iso('15-09-2026')).toEqual(['2026-09-15']);
    expect(iso('15.09')).toEqual(['2026-09-15']);
    expect(iso('15.01')).toEqual(['2027-01-15']);
    expect(iso('31.04.27')).toEqual(['invalid 31.04.27']);
    expect(iso('29.02.27')).toEqual(['invalid 29.02.27']);
    expect(iso('29.02.28')).toEqual(['2028-02-29']);
    expect(iso('17.10.26\nишемби')).toEqual(['2026-10-17']);
    expect(iso('0,01')).toEqual([]);
  });
  it('the school year from the title', () => {
    expect(findYear('2026-2027-окуу жылы')).toBe(2026);
    expect(findYear('на 2026/27 учебный год')).toBe(2026);
    expect(findYear('2026-2028')).toBeNull();
  });
});

describe('F5/F6/F8: validate', () => {
  const row = (index: number, d: string | null, extra: Partial<KtpRow> = {}): KtpRow => ({ index, number: index, title: 'T', hours: 1, type: 'new', dates: { a: d }, homework: '', note: '', topicKey: null, ...extra });
  const codes = (rows: KtpRow[], meta = { classes: ['a'], year: 2026 as number | null, declaredHours: null as number | null }) => validate(rows, meta).map((i) => `${i.code}/${i.severity}:${i.row ?? ''}`);

  it('order: same day is info, earlier is error (only against the previous dated lesson)', () => {
    expect(codes([row(1, '2026-09-15'), row(2, '2026-09-15'), row(3, '2026-09-14'), row(4, '2026-09-16')])).toEqual(['date_same_day/info:2', 'date_order/error:3']);
  });
  it('Sunday, every fixed KG holiday, outside 1 Sep – 30 Jun', () => {
    expect(codes([row(1, '2026-09-06')])).toEqual(['date_sunday/warning:1']);
    expect(Object.keys(KG_HOLIDAYS).sort()).toEqual(['01-01', '01-07', '02-23', '03-08', '03-21', '03-22', '05-01', '05-05', '05-09', '08-31', '11-07', '11-08']);
    expect(codes([row(1, '2026-11-08')])).toEqual(['date_sunday/warning:1', 'date_holiday/warning:1']);
    expect(codes([row(1, '2026-08-25'), row(2, '2027-07-01')])).toEqual(['date_out_of_year/warning:1', 'date_out_of_year/warning:2']);
    expect(codes([row(1, '2027-07-01')], { classes: ['a'], year: null, declaredHours: null })).toEqual([]);
  });
  it('missing title, missing date, hours mismatch', () => {
    expect(codes([row(1, null, { title: ' ' }), row(2, '2026-09-03')], { classes: ['a'], year: null, declaredHours: 3 })).toEqual(['hours_mismatch/warning:', 'title_missing/error:1', 'date_missing/error:1']);
    // v0.9.2: a class column with no dates at all (a КТП from a textbook) is one note, not an error per lesson.
    expect(codes([row(1, null), row(2, null)], { classes: ['a'], year: null, declaredHours: 2 })).toEqual(['date_missing/info:']);
  });
  it('declared totals in headers and footers (ky / ru)', () => {
    expect(findDeclaredHours('Жумасына 4 саат, бардыгы 136 саат')).toBe(136);
    expect(findDeclaredHours('Жалпы 136')).toBe(136);
    expect(findDeclaredHours('Всего 136 часов')).toBe(136);
    expect(findDeclaredHours('Итого: 68')).toBe(68);
    expect(findDeclaredHours('Жалпы саат: 34')).toBe(34);
    expect(findDeclaredHours('жалпы билим берүү мектеби')).toBeNull();
    expect(findDeclaredHours('Жумасына 4 саат')).toBeNull();
    expect(findDeclaredHours('всего 34 недели')).toBeNull();
  });
});

describe('F2: section headings', () => {
  it('splits heading lines (hours on the same or the next line) from the lesson', () => {
    expect(splitSection('6. Ченөөлөр, аралыктар жана бурчтар\n(14 саат)\nҮч бурчтук', true, 1)).toEqual({ section: { title: 'Ченөөлөр, аралыктар жана бурчтар', hours: 14 }, rest: ['Үч бурчтук'] });
    expect(splitSection('Раздел 2. Тепловые явления – 12 часов\nВнутренняя энергия', true, 1)).toEqual({ section: { title: 'Тепловые явления', hours: 12 }, rest: ['Внутренняя энергия'] });
    expect(splitSection('Раздел 3. Свет\nОтражение света', true, 1)).toEqual({ section: { title: 'Свет' }, rest: ['Отражение света'] });
  });
  it('«Мисал иштөө (2 саат)» in a 2-hour row is a lesson title, not a heading', () => {
    expect(splitSection('Мисал иштөө (2 саат)', true, 2)).toEqual({ rest: ['Мисал иштөө (2 саат)'] });
  });
});

describe('F10: meta helpers', () => {
  it('maps subject names to Bilig subject keys (ky / ru / en)', () => {
    expect(['алгебра', 'Геометрия', 'математике', 'Физика', 'химии', 'биология', 'Географиясы', 'астрономия', 'Информатика', 'Physics'].map(subjectKeyOf)).toEqual([
      'math', 'math', 'math', 'phys', 'chem', 'bio', 'geo', 'astro', 'inf', 'phys',
    ]);
    expect(subjectKeyOf('Табигый илимдер')).toBeNull();
    expect(subjectKeyOf('Кыргыз адабияты')).toBeNull();
  });
  it('teacher lines', () => {
    expect(findTeacher('Мугалим: Дженишев А.А.')).toBe('Дженишев А.А.');
    expect(findTeacher('Учитель – Петрова Анна Ивановна, высшая категория')).toBe('Петрова Анна Ивановна');
    expect(findTeacher('Мугалими: ____________')).toBe('');
  });
  it('language', () => {
    expect(detectLang('Сабактын темасы, саат, үй тапшырма')).toBe('ky');
    expect(detectLang('Тема урока, количество часов, домашнее задание')).toBe('ru');
  });
});

describe('F12: lesson types', () => {
  it.each([
    ['Текшерүү иши №3', 'test'],
    ['Контролдук иш', 'test'],
    ['текшерүү ишти анализдөө', 'analysis'],
    ['Мисал иштөө', 'practice'],
    ['Маселе чыгаруу', 'practice'],
    ['Көнүгүүлөр', 'practice'],
    ['Практикалык иш №2', 'practice'],
    ['Лабораториялык иш: маятник', 'practice'],
    ['Өз алдынча иш', 'test'],
    ['Контрольная работа №2', 'test'],
    ['Анализ контрольной работы', 'analysis'],
    ['Работа над ошибками', 'analysis'],
    ['Решение задач', 'practice'],
    ['Решение примеров', 'practice'],
    ['Практическая работа', 'practice'],
    ['Лабораторная работа №1', 'practice'],
    ['Самостоятельная работа', 'test'],
    ['Скорость', 'new'],
    ['Тест', 'test'],
  ])('%s → %s', (title, type) => expect(lessonType(title)).toBe(type));
});

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

describe('topic matching', () => {
  const m = (title: string, subjectKey: string | null = null, grade: number | null = 8) => matchTitle(index, title, { subjectKey, grade });

  it('normalisation and word matching', () => {
    expect(tokens('7.Координаталар (8 саат) § 8.1 №3 жана')).toEqual(['координаталар']);
    expect(wordMatch('ылдамдык', 'ылдамдыгы')).toBe(true);
    expect(wordMatch('атом', 'атомдун')).toBe(true);
    expect(wordMatch('скорость', 'скорости')).toBe(true);
    expect(wordMatch('сан', 'сандар')).toBe(false);
    expect(similarity(['a1'], [])).toBe(0);
  });

  it('calibrated examples (threshold 0.6)', () => {
    expect(MATCH_THRESHOLD).toBe(0.6);
    expect(m('Ылдамдык', 'phys')).toEqual({ topicKey: 'speed', score: 1 });
    expect(m('Атомдун түзүлүшү')).toEqual({ topicKey: 'atom-structure', score: 1 });
    expect(m('Скорость. Единицы скорости', 'phys')?.topicKey).toBe('speed');
    expect(m('Решение задач на расчет скорости', 'phys')?.topicKey).toBe('speed');
    expect(m('Тик бурчтуу үч бурчтук. Пифагордун теоремасы', 'math')?.topicKey).toBe('pythagorean-theorem');
    expect(m('Дем алуу системасы')?.topicKey).toBe('respiratory-system');
    expect(m('Сандар системасы', 'math')).toBeNull();
    expect(m('Сандар системасы')).toBeNull();
    expect(m('Мисал иштөө', 'math')).toBeNull();
  });

  it('test and analysis lessons get a topic only when the title names one', () => {
    expect(m('Текшерүү иши №1', 'math')).toBeNull();
    expect(m('Текшерүү ишти анализдөө', 'math')).toBeNull();
    expect(m('Контрольная работа по теме «Скорость»', 'phys')?.topicKey).toBe('speed');
  });

  it('the plan grade decides between grades; a word on the same root is not the same word (Physics 7)', () => {
    expect(m('Ылдамдык', 'phys', 7)?.topicKey).toBe('phys7-uniform-speed'); // not «Ылдамдануу» (acceleration)
    expect(m('Ылдамдык', 'phys', 8)?.topicKey).toBe('speed');
    expect(m('Ылдамдануу', 'phys', 7)?.topicKey).toBe('phys7-acceleration');
    expect(m('Сила тяжести', 'phys', 7)?.topicKey).toBe('phys7-gravity-weight');
    expect(m('Архимед күчү', 'phys', 7)?.topicKey).toBe('phys7-archimedes');
    expect(m('Рычаг', 'phys', 7)?.topicKey).toBe('phys7-lever');
    expect(wordWeight('ылдамдык', 'ылдамдыгы')).toBeCloseTo(7 / 8);
    expect(wordWeight('ылдамдык', 'ылдамдануу')).toBe(0);
    expect(wordWeight('атом', 'атомдун')).toBe(1);
  });

  it('other subjects need a stronger match; a teacher link is never overridden', () => {
    expect(m('Строение атома', 'math')).toEqual({ topicKey: 'atom-structure', score: 1 });
    expect(m('Сила реакции опоры', 'math')).toBeNull(); // concept-only hit, other subject
    expect(m('Сила реакции опоры', 'phys')?.topicKey).toBe('forces');
    const rows = [
      { index: 1, title: 'Ылдамдык', type: 'new' as const, topicKey: 'water', match: { auto: false, score: 1 } },
      { index: 2, title: 'Ылдамдык', type: 'new' as const, topicKey: null },
    ];
    expect(applyMatches(rows, index, { subjectKey: 'phys', grade: 8 }).map((r) => [r.topicKey, r.match])).toEqual([
      ['water', { auto: false, score: 1 }],
      ['speed', { auto: true, score: 1 }],
    ]);
  });
});

// ---------------------------------------------------------------------------
// teaching plan doc (create / patch)
// ---------------------------------------------------------------------------

describe('teaching plan document', () => {
  const src = { index, subjectKeys };

  it('links science lessons on create', () => {
    const doc = createPlanDoc(parse(scienceKtp()), { sourceName: 'КТП 8.docx', ...src });
    expect(doc.rows.map((r) => r.topicKey)).toEqual(['speed', 'atom-structure', null, null]);
    expect(doc.rows[0].match).toEqual({ auto: true, score: 1 });
    expect(doc).toMatchObject({ subjectKey: null, grade: 8, classes: ['8а'], totalHours: 4, lang: 'ky' });
  });

  it('PATCH keeps the teacher topic on re-validation, re-matches edited auto rows, clears a fixed impossible date', () => {
    const doc = createPlanDoc(parse(algebraKtp()), { sourceName: 'ktp.docx', ...src });
    expect(doc.issues.some((i) => i.code === 'date_invalid')).toBe(true);
    const a = patchPlanDoc(doc, { version: 1, rows: [{ index: 109, dates: { '8в': '2027-04-02' } }, { index: 3, topicKey: 'speed' }, { index: 4, title: 'Пифагордун теоремасы' }] }, src);
    if ('error' in a) throw new Error(a.error);
    expect(a.issues.some((i) => i.code === 'date_invalid')).toBe(false);
    expect(a.rows[2]).toMatchObject({ topicKey: 'speed', match: { auto: false, score: 1 } });
    expect(a.rows[3]).toMatchObject({ title: 'Пифагордун теоремасы', type: 'new', topicKey: 'pythagorean-theorem', match: { auto: true } });
    const b = patchPlanDoc(a, { version: 2, subjectKey: 'phys', rows: [{ index: 3, title: 'Мисал иштөө' }] }, src);
    if ('error' in b) throw new Error(b.error);
    expect(b.rows[2]).toMatchObject({ title: 'Мисал иштөө', type: 'practice', topicKey: 'speed', match: { auto: false } });
    expect(patchPlanDoc(doc, { version: 1, rows: [{ index: 999, title: 'x' }] }, src)).toEqual({ error: 'rows[0].index' });
    expect(patchPlanDoc(doc, { version: 1, rows: [{ index: 1, dates: { '9z': null } }] }, src)).toEqual({ error: 'rows[0].dates.9z' });
    expect(patchPlanDoc(doc, { version: 1, rows: [{ index: 1, topicKey: 'no-such-topic' }] }, src)).toEqual({ error: 'rows[0].topicKey' });
    expect(patchPlanDoc(doc, { version: 1, subjectKey: 'nope' }, src)).toEqual({ error: 'subjectKey' });
  });
});

// ---------------------------------------------------------------------------
// plan content and .docx
// ---------------------------------------------------------------------------

const speedPkg = published.find((p) => p.topic.key === 'speed')!;
const baseRow: KtpRow = { index: 1, number: 1, title: 'Ылдамдык', hours: 1, type: 'new', dates: { '8б': '2026-09-15' }, homework: '', note: '', topicKey: 'speed' };
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  plan: { subjectName: 'алгебра', subjectKey: 'math', grade: 8, teacherName: 'Асанов Б.' },
  row: { ...baseRow, title: 'Сандар системасы', topicKey: null },
  cls: '8б',
  lang: 'ky',
  ...over,
});

describe('plan content', () => {
  it('every lesson type totals 45 minutes over the 7 official stages', () => {
    for (const [type, times] of Object.entries(STAGE_TIMES)) {
      expect(times.reduce((a, b) => a + b, 0), type).toBe(45);
      const c = buildPlanContent(input({ row: { ...input().row, type: type as KtpRow['type'] } }));
      expect(c.stages).toHaveLength(7);
      expect(c.totalMinutes).toBe(45);
      expect(c.stages.map((s) => s.name)).toEqual(PLAN_TEXTS.ky.stages);
    }
  });

  it('F9: sources follow the subject (no «Табигый илимдер» for algebra); draft note always', () => {
    const c = buildPlanContent(input());
    expect(c.sources).toEqual(['Алгебра окуу китеби (8-класс)', 'Bilig платформасы']);
    expect(JSON.stringify(c)).not.toContain('Табигый илимдер');
    expect(c).toMatchObject({ subject: 'Алгебра', classLabel: '8б', date: '15.09.2026', teacher: 'Асанов Б.', target: '(13-14 жаш курагындагы окуучулар үчүн, 8-класс, окутуу тили – кыргыз тилинде)' });
    expect(c.draftNote).toContain('Долбоор');
    expect(buildPlanContent(input({ lang: 'ru' })).sources[0]).toBe('Учебник «Алгебра» для 8 класса');
  });

  it('from a linked topic: goal, objectives, motivation, tour, practical work, mini-test, § and pages', () => {
    const c = buildPlanContent(input({ plan: { subjectName: 'физика', subjectKey: 'phys', grade: 8, teacherName: '' }, row: baseRow, topic: { pkg: speedPkg, textbooks: content.base.textbooks ?? [] } }));
    expect(c.task).toContain('v = s/t');
    expect(c.goal1).toBe(c.task);
    expect(c.outcome1).toContain('Ылдамдыкты эсептөө');
    expect(c.stages[0].teacher).toContain('«Жарыш»');
    expect(c.stages[3].teacher).toContain('Машина түз жол менен бара жатат.');
    expect(c.stages[3].teacher).toContain('Кеңеш:');
    expect(c.stages[3].teacher.split('\n').length).toBeLessThanOrEqual(5);
    expect(c.stages[4].teacher).toContain('Машинанын ылдамдыгын ченөө');
    expect(c.stages[6].teacher).toContain('Ылдамдыкты кайсы формула менен эсептейбиз?');
    expect(c.sources[0]).toBe('Табигый илимдер 8, § 8.1, 176–185-беттер');
    expect(c.homework).toBe('§ 8.1 окуу, 176–185-беттер');
    expect(c.materials).toContain('Bilig: «Ылдамдык»');
    expect(c.teacher).toBe('______________________');
    const ru = buildPlanContent(input({ lang: 'ru', row: { ...baseRow, homework: '§ 8.1, № 3' }, topic: { pkg: speedPkg, textbooks: content.base.textbooks ?? [] } }));
    expect(ru.sources[0]).toBe('Естественные науки 8, § 8.1, стр. 176–185');
    expect(ru.homework).toBe('§ 8.1, № 3');
    expect(ru.stages[6].teacher).toContain('По какой формуле вычисляют скорость?');
  });

  it('test and analysis lessons check the section', () => {
    const row = { ...baseRow, title: 'Текшерүү иши №1', type: 'test' as const, topicKey: null, section: { title: 'Сан', hours: 10 } };
    const c = buildPlanContent(input({ row }));
    expect(c.task).toBe('«Сан» боюнча окуучулардын билимин жана көндүмдөрүн текшерүү.');
    expect(c.stages[4]).toMatchObject({ minutes: '30 мүнөт', assessment: 'Суммативдик баа.' });
    expect(c.homework).toBe('Үй тапшырмасы берилбейт.');
  });
});

describe('F11: plan .docx from the tagged template', () => {
  const stageRows = (lines: string[]) => lines.filter((l) => /^\| \d\. /.test(l));
  const minutes = (lines: string[]) => stageRows(lines).reduce((s, l) => s + Number(/\| (\d+) (?:мүнөт|мин|min) \|/.exec(l)?.[1] ?? NaN), 0);

  it('ky and ru from the same template: same structure as the prototype demo (7 stages, goals table, 45 min)', () => {
    for (const lang of ['ky', 'ru', 'en'] as const) {
      const lines = dumpDocx(renderPlansDocx([buildPlanContent(input({ lang }))]));
      const text = lines.join('\n');
      expect(text).not.toMatch(/[{}]/);
      expect(stageRows(lines)).toHaveLength(7);
      expect(minutes(lines)).toBe(45);
      for (const label of [PLAN_LABELS[lang].goalEdu, PLAN_LABELS[lang].goalDev, PLAN_LABELS[lang].goalUp, PLAN_LABELS[lang].flow, PLAN_LABELS[lang].sources])
        expect(text).toContain(label);
      expect(text).toContain(PLAN_TEXTS[lang].draftNote);
    }
    const ky = dumpDocx(renderPlansDocx([buildPlanContent(input())]));
    expect(ky).toContain('8б -класс                      Числосу: 15.09.2026                                    Мугалими: Асанов Б.');
    expect(ky).toContain('Сабактын темасы: Сандар системасы');
    expect(ky).toContain('Предмети: Алгебра');
    const ru = dumpDocx(renderPlansDocx([buildPlanContent(input({ lang: 'ru' }))])).join('\n');
    expect(ru).toContain('Ход урока:');
    expect(ru).toContain('Тема урока: Сандар системасы');
    expect(ru).not.toContain('Сабактын');
  });

  it('keeps the official layout: landscape page, Times New Roman, fixed column widths, no personal data', () => {
    const zip = new PizZip(renderPlansDocx([buildPlanContent(input())]));
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).toContain('w:orient="landscape"');
    expect(xml).toContain('<w:gridCol w:w="2296"/><w:gridCol w:w="1276"/>');
    expect(xml).toContain('w:ascii="Times New Roman"');
    expect(xml).not.toContain('Абдизаит');
    expect(zip.file('docProps/core.xml')!.asText()).toContain('<dc:creator>Bilig</dc:creator>');
    expect(zip.file('customXml/item1.xml')).toBeNull();
  });

  it('a range is one document with a page break between plans', () => {
    const plans = [1, 2, 3].map((i) => buildPlanContent(input({ row: { ...input().row, index: i, title: `Тема ${i}` } })));
    const lines = dumpDocx(renderPlansDocx(plans));
    expect(lines.filter((l) => l === '\f')).toHaveLength(2);
    expect(stageRows(lines)).toHaveLength(21);
    expect(lines.filter((l) => l.startsWith('Сабактын темасы:'))).toEqual(['Сабактын темасы: Тема 1', 'Сабактын темасы: Тема 2', 'Сабактын темасы: Тема 3']);
  });
});
