/** Contract v0.5.0: textbooks and the textbook menu (docs/CONTRACT_CHANGES-0.5.0.md §1–3). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Textbook } from '@bilig/content-model';
import { newId } from '../../ids.js';
import { importContent } from '../../services/seed.js';
import { API, fixtureContent, json, makeTestApp, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';

const L = (s: string) => ({ ky: `${s} ky`, ru: `${s} ru`, en: `${s} en` });

const book = (key: string, over: Partial<Textbook> = {}): Textbook => ({
  key,
  title: L(key),
  grade: 7,
  lang: 'ky',
  order: 0,
  chapters: [
    {
      key: 'ch1',
      number: '1',
      title: L('Cells'),
      subjectKey: 'bio',
      pages: { from: 5, to: 30 },
      lessons: [
        { key: 'ch1.l1', number: '1.1', kind: 'lesson', title: L('Animal cell'), pages: { from: 5, to: 12 }, topicKeys: ['animal-cell'] },
        { key: 'ch1.l2', number: '1.2', kind: 'lesson', title: L('Plant cell'), topicKeys: ['plant-draft', 'no-such-topic'] },
        { key: 'ch1.r', number: '', kind: 'review', title: L('Review'), topicKeys: ['demo-cell', 'animal-cell', 'plant-draft'] },
      ],
    },
  ],
  ...over,
});

const chemBook = () =>
  book('chem-8', {
    grade: 8,
    order: 0,
    chapters: [{ ...book('x').chapters[0], subjectKey: 'chem' }],
  });

let t: TestCtx;
beforeEach(async () => {
  t = await makeTestApp({ seed: false });
  const c = fixtureContent();
  // seeded from catalog.json `textbooks` (order 1 first, then by grade)
  await importContent(t.repo, t.clock, { ...c, base: { ...c.base, textbooks: [book('bio-7', { order: 1 }), chemBook()] } }, t.deps.config);
  const draft = await t.repo.createTopic({ id: newId(), key: 'plant-draft', unitKey: 'bio.g7.cells', subjectKey: 'bio', status: 'draft', demo: false, publishedVersionId: null, latestVersionId: null, scheduledAt: null, scheduledVersionId: null });
  if (draft === 'conflict') throw new Error('conflict');
});
afterEach(() => t.close());

describe('textbooks (v0.5.0)', () => {
  it('seed stores textbooks as a shared content kind', async () => {
    const rec = await t.repo.content('textbook').get('bio-7');
    expect(rec).toMatchObject({ key: 'bio-7', subjectKey: null, version: 1 });
    expect(await t.repo.content('textbook').count()).toBe(2);
  });

  it('GET /textbooks: ordered, localized, filtered by grade and any chapter subject', async () => {
    const r = await t.inject({ method: 'GET', url: `${API}/textbooks`, headers: { 'accept-language': 'en' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-language']).toBe('en');
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    const items = json(r).items as Textbook[];
    expect(items.map((x) => x.key)).toEqual(['chem-8', 'bio-7']);
    // lessons list published topics only; chapters and lessons stay
    const bio = items.find((x) => x.key === 'bio-7')!;
    expect(bio.chapters[0].lessons.map((l) => l.topicKeys)).toEqual([['animal-cell'], [], ['demo-cell', 'animal-cell']]);
    const q = async (s: string) => (json(await t.inject({ method: 'GET', url: `${API}/textbooks?${s}` })).items as Textbook[]).map((x) => x.key);
    expect(await q('grade=7')).toEqual(['bio-7']);
    expect(await q('subjectKey=chem')).toEqual(['chem-8']);
    expect(await q('grade=7&subjectKey=chem')).toEqual([]);
    expect((await t.inject({ method: 'GET', url: `${API}/textbooks?grade=12` })).statusCode).toBe(400);
  });

  it('GET /textbooks/:key: textbook + cards of published topics in reading order; 404', async () => {
    const r = await t.inject({ method: 'GET', url: `${API}/textbooks/bio-7`, headers: { 'accept-language': 'ru' } });
    expect(r.statusCode, r.body).toBe(200);
    const body = json(r);
    expect(body.textbook.title).toMatchObject({ ru: 'bio-7 ru' });
    expect(body.textbook.chapters[0].lessons[1].topicKeys).toEqual([]);
    expect(body.topics.map((x: { key: string }) => x.key)).toEqual(['animal-cell', 'demo-cell']);
    expect(body.topics[0].filesBaseUrl).toEqual(expect.any(String));
    const nf = await t.inject({ method: 'GET', url: `${API}/textbooks/nope` });
    expect(nf.statusCode).toBe(404);
    expect(json(nf).detail).toBe('textbook');
  });

  it('GET /catalog includes textbooks with published topics only', async () => {
    const c = json(await t.inject({ method: 'GET', url: `${API}/catalog` }));
    expect(c.textbooks.map((x: Textbook) => x.key)).toEqual(['chem-8', 'bio-7']);
    expect(c.textbooks[1].chapters[0].lessons[1].topicKeys).toEqual([]);
  });
});

describe('admin textbooks (v0.5.0)', () => {
  let w: AdminWorld;
  beforeEach(async () => {
    w = await makeAdminWorld(t);
  });
  const url = `${API}/admin/textbooks`;

  it('list / get need content.draft.edit', async () => {
    const list = await t.inject({ method: 'GET', url, token: w.author.adminToken });
    expect(list.statusCode, list.body).toBe(200);
    expect(json(list).items.map((x: { data: Textbook }) => x.data.key)).toEqual(['bio-7', 'chem-8']);
    const one = await t.inject({ method: 'GET', url: `${url}/bio-7`, token: w.author.adminToken });
    expect(json(one)).toMatchObject({ version: 1, data: { key: 'bio-7' } });
    expect((await t.inject({ method: 'GET', url: `${url}/nope`, token: w.author.adminToken })).statusCode).toBe(404);
    expect((await t.inject({ method: 'GET', url, token: w.teacher.adminToken })).statusCode).toBe(403);
  });

  it('create / patch / delete need content.publish, If-Match and a valid textbook', async () => {
    const created = book('bio-8', { grade: 8, order: 5 });
    expect((await t.inject({ method: 'POST', url, token: w.author.adminToken, payload: created })).statusCode).toBe(403);
    const r = await t.inject({ method: 'POST', url, token: w.editorOther.adminToken, payload: created });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ version: 1, data: { key: 'bio-8' } });
    expect((await t.inject({ method: 'POST', url, token: w.editor.adminToken, payload: created })).statusCode).toBe(409);
    const dup = book('bio-9');
    dup.chapters[0].lessons[1].key = 'ch1.l1';
    expect((await t.inject({ method: 'POST', url, token: w.editor.adminToken, payload: dup })).statusCode).toBe(400);

    // PATCH = partial merge, re-validated with the full schema (duplicate keys rejected)
    const patch = (payload: object, ifMatch: string, token = w.editor.adminToken) =>
      t.inject({ method: 'PATCH', url: `${url}/bio-8`, token, headers: { 'if-match': ifMatch }, payload });
    expect((await patch({ order: 2, version: 1 }, '1', w.author.adminToken)).statusCode).toBe(403);
    expect((await patch({ order: 2, version: 7 }, '7')).statusCode).toBe(409);
    const badChapters = [{ ...created.chapters[0] }, { ...created.chapters[0] }];
    expect((await patch({ chapters: badChapters, version: 1 }, '1')).statusCode).toBe(400);
    const ok = await patch({ order: 2, publisher: 'Билим', version: 1 }, '1');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json(ok)).toMatchObject({ version: 2, data: { key: 'bio-8', order: 2, publisher: 'Билим', grade: 8 } });
    const cleared = await patch({ publisher: null, version: 2 }, '2');
    expect(json(cleared).data).not.toHaveProperty('publisher');
    // the read side picks the change up
    const menu = json(await t.inject({ method: 'GET', url: `${API}/textbooks?grade=8` })).items as Textbook[];
    expect(menu.map((x) => x.key)).toEqual(['chem-8', 'bio-8']);

    const del = (ifMatch: string, token = w.editor.adminToken) => t.inject({ method: 'DELETE', url: `${url}/bio-8`, token, headers: { 'if-match': ifMatch } });
    expect((await del('3', w.author.adminToken)).statusCode).toBe(403);
    expect((await del('1')).statusCode).toBe(409);
    expect((await del('3')).statusCode).toBe(200);
    expect(await t.repo.content('textbook').get('bio-8')).toBeNull();
    expect((await t.inject({ method: 'GET', url: `${API}/textbooks/bio-8` })).statusCode).toBe(404);
  });

  it('a textbook never blocks deleting the units or topics it maps to', async () => {
    const { usageOf } = await import('../admin/content.js');
    expect(await usageOf(t.deps, 'textbook', 'bio-7')).toEqual([]);
  });
});
