/** Schools, licences, users, grants, invites (A-15, A-16). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, json, makeTestApp, PASSWORD, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';
import { newId } from '../../ids.js';

let t: TestCtx;
let w: AdminWorld;
beforeAll(async () => {
  t = await makeTestApp();
  w = await makeAdminWorld(t);
});
afterAll(() => t.close());

describe('admin org', () => {
  it('superadmin creates a school and a licence; the licence opens licensed topics', async () => {
    const s = await t.inject({ method: 'POST', url: `${API}/admin/schools`, token: w.superadmin.adminToken, payload: { name: 'Лицей', region: 'Ош', type: 'private', language: 'ru', status: 'active' } });
    expect(s.statusCode, s.body).toBe(200);
    const schoolId = json(s).id;
    const lic = { id: newId(), schoolId, subjects: ['bio'], grades: [7], seats: 100, startsAt: '2026-09-01T00:00:00Z', endsAt: '2027-06-30T00:00:00Z' };
    const l = await t.inject({ method: 'POST', url: `${API}/admin/licenses`, token: w.superadmin.adminToken, payload: lic });
    expect(l.statusCode, l.body).toBe(200);
    expect((await t.inject({ method: 'POST', url: `${API}/admin/licenses`, token: w.superadmin.adminToken, payload: lic })).statusCode).toBe(409);
    const p = await t.inject({ method: 'PATCH', url: `${API}/admin/licenses/${lic.id}`, token: w.superadmin.adminToken, payload: { endsAt: '2026-01-01T00:00:00Z' } });
    expect(p.statusCode).toBe(400);
    const p2 = await t.inject({ method: 'PATCH', url: `${API}/admin/licenses/${lic.id}`, token: w.superadmin.adminToken, payload: { seats: 120 } });
    expect(json(p2).seats).toBe(120);
    const list = json(await t.inject({ method: 'GET', url: `${API}/admin/licenses?schoolId=${schoolId}`, token: w.superadmin.adminToken }));
    expect(list.items).toHaveLength(1);
    expect((await t.inject({ method: 'GET', url: `${API}/admin/licenses?schoolId=${schoolId}`, token: w.schoolAdmin.adminToken })).statusCode).toBe(403);
    expect((await t.inject({ method: 'DELETE', url: `${API}/admin/licenses/${lic.id}`, token: w.superadmin.adminToken })).statusCode).toBe(200);
    const sp = await t.inject({ method: 'PATCH', url: `${API}/admin/schools/${schoolId}`, token: w.superadmin.adminToken, payload: { status: 'suspended' } });
    expect(json(sp).status).toBe('suspended');
  });

  it('invites: a school admin may invite teachers to their school only; accepting grants the role', async () => {
    const tok = w.schoolAdmin.adminToken;
    const bad1 = await t.inject({ method: 'POST', url: `${API}/admin/invites`, token: tok, payload: { email: 'x@example.kg', role: 'teacher', scope: 'school', scopeId: w.otherSchool.id } });
    expect(bad1.statusCode).toBe(403);
    const bad2 = await t.inject({ method: 'POST', url: `${API}/admin/invites`, token: tok, payload: { email: 'x@example.kg', role: 'editor', scope: 'subject', scopeId: 'bio' } });
    expect(bad2.statusCode).toBe(403);
    const bad3 = await t.inject({ method: 'POST', url: `${API}/admin/invites`, token: w.superadmin.adminToken, payload: { email: 'x@example.kg', role: 'teacher', scope: 'platform' } });
    expect(bad3.statusCode).toBe(400);
    const ok = await t.inject({ method: 'POST', url: `${API}/admin/invites`, token: tok, payload: { email: 'New.Teacher@example.kg', role: 'teacher', scope: 'school', scopeId: w.school.id } });
    expect(ok.statusCode, ok.body).toBe(200);
    const mail = t.mailer.last('invite')!;
    expect(mail.to).toBe('new.teacher@example.kg');
    const token = new URL(mail.link).searchParams.get('token')!;
    const list = json(await t.inject({ method: 'GET', url: `${API}/admin/invites`, token: tok }));
    expect(list.items).toHaveLength(1);
    expect(json(await t.inject({ method: 'GET', url: `${API}/admin/invites`, token: w.superadmin.adminToken })).items).toHaveLength(1);

    const acc = await t.inject({ method: 'POST', url: `${API}/auth/invites/${token}/accept`, payload: { displayName: 'Жаңы мугалим', password: PASSWORD } });
    expect(acc.statusCode, acc.body).toBe(200);
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token: json(acc).accessToken }));
    expect(me.grants).toEqual([{ role: 'teacher', scope: 'school', scopeId: w.school.id }]);
    const again = await t.inject({ method: 'POST', url: `${API}/auth/invites/${token}/accept`, payload: { displayName: 'X', password: PASSWORD } });
    expect(again.statusCode).toBe(404);
    const audit = (await t.repo.listAudit({ action: 'invite.created' }, { limit: 5 })).items;
    expect(audit).toHaveLength(1);
  });

  it('grants PUT: school admin manages teacher grants of their school, audited with before/after', async () => {
    const tok = w.schoolAdmin.adminToken;
    const target = w.teacher.user.id;
    const r = await t.inject({
      method: 'PUT',
      url: `${API}/admin/users/${target}/grants`,
      token: tok,
      payload: { grants: [{ role: 'teacher', scope: 'school', scopeId: w.school.id }, { role: 'school_admin', scope: 'school', scopeId: w.school.id }] },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r).grants).toHaveLength(2);
    const esc = await t.inject({ method: 'PUT', url: `${API}/admin/users/${target}/grants`, token: tok, payload: { grants: [{ role: 'superadmin', scope: 'platform' }] } });
    expect(esc.statusCode).toBe(403);
    const self = await t.inject({ method: 'PUT', url: `${API}/admin/users/${w.schoolAdmin.user.id}/grants`, token: tok, payload: { grants: [] } });
    expect(self.statusCode).toBe(403);
    const invalid = await t.inject({ method: 'PUT', url: `${API}/admin/users/${target}/grants`, token: w.superadmin.adminToken, payload: { grants: [{ role: 'teacher', scope: 'platform' }] } });
    expect(invalid.statusCode).toBe(400);
    const a = (await t.repo.listAudit({ action: 'user.grants_changed' }, { limit: 10 })).items.at(-1)!;
    expect(a.targetId).toBe(target);
    expect(a.diff).toMatchObject({ added: 1, removed: 0 });
  });

  it('block a user (sessions revoked), revoke sessions, reset 2FA, password-reset mail', async () => {
    const victim = w.teacher;
    const b = await t.inject({ method: 'PATCH', url: `${API}/admin/users/${victim.user.id}`, token: w.schoolAdmin.adminToken, payload: { status: 'blocked' } });
    expect(json(b).status).toBe('blocked');
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: victim.token })).statusCode).toBe(401);
    expect((await t.inject({ method: 'PATCH', url: `${API}/admin/users/${victim.user.id}`, token: w.schoolAdmin.adminToken, payload: { status: 'active' } })).statusCode).toBe(200);
    expect((await t.inject({ method: 'POST', url: `${API}/admin/users/${victim.user.id}/revoke-sessions`, token: w.schoolAdmin.adminToken, payload: {} })).statusCode).toBe(200);
    expect((await t.inject({ method: 'POST', url: `${API}/admin/users/${victim.user.id}/reset-2fa`, token: w.schoolAdmin.adminToken, payload: {} })).statusCode).toBe(403);
    expect((await t.inject({ method: 'POST', url: `${API}/admin/users/${victim.user.id}/reset-2fa`, token: w.superadmin.adminToken, payload: {} })).statusCode).toBe(200);
    const pr = await t.inject({ method: 'POST', url: `${API}/admin/users/${victim.user.id}/password-reset`, token: w.schoolAdmin.adminToken, payload: {} });
    expect(pr.statusCode, pr.body).toBe(200);
    expect(t.mailer.last('password_reset')!.to).toBe(victim.user.email);
    // a school admin cannot touch the superadmin or users of other schools
    expect((await t.inject({ method: 'PATCH', url: `${API}/admin/users/${w.superadmin.user.id}`, token: w.schoolAdmin.adminToken, payload: { status: 'blocked' } })).statusCode).toBe(404);
    const actions = (await t.repo.listAudit({}, { limit: 1000 })).items.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['user.status_changed', 'user.sessions_revoked', 'user.2fa_reset']));
  });

  it('users list filters by role and status', async () => {
    const r = json(await t.inject({ method: 'GET', url: `${API}/admin/users?role=editor`, token: w.superadmin.adminToken }));
    expect(r.items.map((u: { id: string }) => u.id).sort()).toEqual([w.editor.user.id, w.editorOther.user.id].sort());
    const s = json(await t.inject({ method: 'GET', url: `${API}/admin/users?schoolId=${w.school.id}&limit=2`, token: w.superadmin.adminToken }));
    expect(s.items).toHaveLength(2);
    expect(s.nextCursor).toBeTruthy();
    const s2 = json(await t.inject({ method: 'GET', url: `${API}/admin/users?schoolId=${w.school.id}&limit=2&cursor=${s.nextCursor}`, token: w.superadmin.adminToken }));
    expect(s2.items.length).toBeGreaterThan(0);
  });
});
