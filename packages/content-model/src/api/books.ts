/**
 * v0.9.3: the book library. Staff upload a school book (a PDF) choosing its
 * grade, language and subject; the browser turns its pages into images (or
 * text, for a PDF with a text layer) and sends them in batches; the server
 * reads the whole book with the AI assistant in the background:
 *
 *  1. every page → its text, headings, terms and formulas (vision);
 *  2. the contents («Мазмуну») → chapters and § with their pages;
 *  3. every § → what a teacher and Bilig need later (a thinking model): a
 *     summary, objectives, key terms with the book's definitions, formulas,
 *     quantities, facts, experiments, the questions after the §, keywords to
 *     link future topics with, and the matched Bilig topic when one exists;
 *  4. the book itself → title, authors, year, a summary.
 *
 * Staff check and publish it. Teachers then choose the book of each class and
 * subject they teach; without an own КТП the system offers the КТП made from
 * the book (POST /ktp/from-textbook with `bookId`). Nothing 3D is made here.
 */
import { z } from 'zod';
import { KeySchema } from '../common.js';
import { LangSchema } from '../i18n.js';
import { DateTimeSchema, IdSchema } from './common.js';
import { DraftPagesSchema } from './ktp.js';

export const BOOK_STATUSES = ['uploading', 'queued', 'processing', 'review', 'published', 'failed', 'archived'] as const;
export const BookStatusSchema = z.enum(BOOK_STATUSES);
export type BookStatus = z.infer<typeof BookStatusSchema>;

/** v0.9.4: a pupil's textbook, or a teacher's guide (lesson plans for a textbook) — not offered as a class book. */
export const BOOK_KINDS = ['textbook', 'teacher_guide'] as const;
export const BookKindSchema = z.enum(BOOK_KINDS);
export type BookKind = z.infer<typeof BookKindSchema>;

export const BOOK_STAGES = ['pages', 'contents', 'sections', 'book', 'done'] as const;
export const BookStageSchema = z.enum(BOOK_STAGES);
export type BookStage = z.infer<typeof BookStageSchema>;

/** Max PDF pages of one book. */
export const BOOK_MAX_PAGES = 600;
/** Pages per upload request. */
export const BOOK_PAGES_PER_UPLOAD = 6;
/** Max bytes of one page image. */
export const BOOK_PAGE_IMAGE_BYTES = 1_500_000;

const short = (n: number) => z.string().trim().min(1).max(n);

/** What the book teaches in one § (or a chapter test / lab work / appendix line). */
export const BookSectionSchema = z.object({
  id: IdSchema,
  /** 0-based reading order in the book. */
  order: z.number().int().min(0),
  chapterNumber: z.string().max(20),
  chapterTitle: z.string().max(300),
  /** As printed: «4», «4.1»; empty for an unnumbered line. */
  number: z.string().max(20),
  kind: z.enum(['lesson', 'review', 'extra']),
  title: short(500),
  /** Printed pages of the book. */
  pages: DraftPagesSchema.optional(),
  /** 2–4 sentences: what the § is about, in the book's language. */
  summary: z.string().max(2000),
  objectives: z.array(short(400)).max(10),
  /** Terms the § introduces, with its own definition. */
  keyTerms: z.array(z.object({ term: short(120), definition: z.string().max(600) })).max(30),
  /** Formulas as printed (plain text or TeX) and what they mean. */
  formulas: z.array(z.object({ formula: short(200), meaning: z.string().max(400) })).max(20),
  /** Physical / other quantities: name, symbol, unit. */
  quantities: z.array(z.object({ name: short(120), symbol: z.string().max(20), unit: z.string().max(40) })).max(20),
  facts: z.array(short(500)).max(15),
  /** Experiments, demonstrations, lab work described in the §. */
  experiments: z.array(short(500)).max(10),
  /** Questions and tasks after the §, as printed. */
  questions: z.array(short(600)).max(30),
  /** Words to link Bilig topics with later (lemmas of the subject, in the book's language). */
  keywords: z.array(short(80)).max(30),
  /** A Bilig topic that teaches this § today, when the matcher finds one. */
  topicKey: KeySchema.nullable(),
  /** Staff checked this § (the AI made the rest). */
  reviewed: z.boolean(),
});
export type BookSection = z.infer<typeof BookSectionSchema>;

export const BookSchema = z.object({
  id: IdSchema,
  /** v0.9.4 */
  kind: BookKindSchema,
  title: short(300),
  subjectKey: KeySchema,
  grade: z.number().int().min(1).max(12),
  lang: LangSchema,
  /** Volume of a multi-part book. */
  part: z.number().int().min(1).max(9).nullable(),
  authors: z.array(short(200)).max(20),
  publisher: z.string().max(200),
  year: z.number().int().min(1950).max(2100).nullable(),
  /** 2–5 sentences about the book. */
  summary: z.string().max(3000),
  status: BookStatusSchema,
  /** Processing: the stage and its progress (pages read, § analysed). */
  stage: BookStageSchema,
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }),
  error: z.string().max(500).nullable(),
  pageCount: z.number().int().min(0).max(BOOK_MAX_PAGES),
  pagesUploaded: z.number().int().min(0),
  sectionCount: z.number().int().min(0),
  /** Model tokens and their cost so far. */
  usage: z.object({ inputTokens: z.number().int().min(0), cachedInputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), costUsd: z.number().min(0) }),
  fileName: z.string().max(200),
  /** The cover image (GET /books/:id/cover): page 1 of the PDF unless staff uploaded one; null before upload. */
  coverUrl: z.string().max(500).nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
  publishedAt: DateTimeSchema.nullable(),
});
export type Book = z.infer<typeof BookSchema>;

export const BookDetailSchema = z.object({ book: BookSchema, sections: z.array(BookSectionSchema) });
export type BookDetail = z.infer<typeof BookDetailSchema>;

// --- staff -----------------------------------------------------------------------------------

// POST /admin/books — a new book; then its pages, then «process».
export const AdminBookCreateSchema = z.object({
  fileName: short(200),
  subjectKey: KeySchema,
  grade: z.number().int().min(1).max(12),
  lang: LangSchema,
  pageCount: z.number().int().min(1).max(BOOK_MAX_PAGES),
  /** Optional, when staff know it; the AI reads it from the cover otherwise. */
  title: z.string().trim().max(300).optional(),
  part: z.number().int().min(1).max(9).optional(),
  /** v0.9.4 (default textbook) */
  kind: BookKindSchema.optional(),
});
export type AdminBookCreate = z.infer<typeof AdminBookCreateSchema>;

// POST /admin/books/:id/pages — up to BOOK_PAGES_PER_UPLOAD pages: an image (a data URL) or the page text.
export const AdminBookPagesSchema = z.object({
  pages: z
    .array(
      z
        .object({
          /** 1-based PDF page. */
          n: z.number().int().min(1).max(BOOK_MAX_PAGES),
          image: z.string().max(Math.ceil((BOOK_PAGE_IMAGE_BYTES * 4) / 3) + 64).optional(),
          text: z.string().max(40_000).optional(),
        })
        .refine((p) => !!p.image !== !!p.text, { message: 'image or text', path: ['image'] }),
    )
    .min(1)
    .max(BOOK_PAGES_PER_UPLOAD),
});
export type AdminBookPages = z.infer<typeof AdminBookPagesSchema>;

export const AdminBookListQuerySchema = z.object({
  grade: z.coerce.number().int().min(1).max(12).optional(),
  subjectKey: KeySchema.optional(),
  lang: LangSchema.optional(),
  status: BookStatusSchema.optional(),
  /** v0.9.4 */
  kind: BookKindSchema.optional(),
});
export const AdminBookListSchema = z.object({ items: z.array(BookSchema) });

// PATCH /admin/books/:id — fix what the AI got wrong (meta and §), before or after publishing.
export const AdminBookPatchSchema = z.object({
  kind: BookKindSchema.optional(),
  title: short(300).optional(),
  subjectKey: KeySchema.optional(),
  grade: z.number().int().min(1).max(12).optional(),
  lang: LangSchema.optional(),
  part: z.number().int().min(1).max(9).nullable().optional(),
  authors: z.array(short(200)).max(20).optional(),
  publisher: z.string().max(200).optional(),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  summary: z.string().max(3000).optional(),
  sections: z
    .array(
      BookSectionSchema.omit({ id: true, order: true })
        .partial()
        .extend({ id: IdSchema }),
    )
    .max(400)
    .optional(),
});
export type AdminBookPatch = z.infer<typeof AdminBookPatchSchema>;

// POST /admin/books/:id/cover — the book's cover (JPEG / PNG / WebP data URL), instead of PDF page 1.
export const AdminBookCoverSchema = z.object({ image: z.string().min(1).max(Math.ceil((BOOK_PAGE_IMAGE_BYTES * 4) / 3) + 64) });

// POST /admin/books/:id/process — start (or resume / redo) the reading; `from` restarts from a stage.
export const AdminBookProcessSchema = z.object({ from: BookStageSchema.exclude(['done']).optional() });

// --- teachers -------------------------------------------------------------------------------

// GET /books?grade&subjectKey&lang — published books (newest first).
export const BookListQuerySchema = AdminBookListQuerySchema.omit({ status: true });
export const BookListSchema = AdminBookListSchema;
