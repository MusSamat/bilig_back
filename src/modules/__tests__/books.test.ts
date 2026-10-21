/** v0.9.3: the book library — staff upload, the worker reads the book with the AI, staff publish; teachers choose it. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importContent, loadContentDir } from '../../services/seed.js';
import { MockProvider, type GenerateRequest } from '../../services/tutor-provider.js';
import { runBookWorker } from '../../services/books.js';
import { BOOK_SCHEMA, PAGES_SCHEMA, SECTION_SCHEMA } from '../../domain/book-read.js';
import { API, json, licenseSchool, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TOC = ['МАЗМУНУ', 'I ГЛАВА. МЕХАНИКА', '§ 1. Механикалык кыймыл ......... 3', '§ 2. Жол жана которулуш ......... 4', '§ 3. Ылдамдык ......... 5', 'II ГЛАВА. ДИНАМИКА', '§ 4. Күч ......... 6', '§ 5. Масса ......... 7', '«Динамика» темасы боюнча тесттик тапшырмалар ......... 8'].join('\n');
const PAGE_TEXT: Record<number, string> = { 3: '§ 1. Механикалык кыймыл\nНерсенин абалынын өзгөрүшү…', 4: '§ 2. Жол\nЖол – траекториянын узундугу.', 5: '§ 3. Ылдамдык\nv = s/t', 6: '§ 4. Күч', 7: '§ 5. Масса', 8: 'Тест 1. …' };

let t: TestCtx;
let w: AdminWorld;
let fail = false;
const provider = new MockProvider(undefined, (req: GenerateRequest) => {
  if (fail) return new Error('insufficient_balance');
  if (req.schema === PAGES_SCHEMA) {
    // The cover image (page 1) and the text pages: printed numbers = PDF page + 1 (page 2 is the contents).
    const n = req.images ? 1 : 0;
    const count = req.images ? req.images.length : (req.prompt.match(/<page i=/g) ?? []).length;
    return {
      pages: Array.from({ length: count }, (_, i) => {
        const text = req.images ? 'ФИЗИКА 7 Э. М. Мамбетакунов' : (req.prompt.split(`<page i="${i}">\n`)[1] ?? '').split('\n</page>')[0];
        const printed = /МАЗМУНУ/.test(text) ? [2] : Number(/§ (\d)/.exec(text)?.[1] ?? '0') + 2 || (text.startsWith('Тест') ? 8 : 0);
        return { index: i, printed: Array.isArray(printed) ? printed : printed ? [printed] : [], kind: n ? 'cover' : /МАЗМУНУ/.test(text) ? 'toc' : 'content', headings: [], text, terms: [], formulas: [] };
      }),
    };
  }
  if (req.schema === SECTION_SCHEMA) return { summary: `Бул § ${/§ (\d+)/.exec(req.prompt)?.[1] ?? ''} жөнүндө.`, objectives: ['Түшүндүрүү'], keyTerms: [{ term: 'ылдамдык', definition: 'убакыт бирдигиндеги жол' }], formulas: [{ formula: 'v = s/t', meaning: 'ылдамдык' }], quantities: [], facts: [], experiments: [], questions: ['1. Ылдамдык деген эмне?'], keywords: ['ылдамдык', 'жол'] };
  if (req.schema === BOOK_SCHEMA) return { title: 'Физика 7', authors: ['Э. М. Мамбетакунов'], publisher: 'Билим', year: 2018, part: 0, summary: 'Механика.' };
  return {};
});

beforeAll(async () => {
  t = await makeTestApp({ seed: false, tutor: provider });
  await importContent(t.repo, t.clock, loadContentDir(), t.deps.config);
  w = await makeAdminWorld(t);
}, 60_000);
afterAll(() => t.close());

const admin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.inject({ method, url: `${API}${url}`, token: w.superadmin.adminToken, ...(payload !== undefined ? { payload: payload as object } : {}) });
const work = async () => {
  for (let i = 0; i < 10; i++) if (!(await runBookWorker(t.deps, t.app.log))) break;
};

describe('the book library', () => {
  let id = '';
  it('staff create a book, upload pages (a cover image + text pages); page 1 becomes the cover', async () => {
    const res = await admin('POST', '/admin/books', { fileName: 'Физика-7.pdf', subjectKey: 'phys', grade: 7, lang: 'ky', pageCount: 8 });
    expect(res.statusCode, res.body).toBe(200);
    id = json(res).id;
    expect(json(res)).toMatchObject({ status: 'uploading', stage: 'pages', coverUrl: null, title: 'Физика-7' });
    await admin('POST', `/admin/books/${id}/pages`, { pages: [{ n: 1, image: PNG }, { n: 2, text: TOC }] });
    const up = json(await admin('POST', `/admin/books/${id}/pages`, { pages: [3, 4, 5, 6, 7, 8].map((n) => ({ n, text: PAGE_TEXT[n] })) }));
    expect(up).toMatchObject({ pagesUploaded: 8 });
    expect(up.coverUrl).toMatch(new RegExp(`^/api/v1/books/${id}/cover\\?v=[0-9a-f]{10}$`));
    expect((await admin('POST', `/admin/books/${id}/pages`, { pages: [{ n: 9, text: 'x' }] })).statusCode).toBe(400);
    expect((await admin('POST', `/admin/books/${id}/pages`, { pages: [{ n: 3, image: 'data:image/gif;base64,AAAA' }] })).statusCode).toBe(400);
  });

  it('the worker reads it: pages → contents (§ with pages) → every § analysed → book meta → review; costs counted', async () => {
    expect(json(await admin('POST', `/admin/books/${id}/process`, {}))).toMatchObject({ status: 'queued' });
    expect((await admin('POST', `/admin/books/${id}/process`, {})).statusCode).toBe(409); // already queued
    await work();
    const d = json(await admin('GET', `/admin/books/${id}`));
    expect(d.book).toMatchObject({ status: 'review', stage: 'done', title: 'Физика 7', authors: ['Э. М. Мамбетакунов'], year: 2018, error: null, sectionCount: 6 });
    expect(d.book.usage.inputTokens).toBeGreaterThan(0);
    expect(d.sections.map((s: { number: string; kind: string; pages?: { from: number } }) => `${s.number}:${s.kind}:${s.pages?.from}`)).toEqual(['1:lesson:3', '2:lesson:4', '3:lesson:5', '4:lesson:6', '5:lesson:7', ':review:8']);
    expect(d.sections[2]).toMatchObject({ chapterTitle: 'МЕХАНИКА', summary: 'Бул § 3 жөнүндө.', keyTerms: [{ term: 'ылдамдык' }], questions: ['1. Ылдамдык деген эмне?'], reviewed: false });
    // The § analysis got the text of its own pages, with the thinking effort.
    const call = provider.generateCalls.find((c) => c.schema === SECTION_SCHEMA && c.prompt.includes('Ылдамдык\n'))!;
    expect(call.prompt).toContain('v = s/t');
    expect(call.effort).toBe('high');
    expect(provider.generateCalls.find((c) => c.schema === PAGES_SCHEMA && c.images)!.effort).toBe('none');
  });

  it('staff fix a § and publish; teachers see published books only; the cover is served', async () => {
    const d = json(await admin('GET', `/admin/books/${id}`));
    const s3 = d.sections[2];
    const p = json(await admin('PATCH', `/admin/books/${id}`, { summary: 'Механика жана динамика.', sections: [{ id: s3.id, summary: 'Ылдамдык – v = s/t.', reviewed: true, topicKey: 'phys7-uniform-speed' }] }));
    expect(p.book.summary).toBe('Механика жана динамика.');
    expect(p.sections[2]).toMatchObject({ summary: 'Ылдамдык – v = s/t.', reviewed: true, topicKey: 'phys7-uniform-speed', keyTerms: [{ term: 'ылдамдык' }] });
    const list = (q = '') => t.inject({ method: 'GET', url: `${API}/books${q}`, token: w.teacher.token });
    expect(json(await list('?grade=7')).items).toEqual([]);
    expect(json(await admin('POST', `/admin/books/${id}/publish`))).toMatchObject({ status: 'published' });
    expect(json(await list('?grade=7&subjectKey=phys')).items.map((b: { id: string }) => b.id)).toEqual([id]);
    expect(json(await list('?grade=8')).items).toEqual([]);
    expect(json(await t.inject({ method: 'GET', url: `${API}/books/${id}`, token: w.teacher.token })).sections).toHaveLength(6);
    // A new cover changes the link (no stale cache); staff see it, so do teachers once published.
    const before = json(await admin('GET', `/admin/books/${id}`)).book.coverUrl;
    const after = json(await admin('POST', `/admin/books/${id}/cover`, { image: PNG })).coverUrl;
    expect(after).not.toBe(before);
    const cover = await t.inject({ method: 'GET', url: `${API}/books/${id}/cover`, token: w.teacher.token });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toContain('image/png');
  });

  it('a teacher chooses the book for a class subject; without an own КТП the КТП comes from the book', async () => {
    const cls = w.cls;
    await t.repo.updateClass(cls.id, { grade: 7, subjectKeys: ['phys'] });
    const patch = (books: Record<string, string | null>) => t.inject({ method: 'PATCH', url: `${API}/classes/${cls.id}`, token: w.teacher.token, payload: { books } });
    expect(json(await patch({ phys: id })).books).toEqual({ phys: id });
    expect((await patch({ chem: id })).statusCode).toBe(400); // not a book of that subject
    const plan = json(await t.inject({ method: 'POST', url: `${API}/ktp/from-textbook`, token: w.teacher.token, payload: { bookId: id, hoursPerWeek: 1, weeks: 10, classes: [cls.name] } }));
    expect(plan).toMatchObject({ subjectKey: 'phys', grade: 7, lang: 'ky', totalHours: 10 });
    expect(plan.rows[0]).toMatchObject({ title: '§ 1. Механикалык кыймыл', homework: '§ 1, 3-бет' });
    expect(plan.rows.find((r: { title: string }) => r.title.startsWith('§ 3.'))).toMatchObject({ topicKey: 'phys7-uniform-speed' });
    expect(json(await patch({ phys: null })).books).toEqual({});
  });

  it('the provider out of balance pauses the book with the reason; nothing read is lost', async () => {
    const b = json(await admin('POST', '/admin/books', { fileName: 'b.pdf', subjectKey: 'phys', grade: 7, lang: 'ky', pageCount: 1, title: 'Китеп' }));
    await admin('POST', `/admin/books/${b.id}/pages`, { pages: [{ n: 1, text: 'x' }] });
    await admin('POST', `/admin/books/${b.id}/process`, {});
    fail = true;
    await runBookWorker(t.deps, t.app.log);
    fail = false;
    expect(json(await admin('GET', `/admin/books/${b.id}`)).book).toMatchObject({ status: 'processing', stage: 'pages', error: 'insufficient_balance', title: 'Китеп' });
    expect(await runBookWorker(t.deps, t.app.log)).toBeNull(); // still paused (lease)
    t.clock.advance(16 * 60_000);
    await work();
    const fresh = await makeUser(t.deps, { role: 'superadmin' }); // the old access tokens expired with the clock
    expect(json(await t.inject({ method: 'GET', url: `${API}/admin/books/${b.id}`, token: fresh.adminToken })).book).toMatchObject({ status: 'review', error: null, title: 'Китеп' });
    expect((await t.inject({ method: 'GET', url: `${API}/admin/books`, token: (await makeUser(t.deps, { role: 'teacher', scopeId: w.school.id })).adminToken })).statusCode).toBe(403);
  });
});

describe('books shipped with the content (v0.9.3)', () => {
  it('Физика 7 (Мамбетакунов) is imported once as a published book with its cover and every §; staff edits are kept', async () => {
    const { importBooks, loadBookSeeds } = await import('../../services/book-seed.js');
    const { DEFAULT_CONTENT_DIR } = await import('../../services/seed.js');
    const seeds = loadBookSeeds(DEFAULT_CONTENT_DIR);
    const phys = seeds.find((s) => s.title === 'Физика, 7-класс')!;
    expect(phys).toMatchObject({ grade: 7, lang: 'ky', subjectKey: 'phys', authors: ['Э. М. Мамбетакунов'], year: 2009 });
    expect(phys.cover?.length).toBeGreaterThan(10_000);
    expect((await importBooks(t.deps, seeds)).created).toContain(phys.id);
    const fresh = await makeUser(t.deps, { role: 'teacher', scopeId: w.school.id });
    const d = json(await t.inject({ method: 'GET', url: `${API}/books/${phys.id}`, token: fresh.token }));
    expect(d.book).toMatchObject({ status: 'published' });
    expect(d.book.coverUrl).toMatch(/\/cover\?v=/);
    const lessons = d.sections.filter((s: { kind: string }) => s.kind === 'lesson');
    expect(lessons.map((s: { number: string }) => s.number)).toEqual(Array.from({ length: 56 }, (_, i) => String(i + 1)));
    expect(lessons.every((s: { summary: string; keywords: string[] }) => s.summary.length > 20 && s.keywords.length > 0)).toBe(true);
    expect(d.sections.filter((s: { kind: string }) => s.kind === 'review')).toHaveLength(6);
    expect(lessons.find((s: { number: string }) => s.number === '6')).toMatchObject({ topicKey: 'phys7-uniform-speed' });
    // The Russian edition (2023) is a separate book of the same grade and subject, found by language.
    const ru = seeds.find((s) => s.lang === 'ru' && s.subjectKey === 'phys' && s.grade === 7)!;
    expect(ru).toMatchObject({ title: 'Физика, 7 класс', year: 2023, publisher: 'Учкун', authors: ['Э. Мамбетакунов', 'Б. Б. Мурзаибраимова'] });
    const ruNumbered = ru.sections.filter((x) => x.kind !== 'review' && Number(x.number) >= 1 && !(x.kind === 'extra' && Number(x.number) <= 4 && x.chapterNumber === '6'));
    expect(ruNumbered.map((x) => x.number)).toEqual(Array.from({ length: 58 }, (_, i) => String(i + 1)));
    expect(ru.sections.filter((x) => x.kind === 'review')).toHaveLength(5);
    const byLang = async (lang: string) => json(await t.inject({ method: 'GET', url: `${API}/books?grade=7&subjectKey=phys&lang=${lang}`, token: fresh.token })).items.map((b: { id: string }) => b.id);
    expect(await byLang('ru')).toEqual([ru.id]);
    expect(await byLang('ky')).toContain(phys.id);
    await t.repo.updateBook(phys.id, { summary: 'staff' });
    expect((await importBooks(t.deps, seeds)).created).toEqual([]);
    expect((await t.repo.getBook(phys.id))!.summary).toBe('staff');
  });
});

describe('class names and books in the new class form (v0.9.3)', () => {
  it('names show in capitals (saved and old ones); the form can set the books of the class subjects', async () => {
    const { normalizeClassName } = await import('@bilig/content-model/api');
    expect(['8а', ' 9  б ', '7-ө', '10 «в»', '8A'].map(normalizeClassName)).toEqual(['8А', '9 Б', '7-Ө', '10 «В»', '8A']);
    const teacher = await makeUser(t.deps, { role: 'teacher', scopeId: w.school.id });
    await licenseSchool(t.deps, w.school.id, ['phys', 'bio'], [7]);
    const [book] = json(await t.inject({ method: 'GET', url: `${API}/books?grade=7&subjectKey=phys&lang=ky`, token: teacher.token })).items;
    const create = (payload: Record<string, unknown>) => t.inject({ method: 'POST', url: `${API}/classes`, token: teacher.token, payload });
    const c = json(await create({ name: '7а', grade: 7, subjectKeys: ['phys'], books: { phys: book.id } }));
    expect(c).toMatchObject({ name: '7А', books: { phys: book.id } });
    expect((await create({ name: '7б', grade: 7, subjectKeys: ['bio'], books: { phys: book.id } })).statusCode).toBe(400); // not a subject of the class
    const renamed = json(await t.inject({ method: 'PATCH', url: `${API}/classes/${c.id}`, token: teacher.token, payload: { name: '7 в' } }));
    expect(renamed.name).toBe('7 В');
    // A class saved before (lowercase in the database) is shown in capitals.
    await t.repo.updateClass(c.id, { name: '7г' });
    expect(json(await t.inject({ method: 'GET', url: `${API}/classes/${c.id}`, token: teacher.token })).name).toBe('7Г');
  });
});
