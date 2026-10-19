/** КТП fixtures built in code (see docx-builder.ts). */
import { ALGEBRA_8_TABLES } from './algebra-8.data.js';
import { buildDocx, type BlockSpec, type CellSpec } from './docx-builder.js';

const R = { vMerge: 'restart' as const };
const C = { vMerge: 'continue' as const };

/** The real algebra КТП layout: «№ | Сабактын темасы | Саат | Датасы (8б, 8в) | Эскертүү | Үй тапшырма». */
function algebraHeader(): CellSpec[][] {
  return [
    [{ text: '№', ...R }, { text: 'Сабактын темасы', ...R }, { text: 'Саат', ...R }, { text: 'Датасы', span: 2 }, { text: 'Эскертүү', ...R }, { text: 'Үй тапшырма', ...R }],
    [C, C, C, '8б', '8в', C, C],
  ];
}

export function algebraKtpBlocks(): BlockSpec[] {
  const blocks: BlockSpec[] = [
    { table: [['«Бекитемин»', 'Мектептин директору: __________']] },
    { p: '' },
    { p: '№12 жалпы билим берүү мектебинин' },
    { p: '8-класстарынын алгебра предмети боюнча' },
    { p: '2026-2027-окуу жылы үчүн календардык-тематикалык планы' },
    { p: 'Жумасына 4 саат, бардыгы 136 саат' },
    { p: 'Мугалим: Асанов Бакыт Урматович' },
  ];
  ALGEBRA_8_TABLES.forEach((rows, i) => {
    const body: CellSpec[][] = rows.map(([n, title, d8b, d8v, hours]) => [n, title, hours, d8b, d8v, '', '']);
    if (i === ALGEBRA_8_TABLES.length - 1) body.push(['', 'Жалпы 136', '', '', '', '', '']);
    blocks.push({ table: [...algebraHeader(), ...body] }, { p: '' });
  });
  return blocks;
}

export const algebraKtp = () => buildDocx(algebraKtpBlocks());

const width = (r: CellSpec[]) => r.reduce((s: number, c) => s + (typeof c === 'string' ? 1 : (c.span ?? 1)), 0);
const pad = (r: CellSpec[], n: number): CellSpec[] => r.concat(Array(Math.max(0, n - width(r))).fill(''));

/**
 * A Russian physics КТП: «8 «Б»» headers under a «Дата» cell spanning two
 * columns, a section banner row across the table, dates in several formats
 * (no year, dd/mm/yy, dd-mm-yyyy), a Sunday, a holiday, a double lesson.
 */
export function russianKtpBlocks(): BlockSpec[] {
  return [
    { p: 'Средняя школа № 5 им. Ч. Айтматова' },
    { p: 'Календарно-тематическое планирование по физике для 8 «Б», 8 «В» классов на 2026-2027 учебный год' },
    { p: 'Учитель: Иванова Мария Петровна' },
    { p: 'Всего 6 часов' },
    {
      table: [
        [{ text: '№ п/п', ...R }, { text: 'Тема урока', ...R }, { text: 'Кол-во часов', ...R }, { text: 'Дата', span: 2 }, { text: 'Примечание', ...R }, { text: 'Домашнее задание', ...R }],
        [C, C, C, '8 «Б»', '8 «В»', C, C],
        [{ text: 'Раздел 1. Движение и силы (5 часов)', span: 7 }],
        ['1', 'Скорость. Единицы скорости', '1', '02.09', '03/09/26', '', '§ 8.1'],
        ['2', 'Решение задач на расчет скорости', '1', '07-09-2026', '06.09.26', 'перенос', '§ 8.1, № 3'],
        ['3', 'Контрольная работа №1', '1', '09.09', '09.09'],
        ['4', 'Анализ контрольной работы', '1', '09.09', '07.11.26'],
        ['5', 'Сила тяжести', '1', '14.09', ''],
        [{ text: '2 четверть', span: 7 }],
        ['6', 'Лабораторная работа «Измерение силы трения»', '1', '16.09', '16.09'],
      ].map((r) => pad(r as CellSpec[], 7)),
    },
  ];
}

export const russianKtp = () => buildDocx(russianKtpBlocks());

/** A natural-sciences КТП in Kyrgyz linking to real topics: one header row with the class labels. */
export function scienceKtpBlocks(): BlockSpec[] {
  return [
    { p: 'Табигый илимдер предмети боюнча 8-класс үчүн 2026-2027-окуу жылына календардык-тематикалык план' },
    { p: 'Мугалими: Токтогулова Айпери' },
    {
      table: [
        ['№', 'Сабактын темасы', 'Саат', '8а', 'Үй тапшырма'],
        ['1', 'Ылдамдык', '1', '01.09.26', ''],
        ['2', 'Атомдун түзүлүшү', '1', '03.09.26', '§ 4.1'],
        ['3', 'Сандар системасы', '1', '08.09.26', ''],
        ['4', 'Текшерүү иши №1', '1', '10.09.26', ''],
      ],
    },
  ];
}

export const scienceKtp = () => buildDocx(scienceKtpBlocks());
