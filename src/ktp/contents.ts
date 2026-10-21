/**
 * v0.9.2: read a textbook's contents («Мазмуну», «Содержание», «Оглавление»)
 * into a TextbookDraft (pure, except the model call made by the caller).
 *
 * Two readers, one result:
 *  - text (a PDF text layer, a .docx): `parseContentsText` — the contents
 *    lines are recognised without a model: chapter headings («I ГЛАВА. …»,
 *    «Глава 2», «3-бөлүм»), numbered lessons with their page at the line end
 *    («§ 4. Жол жана которулуш ..... 19», «4.1 …  19»), wrapped lines, chapter
 *    tests and lab works / appendices;
 *  - page images (a scan, photos): the model reads them (`contentsPrompt`,
 *    `CONTENTS_SCHEMA`) and `fromModel` checks what it returned.
 * Then `finishDraft`: page ranges from the start pages, kinds, warnings.
 */
import type { Lang } from '@bilig/content-model';
import type { DraftChapter, DraftLesson, KtpContentsResponse, TextbookDraft } from '@bilig/content-model/api';
import { z } from 'zod';

type Warning = KtpContentsResponse['warnings'][number];

/** A lesson as read, with only its start page (ranges come in `finishDraft`). */
interface ReadLesson {
  number: string;
  kind: DraftLesson['kind'];
  title: string;
  page?: number;
}
interface ReadChapter {
  number: string;
  title: string;
  page?: number;
  lessons: ReadLesson[];
}

// `\b` is ASCII-only in JS regexps: Cyrillic words end at (?!\p{L}).
const CONTENTS_WORDS = /^(мазмуну|мазмун|содержание|оглавление|contents|table of contents)(?!\p{L})/iu;
const REVIEW = /(тест|текшерүү|текшерүү иш|кайталоо|жыйынтык|контрольн|проверочн|повторени|обобщени|итогов|self[- ]check|revision|review|\btest\b)/i;
const EXTRA = /(көрсөтмө|указани|как работать|how to use|лаборатор|тиркеме|тиркемелер|приложени|практикалык иш|практическ|appendix|lab work|laborator|глоссар|сөздүк|словарь|жооптор|ответы|answers|колдонулган адабият|литератур)/i;
const LAB = /(лаборатор|lab work|laborator)/i;
const ROMAN = /^(?=[IVXLC]+$)M{0,0}C{0,3}(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const romanValue = (s: string) => {
  const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let n = 0;
  for (let i = 0; i < s.length; i++) n += v[s[i]] < (v[s[i + 1]] ?? 0) ? -v[s[i]] : v[s[i]];
  return n;
};

/** «Нерсенин ... ............. 17» → title and page (dot leaders, «–», spaces). */
function splitPage(line: string): { text: string; page?: number } {
  const m = line.match(/^(.*?)[\s.…·_‥•\-–—]*?(\d{1,4})\s*$/u);
  if (m && m[1].trim() && /[\s.…·_]$|\.{2,}|…/.test(line.slice(0, line.length - m[2].length).trimEnd() + ' ')) return { text: m[1].replace(/[\s.…·_‥•]+$/u, '').trim(), page: Number(m[2]) };
  return { text: line.trim() };
}

const CHAPTER =
  /^(?:(?<n1>[IVXLC]+|\d{1,2})\s*[-–.]?\s*(?:глава|бөлүм|бап|раздел|тема|chapter|unit|part)(?!\p{L})\.?|(?:глава|бөлүм|бап|раздел|тема|chapter|unit|part)\s+(?<n2>[IVXLC]+|\d{1,2})(?![\p{L}\p{N}])[.:]?)\s*(?<rest>.*)$/iu;
const LESSON = /^(?:§\s*)?(?<n>\d{1,3}(?:\.\d{1,2}){0,2})[.)]?\s+(?<rest>\S.*)$/u;
const SECTION_MARK = /^§\s*(?<n>\d{1,3}(?:\.\d{1,2})?)[.)]?\s*(?<rest>.*)$/u;

/**
 * Contents lines → chapters (no model). Lines before the «Мазмуну» heading are skipped when the
 * heading is there; a line without a page continues into the next one (a wrapped title).
 */
export function parseContentsText(text: string): ReadChapter[] {
  let lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    // A line that is only a number is the page footer of the contents page («269»), not a § line.
    .filter((l) => l && !/^\d{1,4}$/.test(l));
  const head = lines.findIndex((l) => CONTENTS_WORDS.test(l));
  if (head >= 0) lines = lines.slice(head + 1);
  const chapters: ReadChapter[] = [];
  const current = () => {
    if (!chapters.length) chapters.push({ number: '', title: '', lessons: [] });
    return chapters[chapters.length - 1];
  };
  let pending = '';
  // Numbering seen so far: numbered lines after the § series that restart from 1 («1. Связь …») are appendices.
  let lastNumber = 0;
  let sectionMarks = 0;
  for (const raw of lines) {
    // A wrapped title: the first part may end in dot leaders of its own («на графике. .»).
    const line = pending ? `${pending.replace(/(?:\s*[.…·_]){2,}\s*$/u, '.').trimEnd()} ${raw}` : raw;
    const { text: body, page } = splitPage(line);
    const ch = body.match(CHAPTER);
    const sec = body.match(SECTION_MARK) ?? body.match(LESSON);
    if (ch?.groups) {
      pending = '';
      const n = ch.groups.n1 ?? ch.groups.n2 ?? '';
      chapters.push({ number: ROMAN.test(n) ? String(romanValue(n)) : n, title: ch.groups.rest.replace(/^[.:\s]+/, '').trim() || body, page, lessons: [] });
      continue;
    }
    if (page === undefined) {
      // A heading line without a page in capitals («III ГЛАВА» was handled above): a chapter title without number.
      if (raw === raw.toLocaleUpperCase() && /\p{Lu}{4,}/u.test(raw) && !sec) {
        chapters.push({ number: '', title: raw, lessons: [] });
        pending = '';
      } else pending = line.length < 400 ? line : '';
      continue;
    }
    pending = '';
    if (sec?.groups) {
      const title = sec.groups.rest.trim();
      const n = Number.parseInt(sec.groups.n, 10);
      const marked = /^§/.test(body);
      if (marked) sectionMarks++;
      if (!marked && sectionMarks >= 3 && n < lastNumber) {
        current().lessons.push({ number: sec.groups.n, kind: 'extra', title, page });
        continue;
      }
      if (Number.isFinite(n)) lastNumber = Math.max(lastNumber, n);
      // A numbered line is a lesson, unless it is a lab work («№ 3. Лабораториялык иш») or a test.
      current().lessons.push({ number: sec.groups.n, kind: LAB.test(title) ? 'extra' : /^(тест|текшерүү иши|контрольная|test)(?!\p{L})/iu.test(title) ? 'review' : 'lesson', title, page });
      continue;
    }
    // «Киришүү ..... 8» before any chapter: the introduction is the first chapter's title.
    if (/^(киришүү|кириш сөз|введение|introduction)(?!\p{L})/iu.test(body) && chapters.length <= 1 && !chapters[0]?.title) {
      if (chapters.length) Object.assign(chapters[0], { title: body, page });
      else chapters.push({ number: '', title: body, page, lessons: [] });
      continue;
    }
    // An unnumbered line with a page: a test, a lab works block, an appendix.
    current().lessons.push({ number: '', kind: EXTRA.test(body) ? 'extra' : REVIEW.test(body) ? 'review' : 'lesson', title: body, page });
  }
  return chapters.filter((c) => c.lessons.length);
}

// ---------------------------------------------------------------------------
// the model (page images)
// ---------------------------------------------------------------------------

export const CONTENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contentsImages: { type: 'array', items: { type: 'integer' }, description: '0-based indexes of the images that show the table of contents' },
    title: { type: 'string', description: 'Book title as printed (cover or title page), empty if not seen' },
    grade: { type: 'integer', description: 'School grade 1–12 if printed, else 0' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          number: { type: 'string', description: 'Chapter number as printed (I, 2, …), empty if none' },
          title: { type: 'string' },
          lessons: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'string', description: 'Paragraph / lesson number as printed (§ 4 → "4", 4.1 → "4.1"), empty if none' },
                title: { type: 'string', description: 'The line text exactly as printed, without the number and the page' },
                page: { type: 'integer', description: 'Start page printed at the end of the line, 0 if none' },
              },
              required: ['number', 'title', 'page'],
            },
          },
        },
        required: ['number', 'title', 'lessons'],
      },
    },
  },
  required: ['contentsImages', 'chapters'],
};

export const contentsPrompt = (count: number, lang?: Lang) =>
  [
    `These are ${count} page images of a school textbook (its first and last pages), in order, indexed from 0.`,
    'Find the table of contents (Мазмуну / Содержание / Оглавление / Contents) and copy it completely, line by line, in its own language and spelling — do not translate, fix or shorten anything.',
    'Keep the book order. A line with a chapter heading (ГЛАВА, Бөлүм, Раздел, Тема, Chapter) starts a chapter; every other line with a page number is a lesson of the current chapter (tests, lab works, the introduction and appendices are lines too).',
    'If a title wraps onto the next line, join it. If there is no table of contents in the images, return an empty chapters list.',
    lang ? `The book is probably in ${lang === 'ky' ? 'Kyrgyz' : lang === 'ru' ? 'Russian' : 'English'}.` : '',
    'Answer with json only.',
  ]
    .filter(Boolean)
    .join('\n');

const ModelOut = z.object({
  contentsImages: z.array(z.number()).catch([]),
  title: z.string().catch(''),
  grade: z.number().catch(0),
  chapters: z
    .array(
      z.object({
        number: z.coerce.string().catch(''),
        title: z.string().catch(''),
        lessons: z.array(z.object({ number: z.coerce.string().catch(''), title: z.string().catch(''), page: z.coerce.number().catch(0) })).catch([]),
      }),
    )
    .catch([]),
});

/** What the model returned → chapters (lines classified like the text parser does). */
export function fromModel(data: unknown): { chapters: ReadChapter[]; contentsImages: number[]; title: string; grade: number | null } {
  const r = ModelOut.safeParse(data);
  if (!r.success) return { chapters: [], contentsImages: [], title: '', grade: null };
  const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/[\s.…·_]+$/u, '').trim();
  const chapters: ReadChapter[] = r.data.chapters
    .map((c) => ({
      number: ROMAN.test(c.number.trim()) ? String(romanValue(c.number.trim())) : c.number.replace(/[^\p{L}\p{N}.]/gu, '').slice(0, 20),
      title: clean(c.title),
      lessons: c.lessons
        .map((l) => {
          const title = clean(l.title);
          const number = l.number.replace(/[^\d.]/g, '').replace(/\.$/, '').slice(0, 20);
          const kind: ReadLesson['kind'] = number ? (LAB.test(title) ? 'extra' : 'lesson') : EXTRA.test(title) ? 'extra' : REVIEW.test(title) ? 'review' : 'lesson';
          return { number, kind, title, ...(l.page > 0 && l.page < 5000 ? { page: Math.round(l.page) } : {}) };
        })
        .filter((l) => l.title),
    }))
    .filter((c) => c.lessons.length);
  return { chapters, contentsImages: r.data.contentsImages.filter((n) => Number.isInteger(n) && n >= 0), title: clean(r.data.title), grade: r.data.grade >= 1 && r.data.grade <= 12 ? Math.round(r.data.grade) : null };
}

// ---------------------------------------------------------------------------
// the draft
// ---------------------------------------------------------------------------

/**
 * Chapters as read → the draft: page ranges (a lesson ends where the next line starts; the last one
 * spans one page), chapter titles, a book title, warnings for what the teacher should check.
 */
export function finishDraft(read: ReadChapter[], meta: { title: string; grade: number | null; lang: Lang; subjectKey: string | null }): { draft: TextbookDraft; warnings: Warning[] } {
  const warnings: Warning[] = [];
  // The contract's draft: a chapter has 1–200 lines, at most 60 chapters (a heading with nothing under it is dropped).
  const chapters = read
    .map((c) => ({ ...c, lessons: c.lessons.filter((l) => l.title.trim()).slice(0, 200) }))
    .filter((c) => c.lessons.length)
    .slice(0, 60);
  const flat = chapters.flatMap((c, ci) => c.lessons.map((l, li) => ({ l, ci, li })));
  const out: DraftChapter[] = chapters.map((c, ci) => ({
    // An unnumbered chapter (the introduction) keeps no number: «Киришүү», not «1».
    number: c.number.slice(0, 20),
    title: (c.title || `${ci + 1}`).slice(0, 300),
    lessons: c.lessons.map((l, li) => {
      const k = flat.findIndex((x) => x.ci === ci && x.li === li);
      const next = flat.slice(k + 1).find((x) => x.l.page !== undefined)?.l.page;
      if (l.page === undefined) warnings.push({ code: 'no_pages', chapter: ci, lesson: li });
      else if (next !== undefined && next < l.page) warnings.push({ code: 'pages_order', chapter: ci, lesson: li });
      const pages = l.page !== undefined ? { from: l.page, to: Math.max(l.page, next !== undefined && next > l.page ? next - 1 : l.page) } : undefined;
      return { number: l.number.slice(0, 20), kind: l.kind, title: l.title.slice(0, 500), ...(pages ? { pages } : {}) };
    }),
  }));
  if (!out.length || !out.some((c) => c.lessons.some((l) => l.kind === 'lesson'))) warnings.push({ code: 'no_lessons' });
  return { draft: { title: (meta.title.trim() || 'Окуу китеби').slice(0, 300), grade: meta.grade, lang: meta.lang, subjectKey: meta.subjectKey, chapters: out.length ? out : [{ number: '1', title: '—', lessons: [{ number: '', kind: 'lesson', title: '—' }] }] }, warnings };
}

/** Enough recognised lessons with pages to trust the text parser (else the model reads the text). */
export const looksParsed = (chapters: ReadChapter[]) => {
  const ls = chapters.flatMap((c) => c.lessons);
  return ls.length >= 5 && ls.filter((l) => l.page !== undefined).length / ls.length >= 0.7;
};
