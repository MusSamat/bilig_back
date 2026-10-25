/**
 * v0.10.0 — the teacher cabinet v3: row uids and PATCH insert/remove, the calendar and scheduling, lesson
 * pages (content, conducted, the .docx and the slides), the assistant, a КТП from the standard, the agenda,
 * assignment summaries and Me.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { quarterHours, schoolCalendar, studySlots, type KtpRow } from '@bilig/content-model/api';
import { importContent, loadContentDir } from '../../services/seed.js';
import { MockProvider, type GenerateRequest } from '../../services/tutor-provider.js';
import { API, json, makeSchoolWorld, makeStudent, makeTestApp, makeUser, type MadeUser, type TestCtx } from '../../test/helpers.js';
import { dumpDocx } from '../../ktp/__tests__/docx-builder.js';
import { newId } from '../../ids.js';
import { newRowUid } from '../../ktp/row-uid.js';
import { recheck, type PlanDoc } from '../../ktp/teaching-plan.js';
import { ASK_SCHEMA, DRAFT_SCHEMA, MATERIALS_SCHEMA, STANDARD_SCHEMA } from '../../ktp/assist.js';
import type { ClassRec, TeachingPlanRec } from '../../repo/types.js';
import { LESSON_ASSIST_PER_HOUR, standardLessons } from '../cabinet.js';

const STANDARD = {
  chapters: [
    { title: 'Механикалык кыймыл', lessons: [{ title: 'Ылдамдык', kind: 'lesson' }, { title: 'Ылдамдыкты өлчөө', kind: 'lab' }, { title: 'Ылдамдануу', kind: 'lesson' }, { title: 'Текшерүү', kind: 'test' }] },
    { title: 'Күч', lessons: [{ title: 'Ньютондун мыйзамдары', kind: 'lesson' }, { title: 'Сүрүлүү күчү', kind: 'lesson' }, { title: 'Текшерүү', kind: 'test' }] },
  ],
};
const script = (req: GenerateRequest): unknown => {
  if (req.schema === STANDARD_SCHEMA) return STANDARD;
  if (req.schema === MATERIALS_SCHEMA) return { items: ['Мисал 1: 36 км/саат = 10 м/с', 'Мисал 2', 'Мисал 2', 'Эски мисал'] };
  if (req.schema === ASK_SCHEMA) return { answer: 'Топтордо өлчөө жүргүзүңүз.' };
  if (req.schema === DRAFT_SCHEMA)
    return { stages: [{ key: 'engage', teacher: 'Суроо берет', pupil: 'Жооп беришет' }, { key: 'bogus', teacher: 'x', pupil: 'y' }], goals: { knowledge: { goal: 'Ылдамдыкты билет', result: 'Эсептей алат' }, development: { goal: '', result: '' }, upbringing: { goal: '', result: '' } } };
  return {};
};
const provider = new MockProvider(undefined, script);

let t: TestCtx;
let teacher: MadeUser;
let other: MadeUser;
let cls: ClassRec;
let world: Awaited<ReturnType<typeof makeSchoolWorld>>;

beforeAll(async () => {
  t = await makeTestApp({ seed: false, tutor: provider });
  await importContent(t.repo, t.clock, loadContentDir(), t.deps.config);
  world = await makeSchoolWorld(t.deps);
  teacher = world.teacher;
  cls = world.cls;
  other = await makeUser(t.deps, { role: 'teacher', scopeId: world.school.id });
}, 60_000);
afterAll(() => t.close());

const row = (i: number, extra: Partial<KtpRow> = {}): KtpRow => ({
  uid: newRowUid(),
  index: i,
  number: i,
  section: { title: 'Кинематика' },
  title: `Сабак ${i}`,
  hours: 1,
  type: 'new',
  dates: { '7А': null },
  homework: '',
  note: '',
  topicKey: null,
  ...extra,
});

/** A plan stored straight in the repository (`legacy`: rows without uids, as before 0.10.0). */
async function makePlan(ownerId: string, rows: KtpRow[], o: { legacy?: boolean; title?: string; subjectKey?: string | null; link?: boolean } = {}): Promise<TeachingPlanRec> {
  const doc = recheck({
    title: o.title ?? 'Физика 7',
    subjectName: 'Физика',
    subjectKey: o.subjectKey === undefined ? 'phys' : o.subjectKey,
    grade: 7,
    lang: 'ky',
    teacherName: 'Асанов',
    schoolName: '',
    year: 2026,
    classes: ['7А'],
    classLinks: { '7А': o.link === false ? null : cls.id },
    declaredHours: null,
    rows: o.legacy ? rows.map(({ uid: _u, ...r }) => r as KtpRow) : rows,
    sourceName: 'test',
    invalidDates: {},
  });
  const now = t.clock.now();
  const rec = { id: newId(), ownerId, title: doc.title, doc, version: 1, createdAt: now, updatedAt: now };
  await t.repo.createTeachingPlan(rec);
  return rec;
}

const get = (url: string, token = teacher.token) => t.inject({ method: 'GET', url: `${API}${url}`, token });
const send = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown, o: { token?: string; ifMatch?: number } = {}) =>
  t.inject({ method, url: `${API}${url}`, token: o.token ?? teacher.token, payload: payload as object, headers: o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {} });

describe('row uids and PATCH insert / remove', () => {
  it('rows stored before 0.10.0 get a deterministic uid on read and keep it on the next write', async () => {
    const plan = await makePlan(teacher.user.id, [row(1), row(2), row(3)], { legacy: true });
    const prefix = `r${plan.id.replace(/-/g, '').slice(0, 8)}`;
    const p = json(await get(`/ktp/${plan.id}`));
    expect(p.rows.map((r: KtpRow) => r.uid)).toEqual([`${prefix}_1`, `${prefix}_2`, `${prefix}_3`]);
    expect(json(await get(`/ktp/${plan.id}`)).rows[1].uid).toBe(`${prefix}_2`);
    const res = await send('PATCH', `/ktp/${plan.id}`, { version: 1, rows: [{ index: 2, uid: `${prefix}_2`, title: 'Жаңы' }] }, { ifMatch: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(((await t.repo.getTeachingPlan(plan.id))!.doc as PlanDoc).rows.map((r) => r.uid)).toEqual([`${prefix}_1`, `${prefix}_2`, `${prefix}_3`]);
    // the list and the summary still answer (the contract requires uids everywhere)
    expect((await get('/ktp')).statusCode).toBe(200);
  });

  it('a row patch whose uid is not the row at its index is a conflict (409)', async () => {
    const plan = await makePlan(teacher.user.id, [row(1), row(2)]);
    const res = await send('PATCH', `/ktp/${plan.id}`, { version: 1, rows: [{ index: 1, uid: (plan.doc as PlanDoc).rows[1].uid, title: 'X' }] }, { ifMatch: 1 });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('version_mismatch');
  });

  it('remove by uid, insert after a uid (null = start); rows re-indexed, uids stable, removed content deleted', async () => {
    const rows = [row(1, { section: { title: 'А' } }), row(2, { section: { title: 'Б' } }), row(3, { section: { title: 'Б' } })];
    const plan = await makePlan(teacher.user.id, rows);
    await send('PUT', `/ktp/${plan.id}/lessons/${rows[1].uid}`, { modelId: '5e', stages: {}, goals: { knowledge: { goal: 'x', result: '' }, development: { goal: '', result: '' }, upbringing: { goal: '', result: '' } }, materials: [] });
    expect(await t.repo.getLessonContent(plan.id, rows[1].uid)).not.toBeNull();
    const res = await send(
      'PATCH',
      `/ktp/${plan.id}`,
      { version: 1, remove: [rows[1].uid], insert: [{ afterUid: rows[2].uid, title: 'Кайталоо' }, { afterUid: null, title: 'Киришүү', hours: 2 }, { afterUid: rows[0].uid, title: 'СОР №1' }] },
      { ifMatch: 1 },
    );
    expect(res.statusCode, res.body).toBe(200);
    const p = json(res);
    expect(p.rows.map((r: KtpRow) => [r.index, r.title, r.section?.title])).toEqual([
      [1, 'Киришүү', 'А'],
      [2, 'Сабак 1', 'А'],
      [3, 'СОР №1', 'А'],
      [4, 'Сабак 3', 'Б'],
      [5, 'Кайталоо', 'Б'],
    ]);
    expect(p.rows[1].uid).toBe(rows[0].uid);
    expect(p.rows[3].uid).toBe(rows[2].uid);
    expect(p.rows[2].type).toBe('sor');
    expect(p.rows[0].hours).toBe(2);
    expect(p.rows.every((r: KtpRow) => /^[A-Za-z0-9_-]{4,40}$/.test(r.uid))).toBe(true);
    expect(await t.repo.getLessonContent(plan.id, rows[1].uid)).toBeNull();
    expect((await send('PATCH', `/ktp/${plan.id}`, { version: 2, remove: ['r_nope1'] }, { ifMatch: 2 })).statusCode).toBe(400);
    expect((await send('PATCH', `/ktp/${plan.id}`, { version: 2, insert: [{ afterUid: 'r_nope1', title: 'x' }] }, { ifMatch: 2 })).statusCode).toBe(400);
  });
});

describe('GET /calendar, POST /ktp/:id/schedule', () => {
  it('the calendar of the current school year (Bishkek) or of a given year', async () => {
    expect(json(await get('/calendar'))).toMatchObject({ year: 2026, start: '2026-09-02', quarters: [{ n: 1 }, {}, {}, {}] });
    expect(json(await get('/calendar?year=2030')).start).toBe('2030-09-02');
    expect((await t.inject({ method: 'GET', url: `${API}/calendar` })).statusCode).toBe(401);
  });

  it('places the lessons on the lesson days, saves the days, bumps the version and checks the quarter hours', async () => {
    const plan = await makePlan(teacher.user.id, Array.from({ length: 12 }, (_, i) => row(i + 1)));
    const weekdays = { '1': 1, '4': 2 };
    const res = await send('POST', `/ktp/${plan.id}/schedule`, { version: 1, class: '7а', weekdays, mode: 'all' }, { ifMatch: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const p = json(res);
    const slots = studySlots(schoolCalendar(2026), weekdays);
    expect(p.rows.map((r: KtpRow) => r.dates['7А'])).toEqual(slots.slice(0, 12).map((s) => s.date));
    expect(p).toMatchObject({ version: 2, schedule: { '7А': weekdays } });
    const need = quarterHours(schoolCalendar(2026), weekdays);
    expect(p.issues.filter((i: { code: string }) => i.code === 'quarter_hours_short')).toContainEqual({ code: 'quarter_hours_short', severity: 'warning', class: '7А', params: { quarter: 1, planned: 12, need: need[0], class: '7А' } });
    // stale version, a class not of the plan, another teacher
    expect((await send('POST', `/ktp/${plan.id}/schedule`, { version: 1, class: '7А', weekdays, mode: 'all' }, { ifMatch: 1 })).statusCode).toBe(409);
    expect((await send('POST', `/ktp/${plan.id}/schedule`, { version: 2, class: '9Б', weekdays, mode: 'all' }, { ifMatch: 2 })).statusCode).toBe(400);
    expect((await send('POST', `/ktp/${plan.id}/schedule`, { version: 2, class: '7А', weekdays, mode: 'all' }, { ifMatch: 2, token: other.token })).statusCode).toBe(404);
    expect((await send('POST', `/ktp/${plan.id}/schedule`, { version: 2, class: '7А', weekdays, mode: 'all' })).statusCode).toBe(428);
  });

  it('assessments add СОР / СОЧ rows and fill the year; hours and the title follow the scheduled rows', async () => {
    const plan = await makePlan(teacher.user.id, Array.from({ length: 20 }, (_, i) => row(i + 1, { section: { title: 'Кинематика', hours: 20 } })), { title: 'Физика, 7-класс: календардык-тематикалык план (алдын ала)' });
    const res = await send('POST', `/ktp/${plan.id}/schedule`, { version: 1, class: '7А', weekdays: { '2': 1 }, mode: 'all', assessments: true }, { ifMatch: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const p = json(res);
    expect(p.rows).toHaveLength(studySlots(schoolCalendar(2026), { '2': 1 }).length);
    expect(p.rows.filter((r: KtpRow) => r.type === 'soch')).toHaveLength(4);
    expect(p.issues.some((i: { code: string }) => i.code === 'quarter_hours_short')).toBe(false);
    expect(p.issues.map((i: { code: string }) => i.code)).not.toContain('section_hours_mismatch');
    expect(p.issues.map((i: { code: string }) => i.code)).not.toContain('hours_mismatch');
    expect(p).toMatchObject({ declaredHours: p.rows.length, totalHours: p.rows.length, title: 'Физика, 7-класс: календардык-тематикалык план' });
    expect(p.rows[0].section).toEqual({ title: 'Кинематика', hours: p.rows.length });
  });
});

const goals = { knowledge: { goal: '', result: '' }, development: { goal: 'Ой жүгүртүүнү өнүктүрүү', result: '' }, upbringing: { goal: '', result: '' } };
const lessonBody = (extra: Record<string, unknown> = {}) => ({
  modelId: '5e',
  stages: { '5e:engage': { teacher: 'Мугалим суроо берет: эмне үчүн?', pupil: 'Окуучулар божомолдошот', minutes: 7, attachments: ['m1'] } },
  goals,
  materials: [
    { id: 'm1', kind: 'examples', text: 'Поезд 2 саатта 120 км жүрөт', on: true, source: 'teacher' },
    { id: 'm2', kind: 'tests', text: 'Ылдамдыктын бирдиги?\na) м/с\nb) кг', on: true, source: 'ai' },
    { id: 'm3', kind: 'slides', text: 'Ылдамдык\nv = s / t\nБирдиги: м/с', on: true, source: 'ai' },
    { id: 'm4', kind: 'stem', text: 'Тандалбаган тапшырма', on: false, source: 'ai' },
  ],
  ...extra,
});

describe('lesson pages: GET / PUT / conducted', () => {
  it('defaults before anything is saved; 404 for a uid that is not a row and for another teacher', async () => {
    const plan = await makePlan(teacher.user.id, [row(1), row(2)]);
    const uid = (plan.doc as PlanDoc).rows[0].uid;
    const res = await get(`/ktp/${plan.id}/lessons/${uid}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toEqual({ planId: plan.id, uid, modelId: null, stages: {}, goals: { knowledge: { goal: '', result: '' }, development: { goal: '', result: '' }, upbringing: { goal: '', result: '' } }, materials: [], conducted: {}, version: 0, updatedAt: null });
    expect((await get(`/ktp/${plan.id}/lessons/r_nope1`)).statusCode).toBe(404);
    expect((await get(`/ktp/${plan.id}/lessons/${uid}`, other.token)).statusCode).toBe(404);
  });

  it('PUT saves (version + 1, the КТП version unchanged), checks the version and the references', async () => {
    const plan = await makePlan(teacher.user.id, [row(1)]);
    const uid = (plan.doc as PlanDoc).rows[0].uid;
    const url = `/ktp/${plan.id}/lessons/${uid}`;
    const r1 = await send('PUT', url, lessonBody({ version: 0 }));
    expect(r1.statusCode, r1.body).toBe(200);
    expect(json(r1)).toMatchObject({ version: 1, modelId: '5e', materials: [{ id: 'm1' }, {}, {}, {}] });
    expect(json(r1).updatedAt).toBeTruthy();
    expect((await send('PUT', url, lessonBody({ version: 0 }))).statusCode).toBe(409);
    expect((await send('PUT', url, lessonBody(), { ifMatch: 0 })).statusCode).toBe(409);
    expect(json(await send('PUT', url, lessonBody({ version: 1 }))).version).toBe(2);
    expect(json(await send('PUT', url, lessonBody())).version).toBe(3); // no version: last write wins
    expect((await t.repo.getTeachingPlan(plan.id))!.version).toBe(1);
    const badAttach = await send('PUT', url, lessonBody({ stages: { '5e:engage': { teacher: '', pupil: '', minutes: null, attachments: ['nope'] } } }));
    expect(badAttach.statusCode).toBe(400);
    const badStage = await send('PUT', url, lessonBody({ stages: { '5e:catch': { teacher: '', pupil: '', minutes: null, attachments: [] } } }));
    expect(badStage.statusCode).toBe(400);
    expect((await send('PUT', url, lessonBody({ stages: { '3c1e:catch': { teacher: 'ok', pupil: '', minutes: null, attachments: [] } } }))).statusCode).toBe(200);
    expect(json(await get(url))).toMatchObject({ version: 4, stages: { '3c1e:catch': { teacher: 'ok' } } });
  });

  it('conducted: marks and unmarks a class; the class must be one of the plan', async () => {
    const plan = await makePlan(teacher.user.id, [row(1)]);
    const uid = (plan.doc as PlanDoc).rows[0].uid;
    const url = `/ktp/${plan.id}/lessons/${uid}/conducted`;
    const on = await send('POST', url, { class: '7а', conducted: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(json(on)).toMatchObject({ conducted: { '7А': t.clock.now().toISOString() }, version: 1, modelId: null });
    expect(json(await send('POST', url, { class: '7А', conducted: false })).conducted).toEqual({});
    expect((await send('POST', url, { class: '8Б', conducted: true })).statusCode).toBe(400);
  });
});

describe('the lesson plan .docx and the slides from the lesson page', () => {
  it('stages of the model with the teacher text, attachments, minutes, goals and the materials appendix', async () => {
    const plan = await makePlan(teacher.user.id, [row(1, { dates: { '7А': '2026-10-15' }, topicKey: 'speed' }), row(2)]);
    const [a, b] = (plan.doc as PlanDoc).rows;
    await send('PUT', `/ktp/${plan.id}/lessons/${a.uid}`, lessonBody());
    const res = await get(`/ktp/${plan.id}/lessons/1/plan?class=7А`);
    expect(res.statusCode, res.body).toBe(200);
    const text = dumpDocx(res.rawPayload).join('\n');
    expect(text).toContain('1. Engage — Кызыктыруу / Тартуу');
    expect(text).toContain('7 мүнөт');
    expect(text).toContain('Мугалим суроо берет: эмне үчүн?');
    expect(text).toContain('• Мисал: Поезд 2 саатта 120 км жүрөт');
    expect(text).toContain('Окуучулар божомолдошот');
    expect(text).toContain('Ой жүгүртүүнү өнүктүрүү');
    expect(text).toContain('3D-модель');
    // empty stages use the model's hints
    expect(text).toContain('Тапшырманы жана материалдарды бериңиз, жоопту айтпаңыз');
    expect(text).toContain('Тиркеме: сабактын материалдары');
    expect(text).toContain('Тест суроолору');
    expect(text).toContain('Ылдамдыктын бирдиги?');
    expect(text).not.toContain('Тандалбаган тапшырма');
    // a lesson without saved content: the plan as before
    const plain = dumpDocx((await get(`/ktp/${plan.id}/lessons/2/plan?class=7А`)).rawPayload).join('\n');
    expect(plain).not.toContain('Тиркеме');
    expect(plain).toContain('Уюштуруу');
    // the range: both
    const both = dumpDocx((await get(`/ktp/${plan.id}/plans?class=7А&from=1&to=2`)).rawPayload).join('\n');
    expect(both).toContain('Тиркеме: сабактын материалдары');
    expect(b.uid).toBeTruthy();
  });

  it('the owner’s default model fills a lesson saved without one', async () => {
    const plan = await makePlan(teacher.user.id, [row(1)]);
    await t.repo.updateUser(teacher.user.id, { defaultLessonModel: 'pemB' });
    await send('PUT', `/ktp/${plan.id}/lessons/${(plan.doc as PlanDoc).rows[0].uid}`, { modelId: null, stages: {}, goals, materials: [] });
    const text = dumpDocx((await get(`/ktp/${plan.id}/lessons/1/plan?class=7А`)).rawPayload).join('\n');
    await t.repo.updateUser(teacher.user.id, { defaultLessonModel: null });
    expect(text).toMatch(/1\. \S+ — /);
    expect(text).not.toContain('Engage');
  });

  it('GET …/slides: a .pptx with the title, the stages, the slides, the questions and the homework', async () => {
    const plan = await makePlan(teacher.user.id, [row(1, { title: 'Ылдамдык', homework: '§ 5', dates: { '7А': '2026-10-15' } })]);
    const uid = (plan.doc as PlanDoc).rows[0].uid;
    await send('PUT', `/ktp/${plan.id}/lessons/${uid}`, lessonBody());
    const res = await get(`/ktp/${plan.id}/lessons/${uid}/slides?class=7А`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('presentationml');
    const zip = new PizZip(res.rawPayload);
    const slides = zip.file(/^ppt\/slides\/slide\d+\.xml$/);
    const text = slides.map((f) => f.asText()).join('\n');
    expect(text).toContain('Ылдамдык');
    expect(text).toContain('15.10.2026');
    expect(text).toContain('v = s / t');
    expect(text).toContain('Суроолор');
    expect(text).toContain('§ 5');
    // ticked slides = the teacher's deck: no per-stage slides
    expect(text).not.toContain('Engage');
    expect(slides.length).toBe(1 + 1 + 1 + 1);
    // without ticked slides: one slide per stage of the model
    await send('PUT', `/ktp/${plan.id}/lessons/${uid}`, lessonBody({ materials: lessonBody().materials.map((m) => (m.kind === 'slides' ? { ...m, on: false } : m)) }));
    const staged = new PizZip((await get(`/ktp/${plan.id}/lessons/${uid}/slides?class=7А`)).rawPayload).file(/^ppt\/slides\/slide\d+\.xml$/);
    const stagedText = staged.map((f) => f.asText()).join('\n');
    expect(stagedText).toContain('Engage — Кызыктыруу / Тартуу');
    expect(stagedText).toContain('Мугалим суроо берет');
    expect(stagedText).not.toContain('v = s / t');
    expect(staged.length).toBe(1 + 5 + 1 + 1);
    expect((await get(`/ktp/${plan.id}/lessons/${uid}/slides?class=9В`)).statusCode).toBe(400);
  });
});

describe('POST /ktp/:id/lessons/:uid/assist', () => {
  it('materials (new, not repeated, at most count), ask, draft keyed by model stage', async () => {
    const plan = await makePlan(teacher.user.id, [row(1, { title: 'Ылдамдык жана анын бирдиктери', topicKey: 'speed' })]);
    const url = `/ktp/${plan.id}/lessons/${(plan.doc as PlanDoc).rows[0].uid}/assist`;
    const m = await send('POST', url, { task: 'materials', kind: 'examples', count: 3, exclude: ['Эски мисал'] });
    expect(m.statusCode, m.body).toBe(200);
    expect(json(m)).toEqual({ task: 'materials', kind: 'examples', items: ['Мисал 1: 36 км/саат = 10 м/с', 'Мисал 2'] });
    const call = provider.generateCalls.at(-1)!;
    expect(call.prompt).toContain('Lesson topic: Ылдамдык жана анын бирдиктери');
    expect(call.prompt).toContain('Bilig topic:');
    expect(call.prompt).toContain('Эски мисал');
    expect(json(await send('POST', url, { task: 'ask', question: 'Кантип баштайм?', history: [{ role: 'teacher', text: 'Салам' }] }))).toEqual({ task: 'ask', answer: 'Топтордо өлчөө жүргүзүңүз.' });
    const d = json(await send('POST', url, { task: 'draft', modelId: '5e' }));
    expect(d.task).toBe('draft');
    expect(Object.keys(d.stages)).toEqual(['5e:engage', '5e:explore', '5e:explain', '5e:elaborate', '5e:evaluate']);
    expect(d.stages['5e:engage']).toEqual({ teacher: 'Суроо берет', pupil: 'Жооп беришет' });
    expect(d.goals.knowledge).toEqual({ goal: 'Ылдамдыкты билет', result: 'Эсептей алат' });
  });

  it(`503 without the online assistant; ${LESSON_ASSIST_PER_HOUR} requests per teacher and hour`, async () => {
    const off = await makeTestApp({ tutor: null });
    const w = await makeSchoolWorld(off.deps);
    const doc = recheck({ title: 'x', subjectName: 'x', subjectKey: null, grade: 7, lang: 'ky', teacherName: '', schoolName: '', year: 2026, classes: ['7А'], declaredHours: null, rows: [row(1)], sourceName: 'x', invalidDates: {} });
    const rec = { id: newId(), ownerId: w.teacher.user.id, title: 'x', doc, version: 1, createdAt: off.clock.now(), updatedAt: off.clock.now() };
    await off.repo.createTeachingPlan(rec);
    const res = await off.inject({ method: 'POST', url: `${API}/ktp/${rec.id}/lessons/${doc.rows[0].uid}/assist`, token: w.teacher.token, payload: { task: 'ask', question: 'x' } });
    expect(res.statusCode).toBe(503);
    expect(json(res).code).toBe('tutor_unavailable');
    await off.close();

    const u = await makeUser(t.deps, { role: 'teacher', scopeId: world.school.id });
    const plan = await makePlan(u.user.id, [row(1)]);
    const url = `/ktp/${plan.id}/lessons/${(plan.doc as PlanDoc).rows[0].uid}/assist`;
    for (let i = 0; i < LESSON_ASSIST_PER_HOUR; i++) expect((await send('POST', url, { task: 'ask', question: 'x' }, { token: u.token })).statusCode).toBe(200);
    expect((await send('POST', url, { task: 'ask', question: 'x' }, { token: u.token })).statusCode).toBe(429);
  });
});

describe('GET /ktp/:id/docx heading', () => {
  it('«(алдын ала)» while a plan from a textbook / the standard is not scheduled; never for an upload', async () => {
    const heading = async (id: string) => dumpDocx((await get(`/ktp/${id}/docx`)).rawPayload).join('\n');
    const plan = await makePlan(teacher.user.id, [row(1), row(2)]);
    await t.repo.updateTeachingPlan(plan.id, { doc: { ...(plan.doc as PlanDoc), origin: 'textbook' } }, 1);
    expect(await heading(plan.id)).toContain('календардык-тематикалык планы (алдын ала)');
    expect((await send('POST', `/ktp/${plan.id}/schedule`, { version: 2, class: '7А', weekdays: { '1': 1 }, mode: 'all' }, { ifMatch: 2 })).statusCode).toBe(200);
    const after = await heading(plan.id);
    expect(after).toContain('календардык-тематикалык планы');
    expect(after).not.toContain('алдын ала');
    const upload = await makePlan(teacher.user.id, [row(1)]);
    await t.repo.updateTeachingPlan(upload.id, { doc: { ...(upload.doc as PlanDoc), origin: 'upload' } }, 1);
    expect(await heading(upload.id)).not.toContain('алдын ала');
  });
});

describe('POST /ktp/from-standard', () => {
  it('the assistant drafts the chapters; the textbook pipeline fits them to the hours (origin standard)', async () => {
    const res = await send('POST', '/ktp/from-standard', { subjectKey: 'phys', grade: 7, hoursPerWeek: 1, weeks: 10, classes: ['7а'] });
    expect(res.statusCode, res.body).toBe(200);
    const p = json(res);
    expect(p).toMatchObject({ origin: 'standard', subjectKey: 'phys', grade: 7, classes: ['7А'], lang: 'ky', classLinks: { '7А': cls.id } });
    // topic lessons leave room for the assessments: 10 hours − 4 СОЧ − 2·4 СОР, at least 60 %
    expect(p.rows).toHaveLength(standardLessons(10));
    expect(standardLessons(68)).toBe(56);
    expect(p.rows.map((r: KtpRow) => r.title)).toContain('Лабораториялык иш: Ылдамдыкты өлчөө');
    expect(p.rows.filter((r: KtpRow) => r.type === 'test').length).toBeGreaterThan(0);
    expect(p.rows[0].section.title).toBe('I глава. Механикалык кыймыл');
    expect(p.rows.every((r: KtpRow) => r.uid)).toBe(true);
    const call = provider.generateCalls.at(-1)!;
    expect(call.prompt).toContain('grade 7');
    expect(call.prompt).toContain(`Plan ${standardLessons(10)} lessons`);
    expect((await send('POST', '/ktp/from-standard', { subjectKey: 'nope', grade: 7, hoursPerWeek: 1 })).statusCode).toBe(400);
    expect((await send('POST', '/ktp/from-standard', { subjectKey: 'phys', grade: 7, hoursPerWeek: 1 }, { token: world.students[0].token })).statusCode).toBe(403);
  });

  it('503 when the assistant is offline', async () => {
    const off = await makeTestApp({ seed: false, tutor: null });
    await importContent(off.repo, off.clock, loadContentDir(), off.deps.config);
    const w = await makeSchoolWorld(off.deps);
    const res = await off.inject({ method: 'POST', url: `${API}/ktp/from-standard`, token: w.teacher.token, payload: { subjectKey: 'phys', grade: 7, hoursPerWeek: 2 } });
    expect(res.statusCode).toBe(503);
    expect(json(res).code).toBe('tutor_unavailable');
    await off.close();
  }, 60_000);
});

describe('GET /teacher/agenda', () => {
  it('lessons by date then plan, conducted marks, and «Требует внимания»', async () => {
    const t2 = await makeTestApp({ seed: false });
    await importContent(t2.repo, t2.clock, loadContentDir(), t2.deps.config);
    const w = await makeSchoolWorld(t2.deps);
    await t2.repo.updateClass(w.cls.id, { subjectKeys: ['phys', 'bio'] });
    const mk = async (rows: KtpRow[], o: { title: string; subjectKey?: string | null }) => {
      const doc = recheck({ title: o.title, subjectName: 'Физика', subjectKey: o.subjectKey === undefined ? 'phys' : o.subjectKey, grade: 7, lang: 'ky', teacherName: '', schoolName: '', year: 2026, classes: ['7А'], classLinks: { '7А': w.cls.id }, declaredHours: null, rows, sourceName: 'x', invalidDates: {} });
      const rec = { id: newId(), ownerId: w.teacher.user.id, title: o.title, doc, version: 1, createdAt: t2.clock.now(), updatedAt: t2.clock.now() };
      await t2.repo.createTeachingPlan(rec);
      return rec;
    };
    // today = 2026-10-15 (Bishkek)
    const physics = await mk([row(1, { dates: { '7А': '2026-10-14' } }), row(2, { dates: { '7А': '2026-10-15' } }), row(3, { dates: { '7А': '2026-10-19' } }), row(4, { dates: { '7А': '2026-10-30' } })], { title: 'Б физика' });
    await mk([row(1, { title: '', dates: { '7А': '2026-10-15' } })], { title: 'А геометрия', subjectKey: 'math' });
    const uid2 = (physics.doc as PlanDoc).rows[1].uid;
    await t2.inject({ method: 'POST', url: `${API}/ktp/${physics.id}/lessons/${uid2}/conducted`, token: w.teacher.token, payload: { class: '7А', conducted: true } });
    // an assignment due tomorrow nobody has done; one due in 10 days
    const now = t2.clock.now().getTime();
    await t2.repo.createAssignment({ id: newId(), classId: w.cls.id, topicKey: 'speed', activities: ['quiz'], dueAt: new Date(now + 86400_000), createdBy: w.teacher.user.id, createdAt: t2.clock.now(), title: 'Ылдамдык боюнча тест' });
    await t2.repo.createAssignment({ id: newId(), classId: w.cls.id, topicKey: 'speed', activities: ['quiz'], dueAt: new Date(now + 10 * 86400_000), createdBy: w.teacher.user.id, createdAt: t2.clock.now() });

    const res = await t2.inject({ method: 'GET', url: `${API}/teacher/agenda`, token: w.teacher.token });
    expect(res.statusCode, res.body).toBe(200);
    const a = json(res);
    expect(a).toMatchObject({ today: '2026-10-15', from: '2026-10-15', to: '2026-10-22' });
    expect(a.lessons.map((l: { date: string; index: number; subjectKey: string }) => [l.date, l.subjectKey, l.index])).toEqual([
      ['2026-10-15', 'math', 1],
      ['2026-10-15', 'phys', 2],
      ['2026-10-19', 'phys', 3],
    ]);
    expect(a.lessons[1]).toMatchObject({ planId: physics.id, uid: uid2, class: '7А', classId: w.cls.id, title: 'Сабак 2', section: 'Кинематика', conducted: true, type: 'new', hours: 1 });
    expect(a.lessons[2].conducted).toBe(false);
    const kinds = a.attention.map((x: { kind: string }) => x.kind);
    expect(a.attention.find((x: { kind: string }) => x.kind === 'ktp_issues')).toMatchObject({ classId: w.cls.id, class: '7А', subjectKey: 'math', errors: 1 });
    expect(a.attention.filter((x: { kind: string }) => x.kind === 'no_ktp')).toEqual([{ kind: 'no_ktp', classId: w.cls.id, className: '7А', subjectKey: 'bio' }]);
    expect(a.attention.filter((x: { kind: string }) => x.kind === 'assignment_due')).toEqual([
      { kind: 'assignment_due', assignmentId: expect.any(String), classId: w.cls.id, className: '7А', title: 'Ылдамдык боюнча тест', done: 0, total: 2, dueAt: new Date(now + 86400_000).toISOString() },
    ]);
    expect(kinds).toHaveLength(3);
    // a range; more than 31 days is refused
    const range = json(await t2.inject({ method: 'GET', url: `${API}/teacher/agenda?from=2026-10-14&to=2026-10-31`, token: w.teacher.token }));
    expect(range.lessons).toHaveLength(5);
    expect((await t2.inject({ method: 'GET', url: `${API}/teacher/agenda?from=2026-10-01&to=2026-11-15`, token: w.teacher.token })).statusCode).toBe(400);
    expect((await t2.inject({ method: 'GET', url: `${API}/teacher/agenda?from=2026-10-15&to=2026-10-01`, token: w.teacher.token })).statusCode).toBe(400);
    expect((await t2.inject({ method: 'GET', url: `${API}/teacher/agenda`, token: w.students[0].token })).statusCode).toBe(403);
    await t2.close();
  }, 60_000);
});

describe('assignment summaries, Student.lastSeenAt', () => {
  it('displayTitle, subjectKey, done / total and the average; title and lesson are kept', async () => {
    const plan = await makePlan(teacher.user.id, [row(1)]);
    const uid = (plan.doc as PlanDoc).rows[0].uid;
    const created = await send('POST', `/classes/${cls.id}/assignments`, { topicKey: 'speed', activities: ['quiz'], title: 'Сабактан тапшырма', lesson: { planId: plan.id, uid } });
    expect(created.statusCode, created.body).toBe(200);
    expect(json(created)).toMatchObject({ title: 'Сабактан тапшырма', lesson: { planId: plan.id, uid } });
    expect((await send('POST', `/classes/${cls.id}/assignments`, { topicKey: 'speed', activities: ['quiz'], lesson: { planId: plan.id, uid: 'r_nope1' } })).statusCode).toBe(400);
    const otherPlan = await makePlan(other.user.id, [row(1)]);
    expect((await send('POST', `/classes/${cls.id}/assignments`, { topicKey: 'speed', activities: ['quiz'], lesson: { planId: otherPlan.id, uid: (otherPlan.doc as PlanDoc).rows[0].uid } })).statusCode).toBe(400);
    const plain = json(await send('POST', `/classes/${cls.id}/assignments`, { topicKey: 'speed', activities: ['quiz'] }));
    // one student finished the titled assignment with 0.5
    const [s1] = world.students;
    const a = json(created);
    await t.repo.createAttempt({ id: newId(), userId: s1.user.id, clientId: newId(), assignmentId: a.id, topicKey: 'speed', topicVersion: '1.0.0', topicVersionId: newId(), seed: 's', itemKeys: [], startedAt: t.clock.now(), finishedAt: t.clock.now(), score: 0.5, source: 'online' });
    const list = json(await get(`/classes/${cls.id}/assignments`));
    const mine = list.items.find((x: { id: string }) => x.id === a.id);
    expect(mine).toMatchObject({ displayTitle: 'Сабактан тапшырма', subjectKey: 'phys', done: 1, totalStudents: 2, averageScore: 0.5 });
    const p = list.items.find((x: { id: string }) => x.id === plain.id);
    expect(p).toMatchObject({ done: 0, totalStudents: 2, averageScore: null });
    expect(p.displayTitle).not.toBe('speed');
    expect(p).not.toHaveProperty('title');
  });

  it('students carry their last sign-in', async () => {
    const st = await makeStudent(t.deps, cls.id, 'Жаңы окуучу');
    await t.repo.updateUser(st.user.id, { lastLoginAt: new Date('2026-10-14T05:00:00Z') });
    const items = json(await get(`/classes/${cls.id}/students`)).items;
    expect(items.find((s: { id: string }) => s.id === st.user.id).lastSeenAt).toBe('2026-10-14T05:00:00.000Z');
    expect(items.find((s: { id: string }) => s.id === world.students[1].user.id).lastSeenAt).toBeNull();
  });
});

describe('Me: defaultLessonModel, region, schoolName', () => {
  it('teachers get and set their default lesson model; others cannot', async () => {
    const u = await makeUser(t.deps, { role: 'teacher', scopeId: world.school.id });
    const me = json(await get('/me', u.token));
    expect(me).toMatchObject({ defaultLessonModel: '5e', region: 'Бишкек', schoolName: 'Школа №1' });
    const res = await send('PATCH', '/me', { defaultLessonModel: 'pemA' }, { token: u.token });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res).defaultLessonModel).toBe('pemA');
    expect(json(await get('/me', u.token)).defaultLessonModel).toBe('pemA');
    expect((await send('PATCH', '/me', { defaultLessonModel: 'zzz' }, { token: u.token })).statusCode).toBe(400);
    const student = world.students[0];
    expect(json(await get('/me', student.token))).not.toHaveProperty('defaultLessonModel');
    expect((await send('PATCH', '/me', { defaultLessonModel: '5e' }, { token: student.token })).statusCode).toBe(403);
    const admin = await makeUser(t.deps, { role: 'school_admin', scopeId: world.school.id });
    expect(json(await get('/me', admin.token))).not.toHaveProperty('defaultLessonModel');
  });
});
