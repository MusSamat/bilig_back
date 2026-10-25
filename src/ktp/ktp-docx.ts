/**
 * v0.9.2: a КТП as .docx (GET /ktp/:id/docx) — the plan the teacher sees, in the layout schools use and
 * the КТП parser reads back (download, edit in Word, upload again): a heading block (school, subject,
 * grade, year, hours, teacher), then one table «№ · topic · hours · date (a column per class) · homework ·
 * note» with a banner row per chapter «… (12 саат)» and the total. The note column names the Bilig topic
 * of the lesson. Landscape A4, plain OOXML (no template: the table grows with the plan).
 */
import PizZip from 'pizzip';
import type { Lang } from '@bilig/content-model';
import type { KtpRow } from '@bilig/content-model/api';

export interface KtpDocxInput {
  title: string;
  subjectName: string;
  grade: number | null;
  year: number | null;
  lang: Lang;
  teacherName: string;
  schoolName: string;
  classes: string[];
  rows: KtpRow[];
  /** Topic titles by key, for the note column. */
  topicTitle: (key: string) => string | undefined;
  /** Lessons a week, when known (the heading says «Жумасына 2 саат»). */
  hoursPerWeek?: number;
  /** v0.10.0: a preliminary plan (from a textbook / the standard, not scheduled yet): «(алдын ала)» in the heading. Default true. */
  draft?: boolean;
}

const ruHours = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'час' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'часа' : 'часов');

const L: Record<Lang, { num: string; topic: string; hours: string; date: string; homework: string; note: string; total: (n: number) => string; unit: (n: number) => string; head: (i: KtpDocxInput, total: number) => string[] }> = {
  ky: {
    num: '№',
    topic: 'Сабактын темасы',
    hours: 'Саат',
    date: 'Датасы',
    homework: 'Үй тапшырма',
    note: 'Эскертүү (Bilig темасы)',
    total: (n) => `Бардыгы: ${n} саат`,
    unit: (n) => `${n} саат`,
    head: (i, n) => [
      i.schoolName,
      `${i.grade ? `${i.grade}-класстын ` : ''}${i.subjectName} предмети боюнча`,
      `${i.year ? `${i.year}-${i.year + 1}-окуу жылы үчүн ` : ''}календардык-тематикалык планы${i.draft === false ? '' : ' (алдын ала)'}`,
      `${i.hoursPerWeek ? `Жумасына ${i.hoursPerWeek} саат, ` : ''}бардыгы ${n} саат`,
      `Мугалим: ${i.teacherName || '________________'}`,
    ],
  },
  ru: {
    num: '№',
    topic: 'Тема урока',
    hours: 'Кол-во часов',
    date: 'Дата',
    homework: 'Домашнее задание',
    note: 'Примечание (тема Bilig)',
    total: (n) => `Всего: ${n} ${ruHours(n)}`,
    unit: (n) => `${n} ${ruHours(n)}`,
    head: (i, n) => [
      i.schoolName,
      `Календарно-тематическое планирование${i.draft === false ? '' : ' (предварительное)'} по предмету «${i.subjectName}»${i.grade ? ` для ${i.grade} класса` : ''}${i.year ? ` на ${i.year}-${i.year + 1} учебный год` : ''}`,
      `${i.hoursPerWeek ? `${i.hoursPerWeek} ${ruHours(i.hoursPerWeek)} в неделю, ` : ''}всего ${n} ${ruHours(n)}`,
      `Учитель: ${i.teacherName || '________________'}`,
    ],
  },
  en: {
    num: '№',
    topic: 'Lesson topic',
    hours: 'Hours',
    date: 'Date',
    homework: 'Homework',
    note: 'Note (Bilig topic)',
    total: (n) => `Total: ${n} hours`,
    unit: (n) => `${n} hours`,
    head: (i, n) => [
      i.schoolName,
      `Scheme of work${i.draft === false ? '' : ' (draft)'}: ${i.subjectName}${i.grade ? `, grade ${i.grade}` : ''}${i.year ? `, ${i.year}-${i.year + 1}` : ''}`,
      `${i.hoursPerWeek ? `${i.hoursPerWeek} hours a week, ` : ''}total ${n} hours`,
      `Teacher: ${i.teacherName || '________________'}`,
    ],
  },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const run = (text: string, bold = false, size = 22) =>
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text: string, o: { bold?: boolean; center?: boolean; size?: number } = {}) =>
  `<w:p><w:pPr><w:spacing w:after="40"/>${o.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${text ? run(text, o.bold, o.size) : ''}</w:p>`;

interface Cell {
  text: string;
  bold?: boolean;
  span?: number;
  /** Vertical merge: 'restart' starts a merged cell, 'continue' continues it. */
  vmerge?: 'restart' | 'continue';
  center?: boolean;
  shade?: string;
}
const cell = (c: Cell, width: number) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${c.span && c.span > 1 ? `<w:gridSpan w:val="${c.span}"/>` : ''}${c.vmerge ? `<w:vMerge${c.vmerge === 'restart' ? ' w:val="restart"' : ''}/>` : ''}${c.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${c.shade}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>` +
  `<w:p><w:pPr><w:spacing w:after="0"/>${c.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${c.text ? run(c.text, c.bold, 20) : ''}</w:p></w:tc>`;

const isoToDmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

export function ktpDocx(i: KtpDocxInput): Buffer {
  const T = L[i.lang];
  const total = i.rows.reduce((s, r) => s + r.hours, 0);
  const dateCols = Math.max(1, i.classes.length);
  // Column widths (twips) on landscape A4 (≈ 14 800 usable): №, topic, hours, dates…, homework, note.
  const dateW = 1100;
  const widths = [600, 0, 900, ...Array<number>(dateCols).fill(dateW), 2300, 2600];
  widths[1] = 14800 - widths.reduce((a, b) => a + b, 0);
  const cols = widths.length;
  const span = (from: number, n: number) => widths.slice(from, from + n).reduce((a, b) => a + b, 0);
  const tr = (cells: string, header = false) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;

  const header: string[] = [];
  const H = 'D9E8F5';
  if (i.classes.length) {
    header.push(
      tr(
        cell({ text: T.num, bold: true, vmerge: 'restart', center: true, shade: H }, widths[0]) +
          cell({ text: T.topic, bold: true, vmerge: 'restart', center: true, shade: H }, widths[1]) +
          cell({ text: T.hours, bold: true, vmerge: 'restart', center: true, shade: H }, widths[2]) +
          cell({ text: T.date, bold: true, span: dateCols, center: true, shade: H }, span(3, dateCols)) +
          cell({ text: T.homework, bold: true, vmerge: 'restart', center: true, shade: H }, widths[3 + dateCols]) +
          cell({ text: T.note, bold: true, vmerge: 'restart', center: true, shade: H }, widths[4 + dateCols]),
        true,
      ),
      tr(
        [0, 1, 2].map((k) => cell({ text: '', vmerge: 'continue', shade: H }, widths[k])).join('') +
          i.classes.map((c, k) => cell({ text: c, bold: true, center: true, shade: H }, widths[3 + k])).join('') +
          [3 + dateCols, 4 + dateCols].map((k) => cell({ text: '', vmerge: 'continue', shade: H }, widths[k])).join(''),
        true,
      ),
    );
  } else {
    header.push(tr([T.num, T.topic, T.hours, T.date, T.homework, T.note].map((t, k) => cell({ text: t, bold: true, center: true, shade: H }, widths[k])).join(''), true));
  }

  const body: string[] = [];
  let section = '';
  for (const r of i.rows) {
    const s = r.section ? `${r.section.title}${r.section.hours !== undefined ? ` (${T.unit(r.section.hours)})` : ''}` : '';
    if (s && s !== section) {
      section = s;
      body.push(tr(cell({ text: s, bold: true, span: cols, shade: 'F2F2F2' }, span(0, cols))));
    }
    const dates = i.classes.length ? i.classes.map((c) => r.dates[c] ?? null) : [null];
    const topic = r.topicKey ? i.topicTitle(r.topicKey) : undefined;
    const note = [r.note, topic ? `Bilig: ${topic}` : ''].filter(Boolean).join('; ');
    body.push(
      tr(
        cell({ text: String(r.number || r.index), center: true }, widths[0]) +
          cell({ text: r.title }, widths[1]) +
          cell({ text: String(r.hours), center: true }, widths[2]) +
          dates.map((d, k) => cell({ text: d ? isoToDmy(d) : '', center: true }, widths[3 + k])).join('') +
          cell({ text: r.homework }, widths[3 + dateCols]) +
          cell({ text: note }, widths[4 + dateCols]),
      ),
    );
  }
  body.push(tr(cell({ text: '' }, widths[0]) + cell({ text: T.total(total), bold: true, span: cols - 1 }, span(1, cols - 1))));

  const border = '<w:top w:val="single" w:sz="4" w:color="808080"/><w:left w:val="single" w:sz="4" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:color="808080"/><w:right w:val="single" w:sz="4" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:color="808080"/><w:insideV w:val="single" w:sz="4" w:color="808080"/>';
  const table =
    `<w:tbl><w:tblPr><w:tblW w:w="14800" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="70" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header.join('')}${body.join('')}</w:tbl>`;
  const head = T.head(i, total).filter((x) => x.trim() && !/^\s*$/.test(x));
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
    head.map((h, k) => para(h, { bold: k <= 2, center: true, size: k <= 2 ? 26 : 22 })).join('') +
    para('') +
    table +
    para('') +
    '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="850" w:right="1000" w:bottom="850" w:left="1000" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', doc);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
