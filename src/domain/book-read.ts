/**
 * v0.9.3: reading a school book with the AI (prompts, output schemas and the
 * checks of what comes back — pure). Three passes:
 *
 *  1. pages (vision, no reasoning — it is transcription): every page's printed
 *     numbers (a scanned spread has two), its kind (cover, contents, …), the
 *     headings with their § numbers, the full text, highlighted terms, formulas;
 *  2. every § (a thinking model, on the text of its pages): what a teacher and
 *     Bilig need later — summary, objectives, terms with the book's definitions,
 *     formulas, quantities, facts, experiments, the questions after the §,
 *     keywords for linking future topics;
 *  3. the book (title page + contents): title, authors, publisher, year, summary.
 *
 * Everything is in the book's own language and copied, not invented: the
 * model is told to leave a field empty rather than guess.
 */
import { z } from 'zod';
import type { Lang } from '@bilig/content-model';

const LANG: Record<Lang, string> = { ky: 'Kyrgyz', ru: 'Russian', en: 'English' };

export const PAGE_KINDS = ['cover', 'title', 'toc', 'chapter', 'content', 'exercises', 'lab', 'appendix', 'other'] as const;

export const PAGES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', description: '0-based index of the image (or text page) in this request' },
          printed: { type: 'array', items: { type: 'integer' }, description: 'Page numbers printed on it (two for a spread), [] if none' },
          kind: { type: 'string', enum: [...PAGE_KINDS] },
          headings: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, properties: { number: { type: 'string', description: '§ / lesson number as printed, e.g. "12" or "4.1", empty if none' }, text: { type: 'string' } }, required: ['number', 'text'] },
          },
          text: { type: 'string', description: 'All the text of the page in reading order, exactly as printed; formulas in plain text (v = s/t)' },
          terms: { type: 'array', items: { type: 'string' }, description: 'Highlighted (bold / coloured / framed) terms' },
          formulas: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'printed', 'kind', 'headings', 'text', 'terms', 'formulas'],
      },
    },
  },
  required: ['pages'],
};

export const pagesPrompt = (count: number, lang: Lang, images: boolean) =>
  [
    images ? `These are ${count} page images of a ${LANG[lang]} school textbook, in order, indexed from 0.` : `These are ${count} pages of a ${LANG[lang]} school textbook (text extracted from the PDF), in order, indexed from 0, each inside <page i="…">.`,
    'For every page: the page numbers printed on it, what kind of page it is, the headings (chapter and § headings, with the § number), all its text in reading order exactly as printed (do not translate, fix or shorten), the highlighted terms and the formulas.',
    'A scanned spread shows two book pages: give both printed numbers and the text of the left page first.',
    'Answer with json only.',
  ].join('\n');

const str = (max: number) => z.coerce.string().catch('').transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max));
const strList = (max: number, n: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((xs) => [...new Set(xs.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).map((x) => x.slice(0, max)))].slice(0, n));

export const PageReadSchema = z.object({
  index: z.coerce.number().int().catch(-1),
  printed: z.array(z.coerce.number()).catch([]).transform((ns) => ns.filter((n) => Number.isInteger(n) && n > 0 && n < 5000).slice(0, 2)),
  kind: z.enum(PAGE_KINDS).catch('other'),
  headings: z
    .array(z.object({ number: str(20), text: str(300) }))
    .catch([])
    .transform((hs) => hs.filter((h) => h.text).slice(0, 12)),
  // The text keeps its line breaks (paragraphs, contents lines).
  text: z.coerce.string().catch('').transform((s) => s.replace(/[ \t]+/g, ' ').trim().slice(0, 20_000)),
  terms: strList(120, 40),
  formulas: strList(200, 30),
});
export type PageRead = z.infer<typeof PageReadSchema>;

/** The model's pages → one read per requested page (by index); missing ones are null. */
export function readPages(data: unknown, count: number): (PageRead | null)[] {
  const raw = z.object({ pages: z.array(z.unknown()).catch([]) }).catch({ pages: [] }).parse(data ?? {});
  const out: (PageRead | null)[] = Array(count).fill(null);
  raw.pages.forEach((p, k) => {
    const r = PageReadSchema.safeParse(p);
    if (!r.success) return;
    const i = r.data.index >= 0 && r.data.index < count ? r.data.index : k;
    if (i < count && !out[i]) out[i] = r.data;
  });
  return out;
}

// ---------------------------------------------------------------------------
// one §
// ---------------------------------------------------------------------------

export const SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: '2–4 sentences: what the § teaches' },
    objectives: { type: 'array', items: { type: 'string' }, description: 'What a pupil can do after it (3–6)' },
    keyTerms: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { term: { type: 'string' }, definition: { type: 'string', description: 'The book’s own definition' } }, required: ['term', 'definition'] } },
    formulas: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { formula: { type: 'string' }, meaning: { type: 'string' } }, required: ['formula', 'meaning'] } },
    quantities: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, symbol: { type: 'string' }, unit: { type: 'string' } }, required: ['name', 'symbol', 'unit'] } },
    facts: { type: 'array', items: { type: 'string' }, description: 'Important facts, numbers, laws stated in the §' },
    experiments: { type: 'array', items: { type: 'string' }, description: 'Experiments, demonstrations, lab work described' },
    questions: { type: 'array', items: { type: 'string' }, description: 'The questions and tasks printed after the §, as printed' },
    keywords: { type: 'array', items: { type: 'string' }, description: '5–15 subject words (dictionary form) to find this § by' },
  },
  required: ['summary', 'objectives', 'keyTerms', 'formulas', 'quantities', 'facts', 'experiments', 'questions', 'keywords'],
};

export function sectionPrompt(o: { lang: Lang; subject: string; grade: number; bookTitle: string; chapter: string; number: string; title: string; text: string }): string {
  return [
    `A ${LANG[o.lang]} school textbook: «${o.bookTitle}», ${o.subject}, grade ${o.grade}. Chapter: «${o.chapter}».`,
    `Below is the text of § ${o.number || ''} «${o.title}» (the pages it spans; the start of the next § may follow — ignore it).`,
    `Describe this § for teachers in ${LANG[o.lang]}, using ONLY what the text says: copy definitions, formulas, numbers and questions as printed; leave a list empty rather than invent. Keep the book's terms and spelling.`,
    '<text>',
    o.text,
    '</text>',
    'Answer with json only.',
  ].join('\n');
}

const SectionInfoSchema = z.object({
  summary: str(2000),
  objectives: strList(400, 10),
  keyTerms: z
    .array(z.object({ term: str(120), definition: str(600) }))
    .catch([])
    .transform((xs) => xs.filter((x) => x.term).slice(0, 30)),
  formulas: z
    .array(z.object({ formula: str(200), meaning: str(400) }))
    .catch([])
    .transform((xs) => xs.filter((x) => x.formula).slice(0, 20)),
  quantities: z
    .array(z.object({ name: str(120), symbol: str(20), unit: str(40) }))
    .catch([])
    .transform((xs) => xs.filter((x) => x.name).slice(0, 20)),
  facts: strList(500, 15),
  experiments: strList(500, 10),
  questions: strList(600, 30),
  keywords: strList(80, 30),
});
export type SectionInfo = z.infer<typeof SectionInfoSchema>;

export const EMPTY_SECTION_INFO: SectionInfo = { summary: '', objectives: [], keyTerms: [], formulas: [], quantities: [], facts: [], experiments: [], questions: [], keywords: [] };

export const readSection = (data: unknown): SectionInfo => SectionInfoSchema.catch(EMPTY_SECTION_INFO).parse(data ?? {});

// ---------------------------------------------------------------------------
// the book
// ---------------------------------------------------------------------------

export const BOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'As printed on the cover / title page' },
    authors: { type: 'array', items: { type: 'string' } },
    publisher: { type: 'string' },
    year: { type: 'integer', description: 'Year of the edition, 0 if not printed' },
    part: { type: 'integer', description: 'Volume (1, 2…), 0 if one volume' },
    summary: { type: 'string', description: '2–5 sentences: what the book covers' },
  },
  required: ['title', 'authors', 'publisher', 'year', 'part', 'summary'],
};

export const bookPrompt = (o: { lang: Lang; subject: string; grade: number; front: string; contents: string }) =>
  [
    `The first pages and the contents of a ${LANG[o.lang]} school textbook (${o.subject}, grade ${o.grade}).`,
    'Give its title, authors, publisher, year and volume exactly as printed (empty / 0 when not printed), and a short summary of what it covers, in the book’s language.',
    '<front>',
    o.front,
    '</front>',
    '<contents>',
    o.contents,
    '</contents>',
    'Answer with json only.',
  ].join('\n');

export const readBookMeta = (data: unknown) =>
  z
    .object({
      title: str(300),
      authors: strList(200, 20),
      publisher: str(200),
      year: z.coerce.number().catch(0).transform((y) => (Number.isInteger(y) && y >= 1950 && y <= 2100 ? y : null)),
      part: z.coerce.number().catch(0).transform((p) => (Number.isInteger(p) && p >= 1 && p <= 9 ? p : null)),
      summary: str(3000),
    })
    .catch({ title: '', authors: [], publisher: '', year: null, part: null, summary: '' })
    .parse(data ?? {});
