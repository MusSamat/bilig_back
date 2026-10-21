/**
 * v0.9.3: books shipped with the content (content/books/<key>/book.json + cover.jpg), imported into the
 * library on start as published books — a book read before the admin upload existed (Физика 7). A book
 * already in the database is never overwritten: staff edits win.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BookSectionSchema } from '@bilig/content-model/api';
import { LangSchema } from '@bilig/content-model';
import type { Deps } from '../deps.js';
import { newId } from '../ids.js';
import type { BookSectionRec } from '../repo/types.js';

const SeedSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(300),
  subjectKey: z.string().min(1),
  grade: z.number().int().min(1).max(12),
  lang: LangSchema,
  part: z.number().int().nullable().default(null),
  authors: z.array(z.string()).default([]),
  publisher: z.string().default(''),
  year: z.number().int().nullable().default(null),
  summary: z.string().default(''),
  fileName: z.string().default(''),
  pageCount: z.number().int().min(0).default(0),
  sections: z.array(BookSectionSchema.omit({ id: true, order: true, reviewed: true }).extend({ reviewed: z.boolean().default(false) })),
});
export type BookSeed = z.infer<typeof SeedSchema> & { cover: Buffer | null; coverType: string };

export function loadBookSeeds(contentDir: string): BookSeed[] {
  const dir = join(contentDir, 'books');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'book.json')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const seed = SeedSchema.parse(JSON.parse(readFileSync(join(dir, d.name, 'book.json'), 'utf8')));
      const jpg = join(dir, d.name, 'cover.jpg');
      return { ...seed, cover: existsSync(jpg) ? readFileSync(jpg) : null, coverType: 'image/jpeg' };
    });
}

export async function importBooks(deps: Pick<Deps, 'repo' | 'clock' | 'storage'>, seeds: BookSeed[], authorId = '00000000-0000-4000-8000-000000000000'): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const s of seeds) {
    if (await deps.repo.getBook(s.id)) continue;
    const now = deps.clock.now();
    let coverKey: string | null = null;
    if (s.cover) {
      coverKey = `books/${s.id}/cover.jpg`;
      await deps.storage.put(coverKey, s.cover, s.coverType);
    }
    await deps.repo.createBook({
      id: s.id,
      title: s.title,
      subjectKey: s.subjectKey,
      grade: s.grade,
      lang: s.lang,
      part: s.part,
      authors: s.authors,
      publisher: s.publisher,
      year: s.year,
      summary: s.summary,
      status: 'published',
      stage: 'done',
      progressDone: s.sections.length,
      progressTotal: s.sections.length,
      error: null,
      pageCount: s.pageCount,
      fileName: s.fileName,
      coverKey,
      contents: { keepTitle: true, seed: true },
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
      leaseUntil: null,
      createdBy: authorId,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    });
    const rows: BookSectionRec[] = s.sections.map((x, order) => {
      const { chapterNumber, chapterTitle, number, kind, title, pages, topicKey, reviewed, ...info } = x;
      return { id: newId(), bookId: s.id, order, chapterNumber, chapterTitle, number, kind, title, pageFrom: pages?.from ?? null, pageTo: pages?.to ?? null, info, topicKey, reviewed };
    });
    await deps.repo.replaceBookSections(s.id, rows);
    created.push(s.id);
  }
  return { created };
}
