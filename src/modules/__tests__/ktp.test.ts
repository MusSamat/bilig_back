/** КТП → lesson plans routes (contract 0.5.0 §6): upload, list, get, patch, delete, plan downloads. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { DOCX_MEDIA_TYPE, KTP_MAX_BYTES } from '@bilig/content-model/api';
import { importContent, loadContentDir } from '../../services/seed.js';
import { API, json, makeSchoolWorld, makeTestApp, makeUser, type MadeUser, type TestCtx } from '../../test/helpers.js';
import { dumpDocx } from '../../ktp/__tests__/docx-builder.js';
import { algebraKtp, russianKtp, scienceKtp } from '../../ktp/__tests__/fixtures.js';
import { KTP_UPLOADS_PER_HOUR } from '../ktp.js';

let t: TestCtx;
let teacher: MadeUser;
let other: MadeUser;
let student: { token: string };
let schoolId: string;

beforeAll(async () => {
  t = await makeTestApp({ seed: false });
  await importContent(t.repo, t.clock, loadContentDir(), t.deps.config);
  const world = await makeSchoolWorld(t.deps);
  teacher = world.teacher;
  student = world.students[0];
  schoolId = world.school.id;
  other = await makeUser(t.deps, { role: 'teacher', scopeId: schoolId });
}, 60_000);
afterAll(() => t.close());

const upload = (token: string | undefined, file: Buffer | string, extra: Record<string, unknown> = {}) =>
  t.inject({ method: 'POST', url: `${API}/ktp`, token, payload: { fileName: 'КТП алгебра 8.docx', data: typeof file === 'string' ? file : file.toString('base64'), ...extra } });

const docxText = (body: Buffer) => dumpDocx(body).join('\n');

describe('POST /ktp', () => {
  it('parses, checks and links an uploaded КТП', async () => {
    const res = await upload(teacher.token, algebraKtp());
    expect(res.statusCode, res.body).toBe(200);
    const p = json(res);
    expect(p).toMatchObject({ version: 1, ownerId: teacher.user.id, subjectName: 'алгебра', subjectKey: 'math', grade: 8, lang: 'ky', classes: ['8Б', '8В'], year: 2026, declaredHours: 136, totalHours: 138, sourceName: 'КТП алгебра 8.docx' });
    expect(p.rows).toHaveLength(138);
    expect(p.rows[0]).toMatchObject({ index: 1, number: 1, title: 'Сандар системасы', section: { title: 'Сан', hours: 10 }, topicKey: null });
    expect(p.rows.find((r: { title: string }) => r.title === 'Тик бурчтуу үч бурчтук. Пифагордун теоремасы')).toMatchObject({ topicKey: 'pythagorean-theorem', match: { auto: true } });
    expect(p.issues.map((i: { code: string }) => i.code)).toContain('hours_mismatch');
    expect(p.issues.find((i: { code: string }) => i.code === 'date_invalid')).toEqual({ code: 'date_invalid', severity: 'error', row: 109, class: '8В', params: { date: '31.04.27' } });
    expect(p).not.toHaveProperty('invalidDates');
    expect(res.headers.etag).toBe('"1"');
    const audit = await t.repo.listAudit({ action: 'ktp.created', actorId: teacher.user.id }, { limit: 10 });
    expect(audit.items.map((a) => a.targetId)).toContain(p.id);
  });

  it('links topics of a natural sciences КТП (speed, atom structure; none for a test or an unknown topic)', async () => {
    const p = json(await upload(teacher.token, scienceKtp(), { fileName: 'science.docx' }));
    expect(p.rows.map((r: { topicKey: string | null }) => r.topicKey)).toEqual(['speed', 'atom-structure', null, null]);
    expect(p.subjectKey).toBeNull();
  });

  it('takes the language from the request or detects it', async () => {
    expect(json(await upload(teacher.token, russianKtp())).lang).toBe('ru');
    expect(json(await upload(teacher.token, russianKtp(), { lang: 'ky' })).lang).toBe('ky');
  });

  it('rejects non-docx, oversize and malformed uploads', async () => {
    const notDocx = await upload(teacher.token, Buffer.from('%PDF-1.7 definitely not a docx file'));
    expect(notDocx.statusCode).toBe(400);
    expect(json(notDocx).detail).toBe('invalid .docx: not_docx');
    const big = await upload(teacher.token, Buffer.alloc(KTP_MAX_BYTES + 1));
    expect(big.statusCode).toBe(413);
    expect((await upload(teacher.token, '!!!not base64!!!')).statusCode).toBe(400);
    expect((await upload(teacher.token, 'A'.repeat(Math.ceil((KTP_MAX_BYTES * 4) / 3) + 100))).statusCode).toBe(400);
  });

  it('is for teachers: guests 401, students 403', async () => {
    expect((await upload(undefined, algebraKtp())).statusCode).toBe(401);
    expect((await upload(student.token, algebraKtp())).statusCode).toBe(403);
    expect((await t.inject({ method: 'GET', url: `${API}/ktp`, token: student.token })).statusCode).toBe(403);
  });

  it(`is rate limited (${KTP_UPLOADS_PER_HOUR} uploads per hour per user)`, async () => {
    const u = await makeUser(t.deps, { role: 'teacher', scopeId: schoolId });
    const file = scienceKtp();
    for (let i = 0; i < KTP_UPLOADS_PER_HOUR; i++) expect((await upload(u.token, file)).statusCode).toBe(200);
    const res = await upload(u.token, file);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('owner-only CRUD', () => {
  it('list / get / patch / delete; others get 404; If-Match is enforced', async () => {
    const p = json(await upload(teacher.token, algebraKtp()));
    const url = `${API}/ktp/${p.id}`;

    const list = json(await t.inject({ method: 'GET', url: `${API}/ktp?limit=100`, token: teacher.token }));
    const mine = list.items.find((x: { id: string }) => x.id === p.id);
    expect(mine).toMatchObject({ title: p.title, lessons: 138, errors: 1, totalHours: 138, classes: ['8Б', '8В'], version: 1 });
    expect(mine.warnings).toBeGreaterThan(0);
    expect(mine.rows).toBeUndefined();
    expect(json(await t.inject({ method: 'GET', url: `${API}/ktp`, token: other.token })).items).toEqual([]);

    expect((await t.inject({ method: 'GET', url, token: other.token })).statusCode).toBe(404);
    expect((await t.inject({ method: 'GET', url: `${API}/ktp/0192f000-0000-7000-8000-000000000000`, token: teacher.token })).statusCode).toBe(404);
    expect(json(await t.inject({ method: 'GET', url, token: teacher.token })).rows).toHaveLength(138);

    const patch = (token: string, payload: unknown, ifMatch?: string) =>
      t.inject({ method: 'PATCH', url, token, payload: payload as object, headers: ifMatch ? { 'if-match': ifMatch } : {} });
    expect((await patch(teacher.token, { version: 1, title: 'x' })).statusCode).toBe(428);
    expect((await patch(other.token, { version: 1, title: 'x' }, '"1"')).statusCode).toBe(404);

    const ok = await patch(
      teacher.token,
      { version: 1, title: 'Алгебра 8', teacherName: 'Асанов Б.', rows: [{ index: 109, dates: { '8В': '2027-04-02' } }, { index: 3, topicKey: 'speed' }, { index: 5, hours: 2 }] },
      '"1"',
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const v2 = json(ok);
    expect(v2).toMatchObject({ version: 2, title: 'Алгебра 8', teacherName: 'Асанов Б.', totalHours: 139 });
    expect(v2.rows[2]).toMatchObject({ topicKey: 'speed', match: { auto: false, score: 1 } });
    expect(v2.issues.some((i: { code: string }) => i.code === 'date_invalid')).toBe(false);
    expect(v2.issues.find((i: { code: string }) => i.code === 'hours_mismatch').params).toEqual({ declared: 136, actual: 139 });
    expect(ok.headers.etag).toBe('"2"');

    // re-validation keeps the teacher's topic when the title changes
    const v3 = json(await patch(teacher.token, { version: 2, rows: [{ index: 3, title: 'Көрсөткүчтүү даража' }] }, '"2"'));
    expect(v3.rows[2]).toMatchObject({ title: 'Көрсөткүчтүү даража', topicKey: 'speed', match: { auto: false } });

    expect((await patch(teacher.token, { version: 2, title: 'y' }, '"2"')).statusCode).toBe(409);
    expect((await patch(teacher.token, { version: 3, rows: [{ index: 1, topicKey: 'no-such-topic' }] }, '"3"')).statusCode).toBe(400);
    expect((await patch(teacher.token, { version: 3, rows: [{ index: 500, title: 'x' }] }, '"3"')).statusCode).toBe(400);
    expect((await patch(teacher.token, { version: 3, rows: [{ index: 1, dates: { '9z': null } }] }, '"3"')).statusCode).toBe(400);

    expect((await t.inject({ method: 'DELETE', url, token: teacher.token })).statusCode).toBe(428);
    expect((await t.inject({ method: 'DELETE', url, token: other.token, headers: { 'if-match': '3' } })).statusCode).toBe(404);
    expect((await t.inject({ method: 'DELETE', url, token: teacher.token, headers: { 'if-match': '2' } })).statusCode).toBe(409);
    expect((await t.inject({ method: 'DELETE', url, token: teacher.token, headers: { 'if-match': '3' } })).statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url, token: teacher.token })).statusCode).toBe(404);
    const audit = await t.repo.listAudit({ action: 'ktp.deleted' }, { limit: 10 });
    expect(audit.items.map((a) => a.targetId)).toContain(p.id);
  });
});

describe('lesson plan downloads', () => {
  let algebraId: string;
  let scienceId: string;
  beforeAll(async () => {
    algebraId = json(await upload(teacher.token, algebraKtp())).id;
    scienceId = json(await upload(teacher.token, scienceKtp())).id;
  });

  it('v0.9.3: class labels in capitals; an old lowercase link (?class=8б) still finds «8Б»', async () => {
    const p = json(await t.inject({ method: 'GET', url: `${API}/ktp/${algebraId}`, token: teacher.token }));
    expect(p.classes).toEqual(['8Б', '8В']);
    const res = await t.inject({ method: 'GET', url: `${API}/ktp/${algebraId}/lessons/1/plan?class=${encodeURIComponent('8б')}`, token: teacher.token });
    expect(res.statusCode).toBe(200);
  });

  it('one lesson: the official form as .docx with a UTF-8 file name', async () => {
    const res = await t.inject({ method: 'GET', url: `${API}/ktp/${algebraId}/lessons/1/plan?class=${encodeURIComponent('8Б')}`, token: teacher.token });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain(DOCX_MEDIA_TYPE);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="plan_8B_2026-09-15_1.docx"; filename*=UTF-8''plan_8%D0%91_2026-09-15_1.docx`);
    const lines = dumpDocx(res.rawPayload);
    const text = lines.join('\n');
    expect(text).toContain('8Б -класс');
    expect(text).toContain('Числосу: 15.09.2026');
    expect(text).toContain('Сабактын темасы: Сандар системасы');
    expect(text).toContain('Предмети: Алгебра');
    expect(text).toContain('Алгебра окуу китеби (8-класс)');
    expect(text).not.toContain('Табигый илимдер');
    expect(text).toContain('Мугалими: Асанов Бакыт Урматович');
    const stages = lines.filter((l) => /^\| \d\. /.test(l));
    expect(stages).toHaveLength(7);
    expect(stages.reduce((s, l) => s + Number(/\| (\d+) мүнөт \|/.exec(l)![1]), 0)).toBe(45);
  });

  it('content from the linked topic (speed): goal, tour, mini-test, § 8.1 and pages; in Russian on request', async () => {
    const ky = await t.inject({ method: 'GET', url: `${API}/ktp/${scienceId}/lessons/1/plan?class=${encodeURIComponent('8А')}`, token: teacher.token });
    expect(ky.statusCode, ky.body).toBe(200);
    const text = docxText(ky.rawPayload);
    expect(text).toContain('Сабактын милдети: Ылдамдыкты v = s/t формуласы боюнча эсептөө');
    expect(text).toContain('Машина түз жол менен бара жатат.');
    expect(text).toContain('Ылдамдыкты кайсы формула менен эсептейбиз?');
    expect(text).toContain('Табигый илимдер 8, § 8.1, 176–185-беттер');
    expect(text).toContain('Bilig: «Ылдамдык»');
    const ru = await t.inject({ method: 'GET', url: `${API}/ktp/${scienceId}/lessons/1/plan?class=${encodeURIComponent('8А')}&lang=ru`, token: teacher.token });
    const rt = docxText(ru.rawPayload);
    expect(rt).toContain('Ход урока:');
    expect(rt).toContain('Естественные науки 8, § 8.1, стр. 176–185');
    expect(rt).toContain('По какой формуле вычисляют скорость?');
  });

  it('a range: one .docx with a plan per page; limits and errors', async () => {
    const res = await t.inject({ method: 'GET', url: `${API}/ktp/${algebraId}/plans?class=${encodeURIComponent('8В')}&from=8&to=12`, token: teacher.token });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''plans_8%D0%92_8-12.docx`);
    const lines = dumpDocx(res.rawPayload);
    expect(lines.filter((l) => l === '\f')).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith('Сабактын темасы:'))).toEqual([
      'Сабактын темасы: Мисал иштөө',
      'Сабактын темасы: Текшерүү иши №1',
      'Сабактын темасы: Текшерүү ишти анализдөө',
      'Сабактын темасы: 0,1 жана 0,01 ге көбөйтүү жана бөлүү',
      'Сабактын темасы: Тегеректөө жана маанилүү цифралар',
    ]);
    expect(new PizZip(res.rawPayload).file('word/document.xml')).not.toBeNull();

    const get = (url: string, token = teacher.token) => t.inject({ method: 'GET', url: `${API}/ktp/${algebraId}${url}`, token });
    expect((await get(`/plans?class=8%D0%B2&from=1&to=11`)).statusCode).toBe(400);
    expect((await get(`/plans?class=8%D0%B2&from=5&to=4`)).statusCode).toBe(400);
    expect((await get(`/plans?class=8%D0%B2&from=200&to=205`)).statusCode).toBe(404);
    expect((await get(`/plans?class=9z&from=1&to=2`)).statusCode).toBe(400);
    expect((await get(`/lessons/999/plan?class=8%D0%B2`)).statusCode).toBe(404);
    expect((await get(`/lessons/abc/plan?class=8%D0%B2`)).statusCode).toBe(404);
    expect((await get(`/lessons/1/plan`)).statusCode).toBe(400);
    expect((await get(`/lessons/1/plan?class=8%D0%B2`, other.token)).statusCode).toBe(404);
    expect((await get(`/lessons/1/plan?class=8%D0%B2`, student.token)).statusCode).toBe(403);
  });
});
