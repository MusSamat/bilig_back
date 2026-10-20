/**
 * КТП (календарно-тематический план) parser: DocxDocument → meta, classes, lessons.
 * Pure: no I/O; `now` only resolves dates without a year when the plan names no school year.
 *
 * Tables are recognised by content, not by position: the header row is the one
 * with a «№» cell and a title-like cell; class labels («8б», «8 «Б»», «8-Б»)
 * are looked up in the header rows (also under a «Дата» cell spanning them).
 * A table without a header continues the previous layout when the grid matches.
 * Lesson numbers restart per table; `index` is the position in the whole plan.
 */
import type { Lang } from '@bilig/content-model';
import type { KtpLessonType, KtpRow, KtpSection } from '@bilig/content-model/api';
import type { DocxDocument, DocxTable, GridCell } from './docx-read.js';
import { lessonType } from './lesson-type.js';

export type ParsedRow = Omit<KtpRow, 'topicKey' | 'match'>;
/** Raw text of impossible dates by lesson index and class (kept so re-validation still reports them). */
export type InvalidDates = Record<string, Record<string, string>>;

export interface KtpMeta {
  title: string;
  subjectName: string;
  subjectKey: string | null;
  teacherName: string;
  schoolName: string;
  year: number | null;
  declaredHours: number | null;
  grade: number | null;
  lang: Lang;
}

export interface ParsedKtp {
  meta: KtpMeta;
  classes: string[];
  rows: ParsedRow[];
  invalidDates: InvalidDates;
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

const low = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');
const W = '(?<!\\p{L})';
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() : s);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

// ---------------------------------------------------------------------------
// subjects
// ---------------------------------------------------------------------------

interface SubjectEntry {
  stems: string[];
  key: string | null;
  name: Record<Lang, string>;
}

export const SUBJECTS: SubjectEntry[] = [
  { stems: ['алгебр', 'algebra'], key: 'math', name: { ky: 'алгебра', ru: 'алгебра', en: 'algebra' } },
  { stems: ['геометр', 'geometry'], key: 'math', name: { ky: 'геометрия', ru: 'геометрия', en: 'geometry' } },
  { stems: ['математик', 'mathemat', 'maths'], key: 'math', name: { ky: 'математика', ru: 'математика', en: 'mathematics' } },
  { stems: ['физик', 'physics'], key: 'phys', name: { ky: 'физика', ru: 'физика', en: 'physics' } },
  { stems: ['хими', 'chemistry'], key: 'chem', name: { ky: 'химия', ru: 'химия', en: 'chemistry' } },
  { stems: ['биолог', 'biology'], key: 'bio', name: { ky: 'биология', ru: 'биология', en: 'biology' } },
  { stems: ['географ', 'geography'], key: 'geo', name: { ky: 'география', ru: 'география', en: 'geography' } },
  { stems: ['астроном', 'astronomy'], key: 'astro', name: { ky: 'астрономия', ru: 'астрономия', en: 'astronomy' } },
  { stems: ['информатик', 'informatics', 'computer science'], key: 'inf', name: { ky: 'информатика', ru: 'информатика', en: 'computer science' } },
  {
    stems: ['табигый илим', 'естествозн', 'естественн', 'natural science'],
    key: null,
    name: { ky: 'табигый илимдер', ru: 'естествознание', en: 'natural sciences' },
  },
];

/** Known subject named by a text («алгебре», «Физика», «табигый илимдер»). */
export function subjectOf(text: string): SubjectEntry | null {
  const t = low(text);
  for (const s of SUBJECTS) if (s.stems.some((st) => new RegExp(`${W}${st}`, 'u').test(t))) return s;
  return null;
}

/** Bilig subject key for a subject name; null for unknown or integrated (natural sciences) subjects. */
export const subjectKeyOf = (name: string): string | null => subjectOf(name)?.key ?? null;

function findSubjectName(text: string, lang: Lang): string {
  const l = low(text);
  const candidates: string[] = [];
  // ky: «… 8-класстарынын алгебра предмети боюнча …»
  const ky = /((?:[\p{L}-]+\s+){0,2}[\p{L}-]+)\s+предмет\S*\s+боюнча/u.exec(l);
  if (ky) candidates.push(ky[1].split(/\s+/).filter((w) => !/класс|мектеб|окуу|жыл|\d/.test(w)).join(' '));
  // «Предмет: алгебра», «Предмети: Физика»
  const label = /предмет(?:и|у)?\s*[:–—-]\s*[«"]?([^\n,;»"]+)/u.exec(l);
  if (label) candidates.push(label[1]);
  // ru: «по предмету «Физика»», «… план(ирование) по алгебре для 8 класса»
  const ru1 = /по\s+предмету\s*[«"]?([^»"\n,;]+)/u.exec(l);
  if (ru1) candidates.push(ru1[1]);
  const ru2 = /(?:план\S*|планирован\S*)\s+(?:уроков\s+)?по\s+((?:[\p{L}-]+\s*){1,3})/u.exec(l);
  if (ru2) candidates.push(ru2[1].split(/\s+(?:для|в|на|за|\d)/u)[0]);
  for (const c of candidates) {
    const s = subjectOf(c);
    if (s) return s.name[lang];
  }
  const firstRaw = candidates.map((c) => c.trim()).find((c) => c.length > 1 && c.length <= 60);
  if (firstRaw) return firstRaw;
  // fallback: a known subject word anywhere in the heading
  const any = subjectOf(l);
  return any ? any.name[lang] : '';
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export function detectLang(text: string): Lang {
  const t = low(text);
  const kyLetters = (t.match(/[ңөү]/g) ?? []).length;
  const kyWords = (t.match(/(?<!\p{L})(саат|сабак\S*|боюнча|мугалим\S*|окуу|жылы|жана|темасы|тапшырма\S*)(?!\p{L})/gu) ?? []).length;
  const ruWords = (t.match(/(?<!\p{L})(урок\S*|час\S*|учебн\S*|учител\S*|работа|для|тема|дата|примечание|домашнее)(?!\p{L})/gu) ?? []).length;
  const latin = (t.match(/[a-z]/g) ?? []).length;
  const cyr = (t.match(/[а-я]/g) ?? []).length;
  if (latin > cyr * 2 && latin > 20) return 'en';
  const ky = kyLetters + 3 * kyWords;
  const ru = 3 * ruWords;
  if (ky === 0 && ru === 0) return 'ky';
  return ky >= ru ? 'ky' : 'ru';
}

export function findYear(text: string): number | null {
  const re = /(?<!\d)(20\d{2})\s*[-–—/]\s*(20\d{2}|\d{2})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const a = Number(m[1]);
    const b = m[2].length === 2 ? Math.floor(a / 100) * 100 + Number(m[2]) : Number(m[2]);
    if (b === a + 1) return a;
  }
  return null;
}

const TOTAL_RE = /(?<!\p{L})(бардыгы|баары|жалпы|всего|итого)(?:\s+(?:саат\S*|час\S*))?\s*[:\-–—]?\s*(\d{1,3})(?!\d)(?!\s*(?:жума|недел|week))/iu;

/** Declared total («Бардыгы 136 саат», «Жалпы 136», «Всего 136 часов», «Итого: 136»). */
export function findDeclaredHours(text: string): number | null {
  const m = TOTAL_RE.exec(text);
  return m ? Number(m[2]) : null;
}

const TEACHER_RE = /(?<!\p{L})(?:мугалим(?:и|дин аты-жөнү)?|предмет мугалими|учитель|преподаватель|составил(?:а|и)?|түзгөн|teacher)\s*[:–—-]\s*([^\n,;]+)/iu;

export function findTeacher(text: string): string {
  const m = TEACHER_RE.exec(text);
  if (!m) return '';
  return m[1].replace(/_{2,}.*/, '').replace(/\s+/g, ' ').trim().replace(/[,;:–—-]+$/, '').trim();
}

const SCHOOL_PATTERNS: RegExp[] = [
  // ky: «№12 жалпы билим берүү мектебинин», «Ак-Суу орто мектеби», «№5 мектеп-гимназиясы»
  /((?:№\s*\d+\s*)?(?:[\p{L}-]+\s+){0,5}?(?:мектеп-гимназия|мектеп-лицей|мектеб|мектеп|гимназия|лицей)\p{L}*)/iu,
  // ru: «Средняя школа № 5», «СОШ №12 им. …», «Гимназия №3»
  /((?:(?:средн|основн|общеобразовательн|муниципальн)\S*\s+){0,3}(?:школа|школы|гимназия|гимназии|лицей|лицея|СОШ|ООШ)\s*№\s*\d+(?:\s+(?:им\.|имени)\s+[^,;\n]+)?)/iu,
];

export function findSchool(text: string): string {
  for (const line of text.split('\n')) {
    for (const re of SCHOOL_PATTERNS) {
      const m = re.exec(line);
      if (m && !/предмет|мугалим|учител/i.test(m[1])) {
        return m[1]
          .replace(/(мектеб)(инин|инде|ине)$/iu, '$1и')
          .replace(/(мектеп-гимназия|мектеп-лицей|гимназия|лицей)(сынын|сында|сына)$/iu, '$1сы')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  }
  return '';
}

const APPROVAL_RE = /бекитем|утвержд|согласован|макулдаш|каралды|рассмотрен|протокол|директор|завуч|окуу бөлүм|оиб\b|м\.п\./iu;
const TITLE_HINT = /календар|тематик|ктп|сабактардын планы|поурочн/iu;

function findTitle(paras: string[]): string {
  const lines = paras.map((p) => oneLine(p));
  const isMeta = (s: string) => !s || APPROVAL_RE.test(s) || TEACHER_RE.test(s) || /^(жумасына|в неделю|недельн)/iu.test(s);
  const hit = lines.findIndex((s) => TITLE_HINT.test(s) && !APPROVAL_RE.test(s));
  if (hit >= 0) {
    let a = hit;
    let b = hit;
    while (a > 0 && !isMeta(lines[a - 1])) a--;
    while (b + 1 < lines.length && !isMeta(lines[b + 1]) && b - a < 4) b++;
    return clip(lines.slice(a, b + 1).join(' ').replace(/\s{2,}/g, ' '), 500);
  }
  return clip(lines.filter((s) => !isMeta(s)).slice(0, 3).join(' '), 500);
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const DATE_RE = /(?<![\d.])(\d{1,2})\s*[./-]\s*(\d{1,2})(?:\s*[./-]\s*(\d{4}|\d{2}))?(?![\d])/g;

export interface DateToken {
  raw: string;
  iso: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** All date tokens of a cell; a date without a year takes the school year (Jul–Dec → year, Jan–Jun → year + 1). */
export function dateTokens(text: string, schoolYear: number): DateToken[] {
  const out: DateToken[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y: number;
    if (m[3]) y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    else y = mo >= 7 ? schoolYear : schoolYear + 1;
    const raw = m[0].replace(/\s+/g, '');
    if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) out.push({ raw, iso: null });
    else out.push({ raw, iso: `${y}-${pad(mo)}-${pad(d)}` });
  }
  return out;
}

function inferSchoolYear(text: string, now: Date): number {
  const votes = new Map<number, number>();
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)/g)) {
    const mo = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mo < 1 || mo > 12) continue;
    const sy = mo >= 7 ? y : y - 1;
    votes.set(sy, (votes.get(sy) ?? 0) + 1);
  }
  if (votes.size) return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ---------------------------------------------------------------------------
// table layout
// ---------------------------------------------------------------------------

const CLASS_RE = /^(\d{1,2})\s*[-–—]?\s*[«"“„']?\s*([A-Za-zА-Яа-яЁёҢңӨөҮү])\s*[»"”']?\s*(?:класс|кл\.?)?$/u;
const NUM_HDR = /^(№|n|#)\s*(п\s*\/\s*п|п\.?\s*п\.?|с\/н|р\/с|сабак)?\.?$|^№/iu;
const TITLE_HDR = /тема|аталыш|мазмун|содержан|раздел|бөлүм|наименован/iu;
const HOURS_HDR = /саат|час|кол-?во|саны/iu;
const DATE_HDR = /дата|датасы|мөөнөт|күнү|число|срок/iu;
const NOTE_HDR = /эскерт|примеч|коррекц|өзгөрт|изменен/iu;
const HOMEWORK_HDR = /үй\s*тапшыр|үй\s*иш|домашн|д\s*\/\s*з|д\.\s*з/iu;
const TYPE_HDR = /тиби|тип\s*урока|^тип$/iu;

export function classLabel(text: string): string | null {
  const m = CLASS_RE.exec(text.trim());
  return m ? `${m[1]}${m[2]}` : null;
}

interface Layout {
  cols: number;
  num: number;
  title: number;
  hours: number | null;
  note: number | null;
  homework: number | null;
  type: number | null;
  classes: { col: number; label: string }[];
}

/** Lesson numbers in a № cell: «12», «12.», «43\n44», «43-44», «43, 44». */
export function lessonNumbers(text: string): number[] {
  const t = text.trim();
  if (!t) return [];
  const range = /^(\d{1,3})\s*[-–—]\s*(\d{1,3})\.?$/.exec(t);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (b > a && b - a < 6) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  const parts = t.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  const nums: number[] = [];
  for (const p of parts) {
    const m = /^(\d{1,3})\s*[.)]?$/.exec(p);
    if (!m) return [];
    nums.push(Number(m[1]));
  }
  return nums;
}

function detectLayout(t: DocxTable, fallbackLabel: string): { layout: Layout; header: number; dataStart: number } | null {
  const maxHeader = Math.min(t.rows.length, 5);
  for (let h = 0; h < maxHeader; h++) {
    const row = t.rows[h];
    const num = row.findIndex((c) => !c.colSpanned && NUM_HDR.test(c.text.trim()));
    if (num < 0) continue;
    let title = row.findIndex((c, i) => i !== num && !c.colSpanned && TITLE_HDR.test(c.text) && !TYPE_HDR.test(c.text));
    if (title < 0) continue;
    // header region: the header row and the rows under it that carry no lesson number
    let end = h;
    while (end + 1 < t.rows.length && end - h < 2) {
      const next = t.rows[end + 1];
      const hasNum = lessonNumbers(next[num]?.rowSpanned ? '' : (next[num]?.text ?? '')).length > 0;
      const hasLabels = next.some((c) => !c.colSpanned && classLabel(c.text) !== null);
      if (hasNum || (!hasLabels && next.some((c) => /\d/.test(c.text)))) break;
      end++;
      if (hasLabels) break;
    }
    const head = (col: number) =>
      t.rows
        .slice(h, end + 1)
        .map((r) => r[col]?.text ?? '')
        .join(' ');
    const classes: { col: number; label: string }[] = [];
    for (let r = h; r <= end; r++)
      t.rows[r].forEach((c, col) => {
        if (c.colSpanned || col === num || col === title) return;
        const label = classLabel(c.text);
        if (label && !classes.some((x) => x.col === col || x.label === label)) classes.push({ col, label });
      });
    const used = new Set([num, title, ...classes.map((c) => c.col)]);
    const pick = (re: RegExp, extra?: (col: number) => boolean) => {
      for (let col = 0; col < t.cols; col++) if (!used.has(col) && re.test(head(col)) && (!extra || extra(col))) return col;
      return null;
    };
    if (!classes.length) {
      const date = pick(DATE_HDR);
      if (date !== null) {
        classes.push({ col: date, label: fallbackLabel });
        used.add(date);
      }
    }
    const homework = pick(HOMEWORK_HDR);
    if (homework !== null) used.add(homework);
    const note = pick(NOTE_HDR);
    if (note !== null) used.add(note);
    const type = pick(TYPE_HDR);
    if (type !== null) used.add(type);
    const hours = pick(HOURS_HDR, (col) => !DATE_HDR.test(head(col)));
    if (title === num) title = num + 1;
    return { layout: { cols: t.cols, num, title, hours, note, homework, type, classes }, header: h, dataStart: end + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

const UNIT = String.raw`(?:саат\p{L}*|сағ|час(?:а|ов)?|ч)\.?`;
const HOURS_TAIL = new RegExp(String.raw`(?:[(\[]\s*(\d{1,3})\s*${UNIT}\s*[)\]]|[-–—:,]\s*(\d{1,3})\s*${UNIT})\s*[.,;:]?$`, 'iu');
const SECTION_LEAD = /^\s*(?:бөлүм|раздел|глава|модуль|тема|section|unit)\s*\d*|^\s*(?:\d{1,2}|[IVX]{1,4})\s*(?:[.)]|[-–]?\s*(?:бөлүм|раздел|глава))\s*\S/iu;
const QUARTER_RE = /^(?:[IVX]{1,4}|\d)\s*[-–]?\s*(?:чейрек|четверть|жарым жылдык|полугодие|триместр|term|quarter)\S*\.?$/iu;

function cleanSectionTitle(s: string): string {
  return oneLine(s)
    .replace(HOURS_TAIL, '')
    .replace(/^\s*(?:\d{1,2}|[IVX]{1,4})\s*[-–]?\s*(?:бөлүм|раздел|глава|модуль)\p{L}*\s*[.:)]?\s*/iu, '')
    .replace(/^\s*(?:бөлүм|раздел|глава|модуль|section|unit)\s*/iu, '')
    .replace(/^\s*(?:\d{1,2}|[IVX]{1,4})\s*[.):\-–]\s*/u, '')
    .replace(/[\s/.,;:–—-]+$/u, '')
    .trim();
}

/**
 * Split a section heading off a title cell. Lines up to the one ending in
 * «(10 саат)» are the heading; the rest is the lesson title.
 * A heading-only cell is a heading when the row has no number, starts with
 * «2.» / «Бөлүм» / «Раздел», or declares more hours than the row has.
 */
export function splitSection(text: string, hasNumber: boolean, rowHours: number): { section?: KtpSection; rest: string[] } {
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return { rest: [] };
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const m = HOURS_TAIL.exec(lines[i]);
    if (!m) continue;
    const hours = Number(m[1] ?? m[2]);
    const headingOnly = i === lines.length - 1;
    if (headingOnly && hasNumber && !SECTION_LEAD.test(lines[0]) && !(hours > Math.max(rowHours, 1))) return { rest: lines };
    const title = cleanSectionTitle(lines.slice(0, i + 1).join(' ')) || oneLine(lines.slice(0, i + 1).join(' '));
    return { section: { title: clip(title, 300), hours }, rest: lines.slice(i + 1) };
  }
  // no hours: «Раздел 2. Тепловые явления» + lesson on the next line
  if (lines.length > 1 && /^\s*(?:бөлүм|раздел|глава|модуль)\s*\d*/iu.test(lines[0])) {
    return { section: { title: clip(cleanSectionTitle(lines[0]) || lines[0], 300) }, rest: lines.slice(1) };
  }
  return { rest: lines };
}

// ---------------------------------------------------------------------------
// hours
// ---------------------------------------------------------------------------

/** Hours for k lessons of one row: one value per line, or a total split evenly (remainder first, ≥ 1 each). */
export function splitHours(text: string, k: number): number[] {
  const values = text
    .split('\n')
    .map((l) => /(\d{1,2})/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Math.min(10, Number(m[1])));
  if (!values.length) return Array(k).fill(1);
  if (values.length === k) return values;
  const total = values.reduce((a, b) => a + b, 0);
  if (k === 1) return [Math.min(10, total)];
  const base = Math.floor(total / k);
  const rem = total % k;
  return Array.from({ length: k }, (_, j) => Math.max(1, base + (j < rem ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const cellOf = (row: GridCell[], col: number | null): string => (col === null || !row[col] ? '' : row[col].text);

export function parseKtp(doc: DocxDocument, opts: { now?: Date } = {}): ParsedKtp {
  const now = opts.now ?? new Date();
  const paras = doc.blocks.filter((b): b is { kind: 'p'; text: string } => b.kind === 'p').map((b) => b.text);
  const tables = doc.blocks.filter((b): b is { kind: 'table'; table: DocxTable } => b.kind === 'table').map((b) => b.table);
  const firstTable = doc.blocks.findIndex((b) => b.kind === 'table');
  const headParas = (firstTable < 0 ? doc.blocks : doc.blocks.slice(0, firstTable)).flatMap((b) => (b.kind === 'p' ? [b.text] : []));
  const allParaText = paras.join('\n');
  const allTableText = tables.flatMap((t) => t.rows.flatMap((r) => r.filter((c) => !c.colSpanned && !c.rowSpanned).map((c) => c.text))).join('\n');

  const title = findTitle(headParas.length ? headParas : paras);
  const lang = detectLang(`${allParaText}\n${allTableText.slice(0, 20_000)}`);
  const headingText = `${title}\n${headParas.join('\n')}`;
  const year = findYear(headingText) ?? findYear(allParaText);
  const titleGrade = /(?<!\d)(\d{1,2})\s*[-–]?\s*(?:«?[\p{L}]»?\s*)?(?:класс|кл\.|grade)/iu.exec(headingText);
  let grade: number | null = titleGrade ? Number(titleGrade[1]) : null;
  if (grade !== null && (grade < 1 || grade > 12)) grade = null;
  const fallbackLabel = grade !== null ? String(grade) : 'class';
  const schoolYear = year ?? inferSchoolYear(allTableText, now);

  const rows: ParsedRow[] = [];
  const classes: string[] = [];
  const invalidDates: InvalidDates = {};
  const footerTotals: number[] = [];
  let section: KtpSection | undefined;
  let prevLayout: Layout | null = null;
  let index = 0;

  for (const t of tables) {
    let found: { layout: Layout; header: number; dataStart: number } | null = detectLayout(t, fallbackLabel);
    if (!found && prevLayout && prevLayout.cols === t.cols) found = { layout: prevLayout, header: -1, dataStart: 0 };
    // a continuation table whose header is repeated below its first lessons (page break): read from the top
    else if (found && found.header > 0 && t.rows.slice(0, found.header).some((r) => lessonNumbers(r[found!.layout.num]?.text ?? '').length > 0))
      found = { ...found, dataStart: 0 };
    if (!found) continue;
    const L: Layout = found.layout;
    prevLayout = L;
    for (const c of L.classes) if (!classes.includes(c.label)) classes.push(c.label);
    let lastInTable: ParsedRow | null = null;

    for (let r = found.dataStart; r < t.rows.length; r++) {
      const row = t.rows[r];
      const numCell = row[L.num];
      const nums = lessonNumbers(numCell && !numCell.rowSpanned ? numCell.text : '');
      const origins = row.filter((c) => !c.colSpanned && !c.rowSpanned && c.text);
      const rowText = [...new Set(origins.map((c) => c.text))].join('\n');
      if (!rowText) continue;

      if (!nums.length) {
        // header repeated on a new page
        if (NUM_HDR.test(cellOf(row, L.num).trim()) && TITLE_HDR.test(cellOf(row, L.title))) continue;
        const total = findDeclaredHours(oneLine(rowText));
        if (total !== null || /^(бардыгы|баары|жалпы|всего|итого)\s*:?$/iu.test(oneLine(rowText).split(' ')[0] ?? '')) {
          const v = total ?? Number(/(\d{1,3})/.exec(cellOf(row, L.hours))?.[1] ?? NaN);
          if (Number.isFinite(v)) footerTotals.push(v);
          continue;
        }
        if (QUARTER_RE.test(oneLine(rowText))) continue;
        const hasDates = L.classes.some((c) => dateTokens(cellOf(row, c.col), schoolYear).length > 0);
        const text = cellOf(row, L.title) || rowText;
        if (!hasDates) {
          const banner = origins.length === 1;
          const s = splitSection(text, false, 0);
          if (s.section || banner || SECTION_LEAD.test(text) || !lastInTable) {
            section = s.section ?? { title: clip(cleanSectionTitle(text) || oneLine(text), 300) };
            continue;
          }
          // a title continued on the next row (page or row break)
          lastInTable.title = clip(oneLine(`${lastInTable.title} ${oneLine(text)}`), 500);
          continue;
        }
        // a dated lesson without a number
        nums.push(0);
      }

      const k = nums.length;
      const hoursList = splitHours(cellOf(row, L.hours), k);
      const split = splitSection(cellOf(row, L.title), true, hoursList.reduce((a, b) => a + b, 0));
      if (split.section) section = split.section;
      const titleLines = split.rest.length ? split.rest : split.section ? [split.section.title] : [];
      const titles = k > 1 && titleLines.length === k ? titleLines : Array(k).fill(titleLines.join(' '));
      const perClass = L.classes.map((c) => ({ label: c.label, tokens: dateTokens(cellOf(row, c.col), schoolYear) }));
      const hwLines = cellOf(row, L.homework).split('\n');
      const noteLines = cellOf(row, L.note).split('\n');
      const typeCell = cellOf(row, L.type);

      for (let j = 0; j < k; j++) {
        index++;
        const titleJ = clip(oneLine(titles[j] ?? ''), 500);
        const dates: Record<string, string | null> = {};
        for (const c of perClass) {
          // one date per line of a merged row; a single date = a double lesson on that day
          const tok = c.tokens.length === k ? c.tokens[j] : c.tokens.length === 1 ? c.tokens[0] : c.tokens[j];
          dates[c.label] = tok?.iso ?? null;
          if (tok && tok.iso === null) (invalidDates[String(index)] ??= {})[c.label] = tok.raw;
        }
        const typeFromCol: KtpLessonType | null = typeCell ? lessonType(typeCell) : null;
        const row: ParsedRow = {
          index,
          number: nums[j],
          ...(section ? { section: { ...section } } : {}),
          title: titleJ,
          hours: hoursList[j],
          type: typeFromCol && typeFromCol !== 'new' ? typeFromCol : lessonType(titleJ),
          dates,
          homework: clip(oneLine(k > 1 && hwLines.length === k ? hwLines[j] : hwLines.join('\n')), 1000),
          note: clip(oneLine(k > 1 && noteLines.length === k ? noteLines[j] : noteLines.join('\n')), 1000),
        };
        rows.push(row);
        lastInTable = row;
      }
    }
  }

  // classes named in the header → grade, when the title did not say it
  const gradesFromClasses = [...new Set(classes.map((c) => Number(/^\d+/.exec(c)?.[0])).filter((g) => g >= 1 && g <= 12))];
  if (gradesFromClasses.length === 1) grade = gradesFromClasses[0];

  const subjectName = findSubjectName(headingText, lang) || findSubjectName(allParaText, lang);
  const declaredHours = findDeclaredHours(allParaText) ?? (footerTotals.length ? Math.max(...footerTotals) : null);

  return {
    meta: {
      title,
      subjectName: clip(subjectName, 200),
      subjectKey: subjectKeyOf(subjectName),
      teacherName: clip(findTeacher(allParaText), 200),
      schoolName: clip(findSchool(headParas.join('\n')) || findSchool(allParaText), 300),
      year,
      declaredHours,
      grade,
      lang,
    },
    classes,
    rows,
    invalidDates,
  };
}
