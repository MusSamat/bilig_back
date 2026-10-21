/** v0.9.2 routes: POST /ktp/contents, POST /ktp/from-textbook, GET /ktp/:id/docx. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCX_MEDIA_TYPE } from '@bilig/content-model/api';
import { importContent, loadContentDir } from '../../services/seed.js';
import { MockProvider } from '../../services/tutor-provider.js';
import { API, json, makeSchoolWorld, makeTestApp, type MadeUser, type TestCtx } from '../../test/helpers.js';
import { buildDocx } from '../../ktp/__tests__/docx-builder.js';
import { PHYS7_CONTENTS } from '../../ktp/__tests__/contents.fixture.js';
import { readDocx } from '../../ktp/docx-read.js';
import { parseKtp } from '../../ktp/parse.js';

let t: TestCtx;
let teacher: MadeUser;
const MODEL = {
  contentsImages: [1],
  title: 'Физика 7',
  grade: 7,
  chapters: [
    { number: 'I', title: 'Механика. Кинематиканын негиздери', lessons: [{ number: '4', title: 'Нерсенин механикалык кыймылы', page: 17 }, { number: '5', title: 'Жол жана которулуш', page: 19 }, { number: '6', title: 'Кыймылдын ылдамдыгы. Бир калыптагы кыймыл', page: 22 }, { number: '', title: '«Кинематиканын негиздери» темасы боюнча тесттик тапшырмалар', page: 40 }] },
  ],
};
const provider = new MockProvider(undefined, () => MODEL);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeAll(async () => {
  t = await makeTestApp({ seed: false, tutor: provider });
  await importContent(t.repo, t.clock, loadContentDir(), t.deps.config);
  teacher = (await makeSchoolWorld(t.deps)).teacher;
}, 60_000);
afterAll(() => t.close());

const contents = (payload: Record<string, unknown>, token = teacher.token) => t.inject({ method: 'POST', url: `${API}/ktp/contents`, token, payload: { fileName: 'Физика 7-класс.docx', ...payload } });
const fromTextbook = (payload: Record<string, unknown>) => t.inject({ method: 'POST', url: `${API}/ktp/from-textbook`, token: teacher.token, payload });

describe('POST /ktp/contents', () => {
  it('a .docx with the contents is read without the model; § are linked to the topics of the grade', async () => {
    const docx = buildDocx(PHYS7_CONTENTS.split('\n').map((p) => ({ p }))).toString('base64');
    const res = await contents({ docx });
    expect(res.statusCode, res.body).toBe(200);
    const r = json(res);
    expect(r).toMatchObject({ source: 'text', draft: { lang: 'ky', grade: 7, subjectKey: 'phys' } });
    expect(provider.generateCalls).toHaveLength(0);
    const speed = r.draft.chapters[1].lessons.find((l: { number: string }) => l.number === '6');
    expect(speed).toMatchObject({ pages: { from: 22, to: 39 }, topicKey: 'phys7-uniform-speed' });
  });

  it('page images go to the model as images; its contents come back checked', async () => {
    const res = await contents({ fileName: 'scan.pdf', images: [PNG, PNG], imagePages: [2, 87] });
    expect(res.statusCode, res.body).toBe(200);
    const r = json(res);
    expect(provider.generateCalls.at(-1)!.images).toEqual([PNG, PNG]);
    expect(provider.generateCalls.at(-1)!.prompt).toContain('2 page images');
    expect(r).toMatchObject({ source: 'assistant', contentsPages: [1], draft: { title: 'Физика 7', grade: 7 } });
    expect(r.draft.chapters[0]).toMatchObject({ number: '1', lessons: [{ number: '4', pages: { from: 17, to: 18 } }, {}, {}, { kind: 'review', pages: { from: 40, to: 40 } }] });
  });

  it('exactly one source; images need the online assistant (503 without one); only teachers', async () => {
    expect((await contents({ pages: ['x'], docx: 'AAAA' })).statusCode).toBe(400);
    const off = await makeTestApp({ tutor: null });
    const w = await makeSchoolWorld(off.deps);
    const res = await off.inject({ method: 'POST', url: `${API}/ktp/contents`, token: w.teacher.token, payload: { fileName: 'a.jpg', images: [PNG] } });
    expect(res.statusCode).toBe(503);
    expect((await off.inject({ method: 'POST', url: `${API}/ktp/contents`, token: w.students[0].token, payload: { fileName: 'a.jpg', images: [PNG] } })).statusCode).toBe(403);
    await off.close();
  });
});

describe('POST /ktp/from-textbook and GET /ktp/:id/docx', () => {
  it('from the catalog «Физика 7», 2 lessons a week: a dated-later TeachingPlan, then the КТП .docx', async () => {
    const res = await fromTextbook({ textbookKey: 'fizika-7', hoursPerWeek: 2, year: 2026, classes: ['7 а'] });
    expect(res.statusCode, res.body).toBe(200);
    const p = json(res);
    expect(p).toMatchObject({ subjectKey: 'phys', grade: 7, lang: 'ky', year: 2026, classes: ['7А'], declaredHours: 68, totalHours: 68, sourceName: 'Физика, 7-класс' });
    expect(p.title).toMatch(/\(алдын ала\)$/);
    expect(p.rows).toHaveLength(68);
    expect(p.issues).toEqual([{ code: 'date_missing', severity: 'info', class: '7А' }]);
    const file = await t.inject({ method: 'GET', url: `${API}/ktp/${p.id}/docx`, token: teacher.token });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain(DOCX_MEDIA_TYPE);
    expect(String(file.headers['content-disposition'])).toMatch(/KTP_/);
    const back = parseKtp(readDocx(file.rawPayload), { now: new Date('2026-08-20') });
    expect(back.rows.map((r) => r.title)).toEqual(p.rows.map((r: { title: string }) => r.title));
    expect(back.rows[5].note).toMatch(/^Bilig: /);
  });

  it('from a checked contents draft (in Russian); another teacher cannot download it', async () => {
    const draft = {
      title: 'Физика 8',
      grade: 8,
      lang: 'ru',
      subjectKey: 'phys',
      chapters: [{ number: '1', title: 'Движение', lessons: [{ number: '1', kind: 'lesson', title: 'Скорость', pages: { from: 5, to: 8 } }, { number: '2', kind: 'lesson', title: 'Сила', pages: { from: 9, to: 12 } }, { number: '', kind: 'review', title: 'Тест по главе' }] }],
    };
    const p = json(await fromTextbook({ draft, hoursPerWeek: 1, weeks: 10 }));
    expect(p).toMatchObject({ lang: 'ru', grade: 8, classes: ['8'], totalHours: 10 });
    expect(p.rows[0]).toMatchObject({ title: '§ 1. Скорость', topicKey: 'speed', homework: '§ 1, с. 5–8' });
    expect(p.rows.map((r: { type: string }) => r.type)).toContain('analysis');
    const stranger = (await makeSchoolWorld(t.deps)).teacher;
    expect((await t.inject({ method: 'GET', url: `${API}/ktp/${p.id}/docx`, token: stranger.token })).statusCode).toBe(404);
    expect((await fromTextbook({ textbookKey: 'nope', hoursPerWeek: 2 })).statusCode).toBe(404);
    expect((await fromTextbook({ textbookKey: 'fizika-7', draft, hoursPerWeek: 2 })).statusCode).toBe(400);
  });
});
