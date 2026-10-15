/** RBAC matrix for the admin API, enforced at the route level (TZ §2). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, json, makeTestApp, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';

let t: TestCtx;
let w: AdminWorld;
let topicId: string;

beforeAll(async () => {
  t = await makeTestApp();
  w = await makeAdminWorld(t);
  topicId = (await t.repo.getTopicByKey('animal-cell'))!.id;
});
afterAll(() => t.close());

type Who = 'guest' | 'student' | 'teacher' | 'schoolAdmin' | 'author' | 'authorOther' | 'translator' | 'editor' | 'editorOther' | 'superadmin';
const WHO: Who[] = ['guest', 'student', 'teacher', 'schoolAdmin', 'author', 'authorOther', 'translator', 'editor', 'editorOther', 'superadmin'];
const tok = (who: Who) => (who === 'guest' ? undefined : w[who].adminToken);

async function conceptVersion() {
  return (await t.repo.content('concept').get('bio.nucleus'))!.version;
}

/** Expected outcome: 'ok' (2xx) or an HTTP status. */
type Exp = 'ok' | 401 | 403;
async function check(label: string, who: Who, exp: Exp, req: () => Promise<{ statusCode: number; body: string }>) {
  const res = await req();
  if (exp === 'ok') expect(res.statusCode, `${label} as ${who}: ${res.body}`).toBeLessThan(300);
  else expect(res.statusCode, `${label} as ${who}: ${res.body}`).toBe(exp);
}

describe('admin RBAC matrix', () => {
  it('client-audience tokens are rejected on /admin (401)', async () => {
    const r = await t.inject({ method: 'GET', url: `${API}/admin/concepts`, token: w.superadmin.token });
    expect(r.statusCode).toBe(401);
    expect(json(r).code).toBe('unauthorized');
  });

  const listConcepts: Record<Who, Exp> = { guest: 401, student: 403, teacher: 403, schoolAdmin: 403, author: 'ok', authorOther: 'ok', translator: 'ok', editor: 'ok', editorOther: 'ok', superadmin: 'ok' };
  it.each(WHO)('GET /admin/concepts as %s', async (who) => {
    await check('list concepts', who, listConcepts[who], () => t.inject({ method: 'GET', url: `${API}/admin/concepts`, token: tok(who) }));
  });

  // structure edit (hue) on a bio concept: own-subject authors/editors and superadmin only; translators may not.
  const structure: Record<Who, Exp> = { guest: 401, student: 403, teacher: 403, schoolAdmin: 403, author: 'ok', authorOther: 403, translator: 403, editor: 'ok', editorOther: 403, superadmin: 'ok' };
  it.each(WHO)('PATCH concept structure as %s', async (who) => {
    const v = await conceptVersion();
    const hue = 10 + WHO.indexOf(who);
    await check('patch hue', who, structure[who], () =>
      t.inject({ method: 'PATCH', url: `${API}/admin/concepts/bio.nucleus`, token: tok(who), headers: { 'if-match': `"${v}"` }, payload: { hue, version: v } }),
    );
  });

  it('a translator may change strings of their subject', async () => {
    const cur = (await t.repo.content('concept').get('bio.nucleus'))!;
    const r = await t.inject({
      method: 'PATCH',
      url: `${API}/admin/concepts/bio.nucleus`,
      token: w.translator.adminToken,
      headers: { 'if-match': String(cur.version) },
      payload: { title: { ...cur.data.title, en: 'Cell nucleus' }, version: cur.version },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r).data.title.en).toBe('Cell nucleus');
  });

  // publish-only actions: editor of the topic's subject and superadmin (state 409 counts as authorised)
  const publish: Record<Who, Exp | 409> = { guest: 401, student: 403, teacher: 403, schoolAdmin: 403, author: 403, authorOther: 403, translator: 403, editor: 409, editorOther: 403, superadmin: 409 };
  it.each(WHO)('POST /admin/topics/:id/approve as %s', async (who) => {
    const r = await t.inject({ method: 'POST', url: `${API}/admin/topics/${topicId}/approve`, token: tok(who), payload: {} });
    expect(r.statusCode, `${who}: ${r.body}`).toBe(publish[who]);
  });

  const platform: Record<Who, Exp> = { guest: 401, student: 403, teacher: 403, schoolAdmin: 403, author: 403, authorOther: 403, translator: 403, editor: 403, editorOther: 403, superadmin: 'ok' };
  it.each(WHO)('POST /admin/schools and GET /admin/tutor-settings as %s', async (who) => {
    await check('create school', who, platform[who], () =>
      t.inject({ method: 'POST', url: `${API}/admin/schools`, token: tok(who), payload: { name: 'Новая', region: 'Ош', type: 'private', language: 'ru', status: 'active' } }),
    );
    await check('tutor settings', who, platform[who], () => t.inject({ method: 'GET', url: `${API}/admin/tutor-settings`, token: tok(who) }));
  });

  const users: Record<Who, Exp> = { guest: 401, student: 403, teacher: 403, schoolAdmin: 'ok', author: 403, authorOther: 403, translator: 403, editor: 403, editorOther: 403, superadmin: 'ok' };
  it.each(WHO)('GET /admin/users and /admin/audit as %s', async (who) => {
    await check('users', who, users[who], () => t.inject({ method: 'GET', url: `${API}/admin/users`, token: tok(who) }));
    await check('audit', who, users[who], () => t.inject({ method: 'GET', url: `${API}/admin/audit`, token: tok(who) }));
  });

  const upload: Record<Who, Exp> = { guest: 401, student: 403, teacher: 403, schoolAdmin: 403, author: 'ok', authorOther: 'ok', translator: 403, editor: 'ok', editorOther: 'ok', superadmin: 'ok' };
  it.each(WHO)('POST /admin/assets/uploads as %s', async (who) => {
    await check('upload', who, upload[who], () =>
      t.inject({
        method: 'POST',
        url: `${API}/admin/assets/uploads`,
        token: tok(who),
        payload: { filename: 'Cell.glb', kind: 'glb', size: 40_000_000, contentType: 'model/gltf-binary', license: 'CC-BY-4.0', author: 'Bilig', source: 'own' },
      }),
    );
  });

  it('a school admin sees only their school and pupils by name; the superadmin sees pupils pseudonymised', async () => {
    const mine = json(await t.inject({ method: 'GET', url: `${API}/admin/users`, token: w.schoolAdmin.adminToken }));
    const ids = mine.items.map((u: { id: string }) => u.id);
    expect(ids).toContain(w.teacher.user.id);
    expect(ids).toContain(w.student.user.id);
    expect(ids).not.toContain(w.author.user.id);
    expect(mine.items.find((u: { id: string }) => u.id === w.student.user.id).displayName).toBe(w.student.user.displayName);
    const all = json(await t.inject({ method: 'GET', url: `${API}/admin/users?limit=100`, token: w.superadmin.adminToken }));
    const pupil = all.items.find((u: { id: string }) => u.id === w.student.user.id);
    expect(pupil.displayName).toMatch(/^Ученик #/);
    const other = await t.inject({ method: 'GET', url: `${API}/admin/users/${w.author.user.id}`, token: w.schoolAdmin.adminToken });
    expect(other.statusCode).toBe(404);
  });

  it('school admins see only their own schools', async () => {
    const r = json(await t.inject({ method: 'GET', url: `${API}/admin/schools`, token: w.schoolAdmin.adminToken }));
    expect(r.items.map((s: { id: string }) => s.id)).toEqual([w.school.id]);
    const other = await t.inject({ method: 'GET', url: `${API}/admin/schools/${w.otherSchool.id}`, token: w.schoolAdmin.adminToken });
    expect(other.statusCode).toBe(403);
  });
});
