/**
 * v0.9.3: the book library routes. Staff (content.draft.edit): create a book,
 * upload its pages (images or text) in batches, start / resume the reading,
 * fix what the AI got wrong, set a cover; publishing and archiving need
 * content.publish. Teachers (lesson.plan): the published books, one book with
 * its §, the cover. The reading itself is the background worker
 * (services/books.ts).
 */
import type { FastifyInstance } from 'fastify';
import { BOOK_PAGE_IMAGE_BYTES, type AdminBookPatch, type BookStage } from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { fail } from '../http/errors.js';
import { route } from '../http/route.js';
import { newId } from '../ids.js';
import type { BookRec, BookSectionRec } from '../repo/types.js';
import { parseDataUrl } from '../services/tutor-provider.js';
import { toBookDto, toSectionDto } from '../services/books.js';

/** Body limit for a page batch: 6 images of ≤ 1.5 MB as base64. */
export const BOOK_PAGES_BODY_LIMIT = 6 * (Math.ceil((BOOK_PAGE_IMAGE_BYTES * 4) / 3) + 64) + 256 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function decodeImage(url: string): { body: Buffer; contentType: string; ext: string } {
  const d = parseDataUrl(url);
  if (!d || !EXT[d.mediaType]) fail('validation_failed', { detail: 'image must be a JPEG, PNG or WebP data URL' });
  const body = Buffer.from(d.data, 'base64');
  if (!body.length || body.length > BOOK_PAGE_IMAGE_BYTES) fail('payload_too_large', { detail: `image > ${BOOK_PAGE_IMAGE_BYTES} bytes` });
  return { body, contentType: d.mediaType, ext: EXT[d.mediaType] };
}

export function registerBooks(app: FastifyInstance, deps: Deps) {
  const { repo, clock, storage, audit } = deps;

  async function load(id: string): Promise<BookRec> {
    const b = /^[0-9a-f-]{36}$/i.test(id) ? await repo.getBook(id) : null;
    if (!b) fail('not_found', { detail: 'book' });
    return b;
  }
  async function dto(b: BookRec) {
    const [pages, sections] = await Promise.all([repo.listBookPages(b.id), repo.listBookSections(b.id)]);
    return toBookDto(b, { pagesUploaded: pages.length, sectionCount: sections.length });
  }
  async function detail(b: BookRec) {
    const [pages, sections] = await Promise.all([repo.listBookPages(b.id), repo.listBookSections(b.id)]);
    return { book: toBookDto(b, { pagesUploaded: pages.length, sectionCount: sections.length }), sections: sections.map(toSectionDto) };
  }
  const touch = (id: string, patch: Partial<BookRec>) => repo.updateBook(id, { ...patch, updatedAt: clock.now() });

  // --- staff ------------------------------------------------------------------------------

  route(app, deps, 'adminBookList', async ({ query }) => {
    const books = await repo.listBooks({ grade: query.grade, subjectKey: query.subjectKey, lang: query.lang, ...(query.status ? { statuses: [query.status] } : {}) });
    return { items: await Promise.all(books.map(dto)) };
  });

  route(app, deps, 'adminBookCreate', async ({ auth, body, ip }) => {
    const src = await deps.content.ktpSources();
    if (!src.subjectKeys.has(body.subjectKey)) fail('validation_failed', { detail: 'subjectKey' });
    const now = clock.now();
    const b: BookRec = {
      id: newId(),
      title: body.title?.trim() || body.fileName.replace(/\.[^.]{1,5}$/, '').slice(0, 300),
      subjectKey: body.subjectKey,
      grade: body.grade,
      lang: body.lang,
      part: body.part ?? null,
      authors: [],
      publisher: '',
      year: null,
      summary: '',
      status: 'uploading',
      stage: 'pages',
      progressDone: 0,
      progressTotal: body.pageCount,
      error: null,
      pageCount: body.pageCount,
      fileName: body.fileName,
      coverKey: null,
      // A title staff typed is kept; the AI only fills an empty one.
      contents: body.title?.trim() ? { keepTitle: true } : null,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
      leaseUntil: null,
      createdBy: auth.user!.id,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };
    await repo.createBook(b);
    await audit.log(auth.user!.id, 'book.created', { type: 'book', id: b.id, label: b.title }, { ip, diff: { grade: b.grade, subjectKey: b.subjectKey, lang: b.lang, pages: b.pageCount } });
    return dto(b);
  });

  route(app, deps, 'adminBookGet', async ({ params }) => detail(await load(params.id)));

  route(
    app,
    deps,
    'adminBookPages',
    async ({ params, body }) => {
      const b = await load(params.id);
      if (b.status !== 'uploading' && b.status !== 'failed') fail('conflict', { detail: `book is ${b.status}` });
      const rows = [];
      let cover: string | null = null;
      for (const p of body.pages) {
        if (p.n > b.pageCount) fail('validation_failed', { detail: `page ${p.n} > ${b.pageCount}` });
        if (p.image) {
          const img = decodeImage(p.image);
          const key = `books/${b.id}/p${String(p.n).padStart(4, '0')}.${img.ext}`;
          await storage.put(key, img.body, img.contentType);
          rows.push({ bookId: b.id, n: p.n, imageKey: key, text: null, read: null });
          if (p.n === 1) cover = key;
        } else rows.push({ bookId: b.id, n: p.n, imageKey: null, text: p.text ?? '', read: null });
      }
      await repo.putBookPages(rows);
      // PDF page 1 is the cover until staff upload one.
      const next = cover && !b.coverKey ? await touch(b.id, { coverKey: cover }) : await touch(b.id, {});
      return dto(next ?? b);
    },
    { bodyLimit: BOOK_PAGES_BODY_LIMIT },
  );

  route(app, deps, 'adminBookProcess', async ({ auth, params, body, ip }) => {
    const b = await load(params.id);
    if (b.status === 'archived') fail('conflict', { detail: 'book is archived' });
    if (b.status === 'queued' || b.status === 'processing') fail('conflict', { detail: `book is ${b.status}` });
    const pages = await repo.listBookPages(b.id);
    if (!pages.length) fail('validation_failed', { detail: 'no pages uploaded' });
    if (pages.length < b.pageCount) fail('conflict', { detail: `pages missing: ${pages.length} of ${b.pageCount} uploaded` });
    const from: BookStage = body.from ?? (b.status === 'uploading' ? 'pages' : b.stage === 'done' ? 'pages' : b.stage);
    // Redo from a stage: forget what that stage and the later ones made.
    if (from === 'pages') for (const p of pages) await repo.setBookPageRead(b.id, p.n, null);
    if (from === 'pages' || from === 'contents') await repo.replaceBookSections(b.id, []);
    if (from === 'sections') for (const s of await repo.listBookSections(b.id)) await repo.updateBookSection(b.id, s.id, { info: null });
    const next = await touch(b.id, { status: 'queued', stage: from, error: null, leaseUntil: null, progressDone: 0, progressTotal: from === 'pages' ? pages.length : 0, ...(b.status === 'published' ? { publishedAt: null } : {}) });
    await audit.log(auth.user!.id, 'book.processing', { type: 'book', id: b.id, label: b.title }, { ip, diff: { from } });
    return dto(next!);
  });

  route(app, deps, 'adminBookPatch', async ({ auth, params, body, ip }) => {
    const b = await load(params.id);
    const p = body as AdminBookPatch;
    if (p.subjectKey && !(await deps.content.ktpSources()).subjectKeys.has(p.subjectKey)) fail('validation_failed', { detail: 'subjectKey' });
    const { sections, ...meta } = p;
    const next = Object.keys(meta).length ? await touch(b.id, { ...meta, ...(meta.title ? { contents: { ...((b.contents as object) ?? {}), keepTitle: true } } : {}) }) : b;
    if (sections?.length) {
      const have = new Map((await repo.listBookSections(b.id)).map((s) => [s.id, s]));
      for (const s of sections) {
        const cur = have.get(s.id);
        if (!cur) fail('validation_failed', { detail: `section ${s.id}` });
        const { id, pages, title, number, kind, chapterNumber, chapterTitle, topicKey, reviewed, ...info } = s;
        const rec: Partial<BookSectionRec> = {
          ...(title !== undefined ? { title } : {}),
          ...(number !== undefined ? { number } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(chapterNumber !== undefined ? { chapterNumber } : {}),
          ...(chapterTitle !== undefined ? { chapterTitle } : {}),
          ...(topicKey !== undefined ? { topicKey } : {}),
          ...(reviewed !== undefined ? { reviewed } : {}),
          ...(pages !== undefined ? { pageFrom: pages.from, pageTo: pages.to } : {}),
          ...(Object.keys(info).length ? { info: { ...(cur.info ?? {}), ...info } } : {}),
        };
        await repo.updateBookSection(b.id, id, rec);
      }
    }
    await audit.log(auth.user!.id, 'book.updated', { type: 'book', id: b.id, label: next!.title }, { ip, diff: { fields: Object.keys(meta), sections: sections?.length ?? 0 } });
    return detail((await repo.getBook(b.id))!);
  });

  route(app, deps, 'adminBookCover', async ({ params, body }) => {
    const b = await load(params.id);
    const img = decodeImage(body.image);
    const key = `books/${b.id}/cover-${Date.now().toString(36)}.${img.ext}`;
    await storage.put(key, img.body, img.contentType);
    return dto((await touch(b.id, { coverKey: key }))!);
  });

  route(app, deps, 'adminBookPublish', async ({ auth, params, ip }) => {
    const b = await load(params.id);
    if (b.status !== 'review' && b.status !== 'published') fail('conflict', { detail: `book is ${b.status}` });
    const next = await touch(b.id, { status: 'published', publishedAt: b.publishedAt ?? clock.now() });
    await audit.log(auth.user!.id, 'book.published', { type: 'book', id: b.id, label: b.title }, { ip });
    return dto(next!);
  });

  route(app, deps, 'adminBookArchive', async ({ auth, params, ip }) => {
    const b = await load(params.id);
    const next = await touch(b.id, { status: 'archived', leaseUntil: null });
    await audit.log(auth.user!.id, 'book.archived', { type: 'book', id: b.id, label: b.title }, { ip });
    return dto(next!);
  });

  // --- teachers ----------------------------------------------------------------------------

  async function published(id: string): Promise<BookRec> {
    const b = await load(id);
    if (b.status !== 'published') fail('not_found', { detail: 'book' });
    return b;
  }

  route(app, deps, 'bookList', async ({ query }) => {
    const books = await repo.listBooks({ grade: query.grade, subjectKey: query.subjectKey, lang: query.lang, statuses: ['published'] });
    return { items: await Promise.all(books.map(dto)) };
  });

  route(app, deps, 'bookGet', async ({ params }) => detail(await published(params.id)));

  route(app, deps, 'bookCover', async ({ auth, params }) => {
    const b = await load(params.id);
    // Staff see the cover of a book in work; teachers only of a published one.
    const staff = auth.grants.some((g) => g.role === 'superadmin' || g.role === 'manager' || g.role === 'editor' || g.role === 'author');
    if (b.status !== 'published' && !staff) fail('not_found', { detail: 'book' });
    const o = b.coverKey ? await storage.get(b.coverKey) : null;
    if (!o) fail('not_found', { detail: 'cover' });
    return { body: o.body, contentType: o.contentType, filename: `cover.${EXT[o.contentType] ?? 'jpg'}` };
  });
}
