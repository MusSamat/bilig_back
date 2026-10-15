/** Admin dictionary CRUD: If-Match, validation, in_use, usage, stats, audit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import { API, json, makeTestApp, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';

let t: TestCtx;
let w: AdminWorld;
beforeAll(async () => {
  t = await makeTestApp();
  w = await makeAdminWorld(t);
});
afterAll(() => t.close());

const nucleus = () => structuredClone(animalCellPackage.concepts.find((c) => c.key === 'bio.nucleus')!);

describe('admin dictionary CRUD', () => {
  it('PATCH without If-Match → 428, stale If-Match → 409, body.version mismatch → 400', async () => {
    const tok = w.editor.adminToken;
    const v0 = (await t.repo.content('concept').get('bio.nucleus'))!.version;
    const r1 = await t.inject({ method: 'PATCH', url: `${API}/admin/concepts/bio.nucleus`, token: tok, payload: { hue: 11, version: 1 } });
    expect(r1.statusCode).toBe(428);
    expect(json(r1).code).toBe('precondition_required');
    const r2 = await t.inject({ method: 'PATCH', url: `${API}/admin/concepts/bio.nucleus`, token: tok, headers: { 'if-match': '"99"' }, payload: { hue: 11, version: 99 } });
    expect(r2.statusCode).toBe(409);
    expect(json(r2).code).toBe('version_mismatch');
    const r3 = await t.inject({ method: 'PATCH', url: `${API}/admin/concepts/bio.nucleus`, token: tok, headers: { 'if-match': String(v0) }, payload: { hue: 11, version: v0 + 1 } });
    expect(r3.statusCode).toBe(400);
    const ok = await t.inject({ method: 'PATCH', url: `${API}/admin/concepts/bio.nucleus`, token: tok, headers: { 'if-match': String(v0) }, payload: { hue: 11, version: v0 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json(ok)).toMatchObject({ version: v0 + 1, data: { key: 'bio.nucleus', hue: 11 } });
    expect(ok.headers.etag).toBe(`"${v0 + 1}"`);
    // the old version is now stale
    const again = await t.inject({ method: 'PATCH', url: `${API}/admin/concepts/bio.nucleus`, token: tok, headers: { 'if-match': String(v0) }, payload: { hue: 12, version: v0 } });
    expect(again.statusCode).toBe(409);
  });

  it('the merged document is validated with the full schema', async () => {
    const v = (await t.repo.content('concept').get('bio.nucleus'))!.version;
    const r = await t.inject({ method: 'PATCH', url: `${API}/admin/concepts/bio.nucleus`, token: w.editor.adminToken, headers: { 'if-match': String(v) }, payload: { hue: 999, version: v } });
    expect(r.statusCode).toBe(400);
    expect(json(r).code).toBe('validation_failed');
  });

  it('create: 409 on an existing key; a new concept is listed and deletable; audit entries are written', async () => {
    const tok = w.author.adminToken;
    expect((await t.inject({ method: 'POST', url: `${API}/admin/concepts`, token: tok, payload: nucleus() })).statusCode).toBe(409);
    const fresh = { ...nucleus(), key: 'bio.ribosome', related: [], title: { ky: 'Рибосома', ru: 'Рибосома', en: 'Ribosome' } };
    const c = await t.inject({ method: 'POST', url: `${API}/admin/concepts`, token: tok, payload: fresh });
    expect(c.statusCode, c.body).toBe(200);
    expect(json(c).version).toBe(1);
    const list = json(await t.inject({ method: 'GET', url: `${API}/admin/concepts?q=ribos`, token: tok }));
    expect(list.items.map((x: { data: { key: string } }) => x.data.key)).toEqual(['bio.ribosome']);
    const other = await t.inject({ method: 'POST', url: `${API}/admin/concepts`, token: w.authorOther.adminToken, payload: { ...fresh, key: 'bio.lysosome' } });
    expect(other.statusCode).toBe(403);
    const del = await t.inject({ method: 'DELETE', url: `${API}/admin/concepts/bio.ribosome`, token: tok, headers: { 'if-match': '1' } });
    expect(del.statusCode, del.body).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/admin/concepts/bio.ribosome`, token: tok })).statusCode).toBe(404);
    const audit = (await t.repo.listAudit({ targetType: 'concept' }, { limit: 100 })).items.map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['content.created', 'content.deleted']));
  });

  it('deleting a used concept → 409 in_use; usage lists the topics', async () => {
    const tok = w.editor.adminToken;
    const usage = json(await t.inject({ method: 'GET', url: `${API}/admin/concepts/bio.membrane/usage`, token: tok }));
    expect(usage.topicKeys).toEqual(['animal-cell', 'demo-cell']);
    const v = (await t.repo.content('concept').get('bio.membrane'))!.version;
    const r = await t.inject({ method: 'DELETE', url: `${API}/admin/concepts/bio.membrane`, token: tok, headers: { 'if-match': String(v) } });
    expect(r.statusCode).toBe(409);
    expect(json(r).code).toBe('in_use');
    expect(await t.repo.content('concept').get('bio.membrane')).not.toBeNull();
  });

  it('subjects need platform.manage; deleting a subject with courses → in_use', async () => {
    const sub = { key: 'phys', title: { ky: 'Физика', ru: 'Физика', en: 'Physics' }, icon: 'atom', hue: 30, group: 'exact', order: 5, status: 'soon' };
    expect((await t.inject({ method: 'POST', url: `${API}/admin/subjects`, token: w.editor.adminToken, payload: sub })).statusCode).toBe(403);
    const c = await t.inject({ method: 'POST', url: `${API}/admin/subjects`, token: w.superadmin.adminToken, payload: sub });
    expect(c.statusCode, c.body).toBe(200);
    const p = await t.inject({ method: 'PATCH', url: `${API}/admin/subjects/phys`, token: w.superadmin.adminToken, headers: { 'if-match': '1' }, payload: { status: 'live', version: 1 } });
    expect(json(p).data.status).toBe('live');
    const bio = (await t.repo.content('subject').get('bio'))!;
    const d = await t.inject({ method: 'DELETE', url: `${API}/admin/subjects/bio`, token: w.superadmin.adminToken, headers: { 'if-match': String(bio.version) } });
    expect(json(d).code).toBe('in_use');
    const dp = await t.inject({ method: 'DELETE', url: `${API}/admin/subjects/phys`, token: w.superadmin.adminToken, headers: { 'if-match': '2' } });
    expect(dp.statusCode).toBe(200);
  });

  it('courses/units/objectives are scoped to their subject', async () => {
    const course = { key: 'bio.g8', subjectKey: 'bio', grade: 8, curriculum: 'kg-2024', title: { ky: 'Биология 8', ru: 'Биология 8', en: 'Biology 8' } };
    expect((await t.inject({ method: 'POST', url: `${API}/admin/courses`, token: w.authorOther.adminToken, payload: course })).statusCode).toBe(403);
    expect((await t.inject({ method: 'POST', url: `${API}/admin/courses`, token: w.author.adminToken, payload: course })).statusCode).toBe(200);
    const unit = { key: 'bio.g8.u1', courseKey: 'bio.g8', order: 1, title: { ky: 'Бөлүм', ru: 'Раздел', en: 'Unit' } };
    expect((await t.inject({ method: 'POST', url: `${API}/admin/units`, token: w.author.adminToken, payload: unit })).statusCode).toBe(200);
    const obj = { key: 'bio.g8.u1.o1', code: 'BIO-8.1.1', unitKey: 'bio.g8.u1', text: { ky: 'Максат', ru: 'Цель', en: 'Goal' } };
    const o = await t.inject({ method: 'POST', url: `${API}/admin/objectives`, token: w.author.adminToken, payload: obj });
    expect(o.statusCode, o.body).toBe(200);
    expect((await t.repo.content('objective').get('bio.g8.u1.o1'))!.subjectKey).toBe('bio');
    const del = await t.inject({ method: 'DELETE', url: `${API}/admin/courses/bio.g8`, token: w.author.adminToken, headers: { 'if-match': '1' } });
    expect(json(del).code).toBe('in_use');
  });

  it('items: full-replace PATCH, stats from answers; glossary needs content.publish', async () => {
    const item = structuredClone(animalCellPackage.items.find((i) => i.key === 'bio.q.powerhouse')!);
    const iv = (await t.repo.content('item').get('bio.q.powerhouse'))!.version;
    const r = await t.inject({ method: 'PATCH', url: `${API}/admin/items/bio.q.powerhouse`, token: w.author.adminToken, headers: { 'if-match': String(iv) }, payload: { data: { ...item, difficulty: 4 }, version: iv } });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r).data.difficulty).toBe(4);
    const stats = json(await t.inject({ method: 'GET', url: `${API}/admin/items/bio.q.powerhouse/stats`, token: w.author.adminToken }));
    expect(stats).toEqual({ itemKey: 'bio.q.powerhouse', answers: 0, correctRate: null, avgTimeMs: null });
    const term = { id: 'g.ribosome', ky: 'рибосома', ru: 'рибосома', en: 'ribosome', forbidden: ['рибасома'] };
    expect((await t.inject({ method: 'POST', url: `${API}/admin/glossary`, token: w.author.adminToken, payload: term })).statusCode).toBe(403);
    expect((await t.inject({ method: 'POST', url: `${API}/admin/glossary`, token: w.editor.adminToken, payload: term })).statusCode).toBe(200);
    const g = await t.inject({ method: 'PATCH', url: `${API}/admin/glossary/g.ribosome`, token: w.editor.adminToken, headers: { 'if-match': '1' }, payload: { forbidden: [], version: 1 } });
    expect(json(g).data).toMatchObject({ id: 'g.ribosome', forbidden: [] });
    const list = json(await t.inject({ method: 'GET', url: `${API}/admin/glossary?q=ribos`, token: w.author.adminToken }));
    expect(list.items).toHaveLength(1);
  });
});
