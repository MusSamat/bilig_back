/**
 * v0.9.3: the book worker — reads an uploaded book with the AI in the
 * background (stages pages → contents → sections → book → done, see
 * domain/book-read.ts). Resumable and safe with several API instances:
 *
 *  - a book is leased (`claimBook`) for LEASE_MS; one tick works for at most
 *    TICK_BUDGET_MS, saves what it did (each page's read, each §'s analysis,
 *    the progress) and releases the book; the next tick goes on from there;
 *  - a page batch that fails is retried on the next ticks; after MAX_TRIES it
 *    is kept as unread (the § analysis still runs on what was read);
 *  - the provider down / out of balance / the daily budget → the book waits
 *    (lease for PAUSE_MS) with the reason in `error`, nothing is lost.
 *
 * Costs are counted per book (usage, costUsd) and per day (BOOK_BUDGET_KEY).
 */
import type { FastifyBaseLogger } from 'fastify';
import { t, type Lang } from '@bilig/content-model';
import type { Book, BookSection } from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { usageCostUsd } from '../config.js';
import { newId } from '../ids.js';
import type { BookPageRec, BookRec, BookSectionRec } from '../repo/types.js';
import { BOOK_SCHEMA, EMPTY_SECTION_INFO, PAGES_SCHEMA, SECTION_SCHEMA, bookPrompt, pagesPrompt, readBookMeta, readPages, readSection, sectionPrompt, type PageRead } from '../domain/book-read.js';
import { CONTENTS_SCHEMA, contentsPrompt, finishDraft, fromModel, looksParsed, parseContentsText } from '../ktp/contents.js';
import { buildTopicIndex, matchTitle } from '../ktp/match.js';
import { ProviderUnavailable, type ProviderUsage } from './tutor-provider.js';

const LEASE_MS = 10 * 60_000;
const TICK_BUDGET_MS = 4 * 60_000;
const PAUSE_MS = 15 * 60_000;
const IMAGES_PER_CALL = 3;
const TEXT_PAGES_PER_CALL = 6;
const MAX_TRIES = 3;
const PARALLEL = 3;
export const BOOK_BUDGET_KEY = (d: Date) => `books:tokens:${d.toISOString().slice(0, 10)}`;

type Read = PageRead & { tries?: number; failed?: boolean };
const readOf = (p: BookPageRec): Read | null => (p.read && typeof p.read === 'object' ? (p.read as Read) : null);
const isRead = (p: BookPageRec) => {
  const r = readOf(p);
  return !!r && !r.failed && typeof r.text === 'string';
};
const isDone = (p: BookPageRec) => isRead(p) || !!readOf(p)?.failed;

export const coverPath = (id: string) => `/api/v1/books/${id}/cover`;

export function toBookDto(b: BookRec, extra: { pagesUploaded: number; sectionCount: number }): Book {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: b.id,
    title: b.title,
    subjectKey: b.subjectKey,
    grade: b.grade,
    lang: b.lang,
    part: b.part,
    authors: b.authors,
    publisher: b.publisher,
    year: b.year,
    summary: b.summary,
    status: b.status,
    stage: b.stage,
    progress: { done: b.progressDone, total: b.progressTotal },
    error: b.error,
    pageCount: b.pageCount,
    pagesUploaded: extra.pagesUploaded,
    sectionCount: extra.sectionCount,
    usage: b.usage,
    fileName: b.fileName,
    coverUrl: b.coverKey ? coverPath(b.id) : null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    publishedAt: iso(b.publishedAt),
  };
}

export function toSectionDto(s: BookSectionRec): BookSection {
  const info = { ...EMPTY_SECTION_INFO, ...(s.info ?? {}) } as typeof EMPTY_SECTION_INFO;
  return {
    id: s.id,
    order: s.order,
    chapterNumber: s.chapterNumber,
    chapterTitle: s.chapterTitle,
    number: s.number,
    kind: s.kind,
    title: s.title,
    ...(s.pageFrom !== null && s.pageTo !== null ? { pages: { from: s.pageFrom, to: Math.max(s.pageFrom, s.pageTo) } } : {}),
    summary: info.summary,
    objectives: info.objectives,
    keyTerms: info.keyTerms,
    formulas: info.formulas,
    quantities: info.quantities,
    facts: info.facts,
    experiments: info.experiments,
    questions: info.questions,
    keywords: info.keywords,
    topicKey: s.topicKey,
    reviewed: s.reviewed,
  };
}

/** Printed book page → PDF page, from what was read on every page (spreads carry two numbers). */
export function printedMap(pages: readonly BookPageRec[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of pages) for (const n of readOf(p)?.printed ?? []) if (!m.has(n)) m.set(n, p.n);
  return m;
}

/** PDF pages holding printed pages from..to (nearest known numbers when some were not printed). */
export function pdfPagesFor(map: Map<number, number>, from: number, to: number): number[] {
  const known = [...map.entries()].sort((a, b) => a[0] - b[0]);
  if (!known.length) return [];
  const at = (n: number) => {
    if (map.has(n)) return map.get(n)!;
    // Linear between the nearest printed numbers (a page with no number on it).
    const lo = [...known].reverse().find(([k]) => k < n);
    const hi = known.find(([k]) => k > n);
    if (lo && hi) return Math.round(lo[1] + ((n - lo[0]) * (hi[1] - lo[1])) / (hi[0] - lo[0]));
    return (lo ?? hi)![1];
  };
  const a = at(from);
  const b = at(to);
  return Array.from({ length: Math.max(0, b - a) + 1 }, (_, i) => a + i);
}

interface Tick {
  deps: Deps;
  log: FastifyBaseLogger;
  book: BookRec;
  started: number;
  usage: BookRec['usage'];
}

class Paused extends Error {}

async function call(tk: Tick, req: Parameters<NonNullable<Deps['tutor']>['generate']>[0]) {
  const { deps } = tk;
  const provider = deps.tutor;
  if (!provider || provider.name === 'dev') throw new Paused('assistant_offline');
  const day = BOOK_BUDGET_KEY(deps.clock.now());
  if ((await deps.limiter.get(day)) >= deps.config.bookDailyTokenBudget) throw new Paused('budget_exhausted');
  try {
    const res = await provider.generate(req);
    add(tk, res.usage);
    await deps.limiter.add(day, res.usage.inputTokens + res.usage.outputTokens, 2 * 86400);
    return res.data;
  } catch (err) {
    if (err instanceof ProviderUnavailable) {
      // Balance, auth, rate limit, outage: wait; a timeout of one call: let the caller retry.
      if (['insufficient_balance', 'auth', 'rate_limited'].includes(err.message) || err.message.startsWith('api_5')) throw new Paused(err.message);
    }
    throw err;
  }
}

function add(tk: Tick, u: ProviderUsage) {
  tk.usage.inputTokens += u.inputTokens;
  tk.usage.cachedInputTokens += u.cachedInputTokens ?? 0;
  tk.usage.outputTokens += u.outputTokens;
  tk.usage.costUsd = Number((tk.usage.costUsd + usageCostUsd(u, tk.deps.config.tutorPrices)).toFixed(6));
}

const timeLeft = (tk: Tick) => tk.deps.clock.now().getTime() - tk.started < TICK_BUDGET_MS;

/** Run `jobs` PARALLEL at a time while the tick has time; returns how many ran. */
async function pool<T>(tk: Tick, items: T[], job: (x: T) => Promise<void>): Promise<number> {
  let next = 0;
  let ran = 0;
  const lane = async () => {
    while (next < items.length && timeLeft(tk)) {
      const x = items[next++];
      await job(x);
      ran++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, lane));
  return ran;
}

// ---------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------

async function stagePages(tk: Tick): Promise<boolean> {
  const { deps, book } = tk;
  const pages = await deps.repo.listBookPages(book.id);
  const todo = pages.filter((p) => !isDone(p));
  if (!todo.length) return true;
  // Images go 3 to a call (each ≤ 1 024 tokens in, ~2 500 out); text pages 6 to a call.
  const batches: BookPageRec[][] = [];
  const images = todo.filter((p) => p.imageKey);
  const texts = todo.filter((p) => !p.imageKey && p.text !== null);
  for (let i = 0; i < images.length; i += IMAGES_PER_CALL) batches.push(images.slice(i, i + IMAGES_PER_CALL));
  for (let i = 0; i < texts.length; i += TEXT_PAGES_PER_CALL) batches.push(texts.slice(i, i + TEXT_PAGES_PER_CALL));
  await pool(tk, batches, async (batch) => {
    const withImages = !!batch[0].imageKey;
    let data: unknown;
    try {
      const images = withImages
        ? await Promise.all(
            batch.map(async (p) => {
              const o = await deps.storage.get(p.imageKey!);
              if (!o) throw new Error(`page ${p.n}: image missing`);
              return `data:${o.contentType};base64,${o.body.toString('base64')}`;
            }),
          )
        : [];
      data = await call(tk, {
        model: deps.config.bookModel,
        system: 'You transcribe pages of school textbooks exactly, for teachers.',
        prompt: withImages ? pagesPrompt(batch.length, book.lang, true) : `${pagesPrompt(batch.length, book.lang, false)}\n${batch.map((p, i) => `<page i="${i}">\n${(p.text ?? '').slice(0, 12_000)}\n</page>`).join('\n')}`,
        schema: PAGES_SCHEMA,
        maxTokens: 3500 * batch.length,
        effort: deps.config.bookOcrEffort,
        timeoutMs: 240_000,
        ...(withImages ? { images } : {}),
      });
    } catch (err) {
      if (err instanceof Paused) throw err;
      tk.log.warn({ err, book: book.id, pages: batch.map((p) => p.n) }, 'book: page batch failed');
      for (const p of batch) {
        const tries = (readOf(p)?.tries ?? 0) + 1;
        await deps.repo.setBookPageRead(book.id, p.n, { tries, ...(tries >= MAX_TRIES ? { failed: true } : {}) });
      }
      return;
    }
    const reads = readPages(data, batch.length);
    for (const [i, p] of batch.entries()) {
      const r = reads[i];
      // A text page keeps its own text when the model returned none for it.
      if (r) await deps.repo.setBookPageRead(book.id, p.n, { ...r, text: r.text || p.text || '' });
      else {
        const tries = (readOf(p)?.tries ?? 0) + 1;
        await deps.repo.setBookPageRead(book.id, p.n, { tries, ...(tries >= MAX_TRIES ? { failed: true } : {}) });
      }
    }
  });
  const after = await deps.repo.listBookPages(book.id);
  const done = after.filter(isDone).length;
  await deps.repo.updateBook(book.id, { progressDone: done, progressTotal: after.length });
  return done === after.length;
}

async function stageContents(tk: Tick): Promise<void> {
  const { deps, book } = tk;
  const pages = await deps.repo.listBookPages(book.id);
  const reads = pages.map((p) => ({ p, r: readOf(p) })).filter((x) => x.r && !x.r.failed);
  const tocText = reads
    .filter((x) => x.r!.kind === 'toc' || /(^|\n)\s*(мазмуну|содержание|оглавление|contents)\s*(\n|$)/i.test(x.r!.text))
    .map((x) => x.r!.text)
    .join('\n');
  let chapters = tocText ? parseContentsText(tocText) : [];
  if (!looksParsed(chapters) && tocText) {
    const m = fromModel(
      await call(tk, {
        model: deps.config.bookModel,
        system: 'You read school textbooks for teachers in Kyrgyzstan and copy their table of contents exactly.',
        prompt: `${contentsPrompt(0, book.lang).replace(/^These are 0 page images[^\n]*\n/, 'Here is the text of the contents pages of a school textbook.\n')}\n<pages>\n${tocText.slice(0, 60_000)}\n</pages>`,
        schema: CONTENTS_SCHEMA,
        maxTokens: 8000,
        effort: deps.config.bookAnalysisEffort,
        timeoutMs: 240_000,
      }),
    );
    if (m.chapters.length) chapters = m.chapters;
  }
  if (!looksParsed(chapters)) {
    // No usable contents page: the § headings found on the pages, with the page they start on.
    const byPrinted = reads.flatMap((x) => x.r!.headings.filter((h) => /^\d{1,3}(\.\d{1,2})?$/.test(h.number)).map((h) => ({ number: h.number, title: h.text, page: x.r!.printed[0] })));
    if (byPrinted.length) chapters = [{ number: '', title: book.title, lessons: byPrinted.map((h) => ({ number: h.number, kind: 'lesson' as const, title: h.title, ...(h.page ? { page: h.page } : {}) })) }];
  }
  const { draft } = finishDraft(chapters, { title: book.title, grade: book.grade, lang: book.lang, subjectKey: book.subjectKey });
  const src = await deps.content.ktpSources();
  const index = buildTopicIndex(src.packages, src.textbooks);
  let order = 0;
  const rows: BookSectionRec[] = draft.chapters.flatMap((c) =>
    c.lessons.map((l) => ({
      id: newId(),
      bookId: book.id,
      order: order++,
      chapterNumber: c.number,
      chapterTitle: c.title,
      number: l.number,
      kind: l.kind,
      title: l.title,
      pageFrom: l.pages?.from ?? null,
      pageTo: l.pages?.to ?? null,
      info: null,
      topicKey: l.kind === 'lesson' ? (matchTitle(index, l.title, { subjectKey: book.subjectKey, grade: book.grade })?.topicKey ?? null) : null,
      reviewed: false,
    })),
  );
  await deps.repo.replaceBookSections(book.id, rows);
  await deps.repo.updateBook(book.id, { contents: draft, progressDone: 0, progressTotal: rows.length });
}

async function stageSections(tk: Tick): Promise<boolean> {
  const { deps, book } = tk;
  const sections = await deps.repo.listBookSections(book.id);
  const pages = await deps.repo.listBookPages(book.id);
  const map = printedMap(pages);
  const byN = new Map(pages.map((p) => [p.n, readOf(p)]));
  const src = await deps.content.ktpSources();
  const subject = src.packages.find((p) => p.subject.key === book.subjectKey)?.subject;
  const subjectName = subject ? t(subject.title, book.lang) : book.subjectKey;
  const todo = sections.filter((s) => s.info === null);
  await pool(tk, todo, async (s) => {
    const pdf = s.pageFrom !== null ? pdfPagesFor(map, s.pageFrom, s.pageTo ?? s.pageFrom) : [];
    const text = pdf
      .map((n) => byN.get(n)?.text ?? '')
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 24_000);
    let info = EMPTY_SECTION_INFO;
    if (text.trim()) {
      try {
        info = readSection(
          await call(tk, {
            model: deps.config.bookModel,
            system: 'You describe school textbook sections for teachers, using only the given text.',
            prompt: sectionPrompt({ lang: book.lang, subject: subjectName, grade: book.grade, bookTitle: book.title, chapter: s.chapterTitle, number: s.number, title: s.title, text }),
            schema: SECTION_SCHEMA,
            maxTokens: 4000,
            effort: deps.config.bookAnalysisEffort,
            timeoutMs: 240_000,
          }),
        );
      } catch (err) {
        if (err instanceof Paused) throw err;
        tk.log.warn({ err, book: book.id, section: s.id }, 'book: section analysis failed');
        return; // retried on the next tick
      }
    }
    await deps.repo.updateBookSection(book.id, s.id, { info });
  });
  const after = await deps.repo.listBookSections(book.id);
  const done = after.filter((s) => s.info !== null).length;
  await deps.repo.updateBook(book.id, { progressDone: done, progressTotal: after.length });
  return done === after.length;
}

async function stageBook(tk: Tick, keepTitle: boolean): Promise<void> {
  const { deps, book } = tk;
  const pages = await deps.repo.listBookPages(book.id);
  const front = pages
    .slice(0, 4)
    .map((p) => readOf(p)?.text ?? '')
    .join('\n\n')
    .slice(0, 8000);
  const sections = await deps.repo.listBookSections(book.id);
  const contents = sections.map((s) => `${s.chapterNumber}. ${s.chapterTitle} | ${s.number} ${s.title}`).join('\n').slice(0, 12_000);
  const m = readBookMeta(
    await call(tk, {
      model: deps.config.bookModel,
      system: 'You describe school textbooks for teachers.',
      prompt: bookPrompt({ lang: book.lang, subject: book.subjectKey, grade: book.grade, front, contents }),
      schema: BOOK_SCHEMA,
      maxTokens: 1500,
      effort: 'low',
      timeoutMs: 120_000,
    }),
  );
  await deps.repo.updateBook(book.id, {
    ...(!keepTitle && m.title ? { title: m.title } : {}),
    ...(m.authors.length && !book.authors.length ? { authors: m.authors } : {}),
    ...(m.publisher && !book.publisher ? { publisher: m.publisher } : {}),
    ...(m.year && !book.year ? { year: m.year } : {}),
    ...(m.part && !book.part ? { part: m.part } : {}),
    ...(m.summary ? { summary: m.summary } : {}),
  });
}

/** One tick: take a book, advance it as far as the tick allows, save, release. Returns the book id worked on. */
export async function runBookWorker(deps: Deps, log: FastifyBaseLogger): Promise<string | null> {
  const now = deps.clock.now();
  const book = await deps.repo.claimBook(now, new Date(now.getTime() + LEASE_MS));
  if (!book) return null;
  const tk: Tick = { deps, log, book, started: now.getTime(), usage: { ...book.usage } };
  let lease: Date | null = null;
  let patch: Partial<BookRec> = {};
  try {
    if (book.status === 'queued') await deps.repo.updateBook(book.id, { status: 'processing', error: null });
    let stage = book.stage;
    if (stage === 'pages' && (await stagePages(tk))) stage = 'contents';
    if (stage === 'contents' && timeLeft(tk)) {
      await stageContents(tk);
      stage = 'sections';
    }
    if (stage === 'sections' && timeLeft(tk) && (await stageSections(tk))) stage = 'book';
    if (stage === 'book' && timeLeft(tk)) {
      await stageBook(tk, !!(book.contents as { keepTitle?: boolean } | null)?.keepTitle);
      stage = 'done';
    }
    patch = stage === 'done' ? { stage, status: 'review', error: null } : { stage, error: null };
  } catch (err) {
    if (err instanceof Paused) {
      lease = new Date(deps.clock.now().getTime() + PAUSE_MS);
      patch = { error: err.message };
      log.warn({ book: book.id, reason: err.message }, 'book: paused');
    } else {
      log.error({ err, book: book.id }, 'book: tick failed');
      patch = { error: String((err as Error)?.message ?? err).slice(0, 500) };
    }
  }
  await deps.repo.updateBook(book.id, { ...patch, usage: tk.usage, leaseUntil: lease, updatedAt: deps.clock.now() });
  return book.id;
}

/** The book of a class as a textbook for the КТП generator (chapters → lessons with pages and topics). */
export function bookAsTextbook(b: BookRec, sections: BookSectionRec[]) {
  const L = (s: string) => ({ ky: s, ru: s, en: s }) as Record<Lang, string>;
  const chapters: { key: string; number: string; title: Record<Lang, string>; subjectKey: string; lessons: { key: string; number: string; kind: BookSectionRec['kind']; title: Record<Lang, string>; pages?: { from: number; to: number }; topicKeys: string[] }[] }[] = [];
  for (const s of sections) {
    let c = chapters.at(-1);
    if (!c || c.number !== s.chapterNumber || t(c.title, 'ky') !== s.chapterTitle) {
      c = { key: `c${chapters.length}`, number: s.chapterNumber, title: L(s.chapterTitle), subjectKey: b.subjectKey, lessons: [] };
      chapters.push(c);
    }
    c.lessons.push({ key: s.id, number: s.number, kind: s.kind, title: L(s.title), ...(s.pageFrom !== null ? { pages: { from: s.pageFrom, to: Math.max(s.pageFrom, s.pageTo ?? s.pageFrom) } } : {}), topicKeys: s.topicKey ? [s.topicKey] : [] });
  }
  return { grade: b.grade, chapters };
}
