/**
 * Contract 0.8.0: roles (manager), staff sign-in and lifecycle, the action
 * journal, support sessions (the teacher's cabinet from the admin), deletion
 * requests, the teacher's profile status, classes with several subjects, КТП
 * class links and grades 1–12.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Permission } from '@bilig/permissions';
import { API, PASSWORD, json, licenseSchool, makeClass, makeSchool, makeSchoolWorld, makeTestApp, makeUser, tokenFor, type MadeUser, type TestCtx } from '../../test/helpers.js';
import { hashSecret } from '../../domain/passwords.js';
import { totpAt } from '../../domain/totp.js';
import type { MemoryRepository } from '../../repo/memory.js';
import type { Deps } from '../../deps.js';
import { expireSupportSessions } from '../../services/support.js';

const FIXED = '012345';
const ADMIN = { 'x-bilig-audience': 'admin' };

let t: TestCtx;
beforeEach(async () => {
  t = await makeTestApp({ config: { authFixedTotp: FIXED } });
});
afterEach(() => t.close());

async function makeStaff(deps: Deps, role: 'manager' | 'superadmin', permissions: Permission[] = [], opts: { email?: string; password?: string; displayName?: string } = {}): Promise<MadeUser> {
  const u = await makeUser(deps, { role }, opts);
  await deps.repo.putStaffProfile({ userId: u.user.id, permissions, scope: null, createdBy: null, createdAt: deps.clock.now(), blockedAt: null, deletedAt: null });
  return u;
}

const req = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.inject({ method: method as 'GET', url: `${API}${url}`, token, ...(payload !== undefined ? { payload: payload as object } : {}), headers });

const journal = async (filter: { action?: string } = {}) => (await t.repo.listJournal(filter, { limit: 500 })).items;

// ---------------------------------------------------------------------------
describe('roles: a manager holds only the ticked permissions (the matrix is the ceiling)', () => {
  it('ticks drive /me.permissions and the server checks; staff.manage can never be held', async () => {
    const m = await makeStaff(t.deps, 'manager', ['content.draft.edit']);
    const me = json(await req('GET', '/me', m.adminToken));
    expect(me.permissions).toEqual(expect.arrayContaining(['content.draft.edit', 'topic.view', 'demo.view']));
    expect(me.permissions).not.toContain('content.publish');
    expect(me.permissions).not.toContain('teacher.view');
    expect((await req('GET', '/admin/topics', m.adminToken)).statusCode).toBe(200);
    expect((await req('GET', '/admin/teachers', m.adminToken)).statusCode).toBe(403);
    expect((await req('GET', '/admin/staff', m.adminToken)).statusCode).toBe(403);
    // a tick for something outside the manager ceiling has no effect
    await t.repo.putStaffProfile({ ...(await t.repo.getStaffProfile(m.user.id))!, permissions: ['teacher.view', 'staff.manage', 'deletion.approve'] });
    expect((await req('GET', '/admin/teachers', m.adminToken)).statusCode).toBe(200);
    expect((await req('GET', '/admin/staff', m.adminToken)).statusCode).toBe(403);
    expect((await req('GET', '/admin/topics', m.adminToken)).statusCode).toBe(403); // content.draft.edit unticked: applies at once
  });

  it('a blocked profile holds no ticked permissions', async () => {
    const m = await makeStaff(t.deps, 'manager', ['teacher.view']);
    await t.repo.putStaffProfile({ ...(await t.repo.getStaffProfile(m.user.id))!, blockedAt: t.clock.now() });
    expect((await req('GET', '/admin/teachers', m.adminToken)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('staff sign-in: the role decides the door', () => {
  it('a manager signs in only at /admin (TOTP), never with the teacher sign-in (e-mail or phone)', async () => {
    const m = await makeStaff(t.deps, 'manager', ['teacher.view'], { email: 'm@example.kg', password: PASSWORD });
    await t.repo.updateUser(m.user.id, { phone: '+996555000111', phoneVerifiedAt: t.clock.now() });
    const viaEmail = await req('POST', '/auth/login', undefined, { email: 'm@example.kg', password: PASSWORD });
    expect(viaEmail.statusCode).toBe(403);
    expect(json(viaEmail)).toMatchObject({ detail: 'use_admin_login', i18nKey: 'errors.use_admin_login' });
    const viaPhone = await req('POST', '/auth/login', undefined, { phone: '+996555000111', password: PASSWORD });
    expect(json(viaPhone).detail).toBe('use_admin_login');
    expect((await req('POST', '/auth/login', undefined, { email: 'm@example.kg', password: PASSWORD }, ADMIN)).statusCode).toBe(401); // totp_required
    const ok = await req('POST', '/auth/login', undefined, { email: 'm@example.kg', password: PASSWORD, totp: FIXED }, ADMIN);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await t.repo.getUser(m.user.id))!.lastLoginAt).toEqual(t.clock.now());
    expect((await journal({ action: 'auth.login_denied' })).map((e) => e.result)).toEqual(['denied', 'denied']);
  });

  it('staff cannot reach a client session through a phone password reset or an old client refresh cookie', async () => {
    const m = await makeStaff(t.deps, 'manager', [], { email: 'm2@example.kg', password: PASSWORD });
    await t.repo.updateUser(m.user.id, { phone: '+996555000222', phoneVerifiedAt: t.clock.now() });
    const token = 'reset-token-for-staff-0123456789';
    await t.repo.createPhoneOtp({ id: (await import('../../ids.js')).newId(), phone: '+996555000222', purpose: 'reset', kind: 'token', hash: (await import('../../domain/crypto.js')).hashToken(token), locale: 'ru', attempts: 0, createdAt: t.clock.now(), expiresAt: new Date(t.clock.now().getTime() + 600_000), usedAt: null });
    const r = await req('POST', '/auth/password/set', undefined, { token, password: 'Another-Strong-Pass-99' });
    expect(r.statusCode).toBe(403);
    expect(json(r).detail).toBe('use_admin_login');
    // a pre-0.8.0 client session of a staff account is not refreshed
    const { SessionService } = await import('../../services/sessions.js');
    let cookie = '';
    const fakeReply = { setCookie: (_n: string, v: string) => { cookie = v; } } as never;
    await new SessionService(t.deps).start({ headers: {}, ip: '1.1.1.1' } as never, fakeReply, m.user, 'client');
    expect((await req('POST', '/auth/refresh', undefined, undefined, { cookie: `bilig_rt=${cookie}` })).statusCode).toBe(401);
  });

  it('a teacher at /admin gets use_teacher_login', async () => {
    const w = await makeSchoolWorld(t.deps);
    await t.repo.setCredential(w.teacher.user.id, 'password', await hashSecret(PASSWORD));
    const r = await req('POST', '/auth/login', undefined, { email: w.teacher.user.email, password: PASSWORD }, ADMIN);
    expect(r.statusCode).toBe(403);
    expect(json(r).detail).toBe('use_teacher_login');
  });
});

// ---------------------------------------------------------------------------
describe('staff lifecycle (staff.manage)', () => {
  it('invite → accept (password) → TOTP enrolment → active manager with the ticked permissions', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    const bad = await req('POST', '/admin/staff/invites', sa.adminToken, { email: 'new@example.kg', displayName: 'Новый Менеджер', permissions: ['staff.manage'] });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).detail).toBe('permission_not_assignable');
    const inv = await req('POST', '/admin/staff/invites', sa.adminToken, { email: 'New@Example.kg', displayName: 'Новый Менеджер', permissions: ['teacher.view', 'content.draft.edit'] });
    expect(inv.statusCode, inv.body).toBe(200);
    const list1 = json(await req('GET', '/admin/staff', sa.adminToken)).items;
    expect(list1.find((s: { email: string }) => s.email === 'new@example.kg')).toMatchObject({ role: 'manager', status: 'invited', permissions: ['content.draft.edit', 'teacher.view'], createdBy: sa.user.id, totpEnabled: false });

    const link = t.mailer.last('invite')!.link;
    const token = new URL(link).searchParams.get('token')!;
    const acc = await req('POST', `/auth/invites/${token}/accept`, undefined, { displayName: 'Айбек Менеджер', password: PASSWORD });
    expect(acc.statusCode).toBe(403);
    expect(json(acc)).toMatchObject({ detail: 'totp_enrollment_required', enrollmentToken: expect.any(String) });
    const u = (await t.repo.getUserByEmail('new@example.kg'))!;
    expect(u).toMatchObject({ status: 'active', displayName: 'Айбек Менеджер' });
    expect(await t.repo.listGrants(u.id)).toEqual([expect.objectContaining({ role: 'manager', scope: 'platform' })]);
    // enrol TOTP with the token → signed in to the admin
    const enrol = json(acc).enrollmentToken as string;
    const setup = json(await req('POST', '/auth/2fa/setup', undefined, { enrollmentToken: enrol }));
    const secret = new URL(setup.otpauthUrl).searchParams.get('secret')!;
    const v = await req('POST', '/auth/2fa/verify', undefined, { enrollmentToken: enrol, code: totpAt(secret, t.clock.now()) });
    expect(v.statusCode, v.body).toBe(200);
    expect((await req('GET', '/admin/teachers', json(v).accessToken)).statusCode).toBe(200);
    const member = json(await req('GET', '/admin/staff', sa.adminToken)).items.find((s: { userId: string }) => s.userId === u.id);
    expect(member).toMatchObject({ status: 'active', totpEnabled: true, lastLoginAt: t.clock.now().toISOString() });
    expect((await journal({ action: 'staff.invited' }))[0]).toMatchObject({ actorId: sa.user.id, actorRole: 'superadmin', group: 'staff' });
    expect((await journal({ action: 'staff.invite_accepted' }))).toHaveLength(1);
  });

  it('no shared accounts: an existing teacher e-mail cannot be invited as staff', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    const w = await makeSchoolWorld(t.deps);
    const r = await req('POST', '/admin/staff/invites', sa.adminToken, { email: w.teacher.user.email, displayName: 'Учитель', permissions: [] });
    expect(r.statusCode).toBe(409);
    expect(json(r).detail).toBe('email_in_use');
  });

  it('patch permissions, block (sessions cut), restore, soft delete — never on yourself; journaled with the reason', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    const m = await makeStaff(t.deps, 'manager', ['teacher.view'], { password: PASSWORD });
    expect((await req('PATCH', `/admin/staff/${sa.user.id}`, sa.adminToken, { displayName: 'Я сам', reason: 'self edit' })).statusCode).toBe(403);
    expect(json(await req('POST', `/admin/staff/${sa.user.id}/block`, sa.adminToken, { reason: 'self block' })).detail).toBe('self');

    const p = await req('PATCH', `/admin/staff/${m.user.id}`, sa.adminToken, { permissions: ['teacher.view', 'teacher.edit'], reason: 'support duty' });
    expect(p.statusCode, p.body).toBe(200);
    expect(json(p).permissions).toEqual(['teacher.edit', 'teacher.view']);
    const ev = (await journal({ action: 'staff.permissions_changed' }))[0];
    expect(ev).toMatchObject({ reason: 'support duty', before: { permissions: ['teacher.view'] }, after: { permissions: ['teacher.edit', 'teacher.view'] } });

    const b = await req('POST', `/admin/staff/${m.user.id}/block`, sa.adminToken, { reason: 'left the team' });
    expect(json(b).status).toBe('blocked');
    expect((await req('GET', '/admin/teachers', m.adminToken)).statusCode).toBe(401);
    expect(json(await req('POST', `/admin/staff/${m.user.id}/restore`, sa.adminToken, { reason: 'back' })).status).toBe('active');
    const fresh = await tokenFor(t.deps, (await t.repo.getUser(m.user.id))!, 'admin');
    expect((await req('GET', '/admin/teachers', fresh)).statusCode).toBe(200);
    const d = await req('POST', `/admin/staff/${m.user.id}/delete`, sa.adminToken, { reason: 'contract ended' });
    expect(json(d).status).toBe('deleted');
    expect((await req('GET', '/admin/teachers', fresh)).statusCode).toBe(401);
    // soft delete: never purged, history stays
    await t.repo.purgeDeleted(new Date(t.clock.now().getTime() + 365 * 86400_000));
    expect(await t.repo.getUser(m.user.id)).not.toBeNull();
    expect((await journal()).filter((e) => e.group === 'staff' && e.targetId === m.user.id).map((e) => e.action)).toEqual(
      expect.arrayContaining(['staff.permissions_changed', 'staff.blocked', 'staff.restored', 'staff.deleted']),
    );
  });

  it('at least two active SuperAdmins once two exist (block, delete, demote, legacy status)', async () => {
    const a = await makeStaff(t.deps, 'superadmin');
    const b = await makeStaff(t.deps, 'superadmin');
    const block = await req('POST', `/admin/staff/${b.user.id}/block`, a.adminToken, { reason: 'test' });
    expect(block.statusCode).toBe(409);
    expect(json(block).detail).toBe('superadmin_minimum');
    expect((await req('POST', `/admin/staff/${b.user.id}/delete`, a.adminToken, { reason: 'test' })).statusCode).toBe(409);
    expect((await req('PUT', `/admin/users/${b.user.id}/grants`, a.adminToken, { grants: [] })).statusCode).toBe(409);
    expect((await req('PATCH', `/admin/users/${b.user.id}`, a.adminToken, { status: 'blocked' })).statusCode).toBe(409);
    const c = await makeStaff(t.deps, 'superadmin');
    expect((await req('POST', `/admin/staff/${c.user.id}/block`, a.adminToken, { reason: 'three exist' })).statusCode).toBe(200);
    expect((await req('POST', `/admin/staff/${b.user.id}/block`, a.adminToken, { reason: 'now two' })).statusCode).toBe(409);
  });

  it('no one changes their own role (legacy grants endpoint too)', async () => {
    const a = await makeStaff(t.deps, 'superadmin');
    await makeStaff(t.deps, 'superadmin');
    await makeStaff(t.deps, 'superadmin');
    const r = await req('PUT', `/admin/users/${a.user.id}/grants`, a.adminToken, { grants: [{ role: 'manager', scope: 'platform' }] });
    expect(r.statusCode).toBe(403);
    expect(json(r).detail).toBe('self');
  });
});

// ---------------------------------------------------------------------------
describe('the action journal', () => {
  it('a manager sees only their own records; SuperAdmin all; filters and cursor', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    const m = await makeStaff(t.deps, 'manager', ['audit.read', 'teacher.view']);
    const w = await makeSchoolWorld(t.deps);
    await req('GET', `/admin/teachers/${w.teacher.user.id}`, m.adminToken);
    await req('GET', `/admin/teachers/${w.teacher.user.id}`, sa.adminToken);
    const mine = json(await req('GET', '/admin/journal', m.adminToken)).items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e: { actor: { id: string } }) => e.actor.id === m.user.id)).toBe(true);
    expect((await req('GET', `/admin/journal?actorId=${sa.user.id}`, m.adminToken)).statusCode).toBe(403);
    const all = json(await req('GET', '/admin/journal?action=teacher.viewed', sa.adminToken)).items;
    expect(all.map((e: { actor: { id: string } }) => e.actor.id).sort()).toEqual([m.user.id, sa.user.id].sort());
    expect(all[0]).toMatchObject({ group: 'teacher_data', target: { type: 'user', id: w.teacher.user.id }, result: 'ok', requestId: expect.any(String), userAgent: 'lightMyRequest' });
    expect(all[0].seq).toBeGreaterThan(all[1].seq); // newest first
    const p1 = json(await req('GET', '/admin/journal?limit=1', sa.adminToken));
    const p2 = json(await req('GET', `/admin/journal?limit=1&cursor=${p1.nextCursor}`, sa.adminToken));
    expect(p2.items[0].seq).toBe(p1.items[0].seq - 1);
    expect((await req('GET', '/admin/journal', w.teacher.adminToken)).statusCode).toBe(403);
  });

  it('never writes secrets', async () => {
    await t.deps.audit.log(null, 'auth.login', { type: 'user', id: 'x' }, { diff: { password: 'p', newPassword: 'n', token: 't', totp: '123456', secret: 's', nested: { refreshToken: 'r', ok: 1 }, aud: 'admin', marker: { totp: 'fixed' } } });
    const e = (await journal({ action: 'auth.login' }))[0];
    expect(e.details).toEqual({ nested: { ok: 1 }, aud: 'admin', marker: { totp: 'fixed' } });
  });

  it('CSV export is streamed, neutralises formulas and is journaled itself', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    await t.deps.audit.log(sa.user.id, 'content.updated', { type: 'concept', id: '=HYPERLINK("x")', label: 'a,"b"' });
    const r = await req('GET', '/admin/journal/export', sa.adminToken);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/journal-.*\.csv/);
    const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^seq,at,actor_id/);
    expect(r.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(r.body).toContain('"a,""b"""');
    expect((await journal({ action: 'export.journal_csv' }))[0]).toMatchObject({ actorId: sa.user.id, group: 'export' });
    const m = await makeStaff(t.deps, 'manager', ['audit.read']);
    const own = await req('GET', '/admin/journal/export', m.adminToken);
    expect(own.body).not.toContain(sa.user.id);
  });

  it('verify walks the chain and detects tampering (alert)', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    for (let i = 0; i < 5; i++) await t.deps.audit.log(sa.user.id, 'content.updated', { type: 'concept', id: `c${i}` });
    const ok = json(await req('GET', '/admin/journal/verify', sa.adminToken));
    expect(ok).toEqual({ ok: true, checked: 5, brokenAt: null });
    (t.repo as MemoryRepository).tamperJournal(3, { targetId: 'forged' });
    expect(json(await req('GET', '/admin/journal/verify', sa.adminToken))).toEqual({ ok: false, checked: 3, brokenAt: 3 });
    const alerts = json(await req('GET', '/admin/journal/alerts', sa.adminToken)).items;
    expect(alerts).toEqual([expect.objectContaining({ kind: 'chain_broken', seenAt: null })]);
    expect((await req('POST', `/admin/journal/alerts/${alerts[0].id}/seen`, sa.adminToken, {})).statusCode).toBe(200);
    expect(json(await req('GET', '/admin/journal/alerts', sa.adminToken)).items[0].seenAt).toEqual(expect.any(String));
    // verify again: the same incident does not raise a second alert
    await req('GET', '/admin/journal/verify', sa.adminToken);
    expect(json(await req('GET', '/admin/journal/alerts', sa.adminToken)).items).toHaveLength(1);
  });

  it('mass deletion: ≥ 10 deletions by one actor within 10 minutes raise an alert', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    const m = await makeStaff(t.deps, 'manager', []);
    for (let i = 0; i < 9; i++) await t.deps.audit.log(m.user.id, 'content.deleted', { type: 'concept', id: `k${i}` });
    expect(await t.repo.listAlerts(10)).toEqual([]);
    t.clock.advance(60_000);
    await t.deps.audit.log(m.user.id, 'asset.deleted', { type: 'asset', id: 'a' });
    const alerts = json(await req('GET', '/admin/journal/alerts', sa.adminToken)).items;
    expect(alerts).toEqual([expect.objectContaining({ kind: 'mass_deletion', actor: { id: m.user.id, displayName: m.user.displayName } })]);
  });

  it('retention: events older than 3 years are dropped by the job', async () => {
    await t.deps.audit.log(null, 'auth.login', { type: 'user', id: 'old' });
    t.clock.advance(37 * 31 * 86400_000); // the month of the old event ended more than 36 months ago
    await t.deps.audit.log(null, 'auth.login', { type: 'user', id: 'new' });
    expect(await t.repo.maintainJournal(t.clock.now(), 3, 36)).toMatchObject({ dropped: 1 });
    expect((await journal()).map((e) => e.targetId)).toEqual(['new']);
    expect(await t.repo.verifyJournal()).toEqual({ ok: true, checked: 1, brokenAt: null });
  });
});

// ---------------------------------------------------------------------------
describe('support sessions: the teacher’s cabinet from the admin', () => {
  async function setup() {
    const w = await makeSchoolWorld(t.deps);
    const m = await makeStaff(t.deps, 'manager', ['teacher.view', 'teacher.edit'], { displayName: 'Менеджер Поддержки' });
    const viewer = await makeStaff(t.deps, 'manager', ['teacher.view']);
    return { w, m, viewer };
  }
  const start = (token: string, teacherId: string, body: object) => req('POST', `/admin/teachers/${teacherId}/support`, token, body);

  it('view mode: a client token (sub = teacher, act = staff), /me.support, reads only, closed areas, journaled', async () => {
    const { w, m } = await setup();
    const r = await start(m.adminToken, w.teacher.user.id, { mode: 'view' });
    expect(r.statusCode, r.body).toBe(200);
    const s = json(r);
    expect(s).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, session: { mode: 'view', teacher: { id: w.teacher.user.id }, actor: { id: m.user.id, role: 'manager' }, endedAt: null } });
    expect(r.headers['set-cookie']).toBeUndefined(); // no refresh
    const tok = s.accessToken as string;
    const me = json(await req('GET', '/me', tok));
    expect(me).toMatchObject({ id: w.teacher.user.id, support: { sessionId: s.session.id, mode: 'view', actor: { id: m.user.id, displayName: 'Менеджер Поддержки' } } });
    expect((await req('GET', '/classes', tok)).statusCode).toBe(200);
    const write = await req('POST', '/classes', tok, { name: '9А', grade: 9 });
    expect(write.statusCode).toBe(403);
    expect(json(write).detail).toBe('support_read_only');
    for (const [method, url, body] of [['GET', '/me/sessions'], ['POST', '/me/2fa', { action: 'setup' }], ['POST', '/auth/logout-all', {}], ['POST', '/auth/password/forgot', { email: 'x@example.kg' }]] as const) {
      const f = await req(method, url, tok, body);
      expect(f.statusCode, `${method} ${url}`).toBe(403);
      expect(json(f).detail).toBe('support_forbidden');
    }
    // the support token does not open the admin API
    expect((await req('GET', '/admin/teachers', tok)).statusCode).toBe(401);
    const denied = await journal({ action: 'support.denied' });
    expect(denied.length).toBe(5);
    expect(denied[0]).toMatchObject({ actorId: m.user.id, onBehalfOfId: w.teacher.user.id, supportSessionId: s.session.id, result: 'denied' });
    expect((await journal({ action: 'support.started' }))[0]).toMatchObject({ actorId: m.user.id, onBehalfOfId: w.teacher.user.id, supportSessionId: s.session.id });
    // view mode raises no alert
    expect(await t.repo.listAlerts(10)).toEqual([]);
  });

  it('edit mode needs teacher.edit, a reason (≥ 10) and the TOTP; writes are journaled with both ids; an alert is raised', async () => {
    const { w, m, viewer } = await setup();
    expect((await start(m.adminToken, w.teacher.user.id, { mode: 'edit', totp: FIXED })).statusCode).toBe(400); // no reason
    expect((await start(m.adminToken, w.teacher.user.id, { mode: 'edit', reason: 'short', totp: FIXED })).statusCode).toBe(400);
    expect((await start(m.adminToken, w.teacher.user.id, { mode: 'edit', reason: 'Учитель просит помочь с классом' })).statusCode).toBe(400); // no totp
    expect((await start(m.adminToken, w.teacher.user.id, { mode: 'edit', reason: 'Учитель просит помочь с классом', totp: '999999' })).statusCode).toBe(401);
    const noEdit = await start(viewer.adminToken, w.teacher.user.id, { mode: 'edit', reason: 'Учитель просит помочь с классом', totp: FIXED });
    expect(noEdit.statusCode).toBe(403);
    const r = await start(m.adminToken, w.teacher.user.id, { mode: 'edit', reason: 'Учитель просит помочь с классом', totp: FIXED });
    expect(r.statusCode, r.body).toBe(200);
    const s = json(r);
    expect(s.expiresIn).toBe(1800);
    const created = await req('POST', '/classes', s.accessToken, { name: '9Б', grade: 9, subjectKey: 'bio' });
    expect(created.statusCode, created.body).toBe(200);
    const ev = (await journal({ action: 'class.created' }))[0];
    expect(ev).toMatchObject({ actorId: m.user.id, actorRole: 'manager', onBehalfOfId: w.teacher.user.id, supportSessionId: s.session.id, group: 'teacher_data' });
    expect((await journal({ action: 'support.request' }))[0]).toMatchObject({ actorId: m.user.id, onBehalfOfId: w.teacher.user.id, targetId: 'POST /api/v1/classes', result: 'ok' });
    // still closed in edit mode
    expect(json(await req('POST', '/me/2fa', s.accessToken, { action: 'setup' })).detail).toBe('support_forbidden');
    expect(await t.repo.listAlerts(10)).toEqual([expect.objectContaining({ kind: 'support_edit', actorId: m.user.id })]);
  });

  it('the real authenticator code works too (enrolled staff)', async () => {
    const { w, m } = await setup();
    const setupRes = json(await req('POST', '/me/2fa', m.token, { action: 'setup' }));
    const secret = new URL(setupRes.otpauthUrl).searchParams.get('secret')!;
    await req('POST', '/me/2fa', m.token, { action: 'verify', code: totpAt(secret, t.clock.now()) });
    const r = await start(m.adminToken, w.teacher.user.id, { mode: 'edit', reason: 'Проверка аутентификатора', totp: totpAt(secret, t.clock.now()) });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('a staff account is never opened; unknown users are 404', async () => {
    const { m } = await setup();
    const sa = await makeStaff(t.deps, 'superadmin');
    const other = await makeStaff(t.deps, 'manager', []);
    expect(json(await start(m.adminToken, other.user.id, { mode: 'view' }))).toMatchObject({ code: 'not_found', detail: 'teacher' });
    // a staff member who also holds a (legacy) teacher grant is still staff
    await t.repo.addGrant({ userId: sa.user.id, role: 'teacher', scope: 'school', scopeId: (await makeSchool(t.deps)).id, subrole: null });
    const r = await start(m.adminToken, sa.user.id, { mode: 'view' });
    expect(r.statusCode).toBe(403);
    expect(json(r).detail).toBe('staff_account');
  });

  it('expiry (15 min view) and «Выйти в админку» end the session; both are journaled', async () => {
    const { w, m } = await setup();
    const s1 = json(await start(m.adminToken, w.teacher.user.id, { mode: 'view' }));
    t.clock.advance(14 * 60_000);
    expect((await req('GET', '/me', s1.accessToken)).statusCode).toBe(200);
    t.clock.advance(2 * 60_000);
    expect((await req('GET', '/me', s1.accessToken)).statusCode).toBe(401);
    expect(await expireSupportSessions(t.deps)).toBe(1); // the scheduled job closes it
    expect((await t.repo.getSupportSession(s1.session.id))!).toMatchObject({ endReason: 'expired', endedBy: null });

    m.adminToken = await tokenFor(t.deps, m.user, 'admin'); // the clock moved past the old access token
    const s2 = json(await start(m.adminToken, w.teacher.user.id, { mode: 'view' }));
    const end = await req('POST', `/admin/support/${s2.session.id}/end`, s2.accessToken, {});
    expect(end.statusCode, end.body).toBe(200);
    expect((await req('GET', '/me', s2.accessToken)).statusCode).toBe(401);
    expect((await t.repo.getSupportSession(s2.session.id))!).toMatchObject({ endReason: 'ended', endedBy: m.user.id });
    const ends = await journal({ action: 'support.ended' });
    expect(ends.map((e) => (e.details as { reason: string }).reason).sort()).toEqual(['ended', 'expired']);
    expect(ends.every((e) => e.actorId === m.user.id && e.onBehalfOfId === w.teacher.user.id)).toBe(true);

    // another teacher's client token cannot end someone else's session
    const s3 = json(await start(m.adminToken, w.teacher.user.id, { mode: 'view' }));
    expect((await req('POST', `/admin/support/${s3.session.id}/end`, await tokenFor(t.deps, w.schoolAdmin.user), {})).statusCode).toBe(401);
    // the staff member's admin token can
    expect((await req('POST', `/admin/support/${s3.session.id}/end`, m.adminToken, {})).statusCode).toBe(200);
  });

  it('a session dies when the staff member loses teacher.view', async () => {
    const { w, m } = await setup();
    const s = json(await start(m.adminToken, w.teacher.user.id, { mode: 'view' }));
    await t.repo.putStaffProfile({ ...(await t.repo.getStaffProfile(m.user.id))!, permissions: [] });
    expect((await req('GET', '/me', s.accessToken)).statusCode).toBe(401);
    expect((await t.repo.getSupportSession(s.session.id))!.endedAt).not.toBeNull();
  });

  it('teachers list: search by name / phone / e-mail / school, status and profile status', async () => {
    const { w, m } = await setup();
    await t.repo.updateUser(w.teacher.user.id, { phone: '+996700123456', displayName: 'Айгүл Асанова' });
    await makeStaff(t.deps, 'superadmin'); // staff never listed as teachers
    const q = async (s: string) => json(await req('GET', `/admin/teachers${s}`, m.adminToken)).items.map((x: { id: string }) => x.id);
    expect(await q('')).toEqual([w.teacher.user.id]);
    expect(await q('?q=асанова')).toEqual([w.teacher.user.id]);
    expect(await q('?q=700%20123')).toEqual([w.teacher.user.id]);
    expect(await q(`?q=${encodeURIComponent(w.teacher.user.email!)}`)).toEqual([w.teacher.user.id]);
    expect(await q(`?q=${encodeURIComponent('Школа №1')}`)).toEqual([w.teacher.user.id]);
    expect(await q('?q=nobody')).toEqual([]);
    expect(await q('?profileStatus=complete')).toEqual([]);
    expect(await q('?profileStatus=incomplete')).toEqual([w.teacher.user.id]);
    expect(await q('?status=blocked')).toEqual([]);
    const one = json(await req('GET', `/admin/teachers/${w.teacher.user.id}`, m.adminToken));
    expect(one).toMatchObject({ phone: '+996700123456', schoolName: 'Школа №1', classes: 1, status: 'active', profileStatus: 'incomplete', teachingLang: null });
  });
});

// ---------------------------------------------------------------------------
describe('deletion requests: a manager asks, SuperAdmin deletes', () => {
  it('teacher: request → approve with TOTP → soft delete + sessions revoked; journaled', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    const m = await makeStaff(t.deps, 'manager', ['deletion.request', 'teacher.view']);
    const w = await makeSchoolWorld(t.deps);
    expect((await req('POST', '/admin/deletion-requests', m.adminToken, { kind: 'teacher', targetId: w.teacher.user.id, reason: 'short' })).statusCode).toBe(400);
    const c = await req('POST', '/admin/deletion-requests', m.adminToken, { kind: 'teacher', targetId: w.teacher.user.id, reason: 'Учитель уволился из школы' });
    expect(c.statusCode, c.body).toBe(200);
    const dr = json(c);
    expect(dr).toMatchObject({ status: 'pending', targetLabel: w.teacher.user.displayName, requestedBy: { id: m.user.id } });
    expect((await req('POST', '/admin/deletion-requests', m.adminToken, { kind: 'teacher', targetId: w.teacher.user.id, reason: 'Учитель уволился из школы' })).statusCode).toBe(409);
    expect((await req('POST', `/admin/deletion-requests/${dr.id}/approve`, m.adminToken, { totp: FIXED })).statusCode).toBe(403);
    expect((await req('POST', `/admin/deletion-requests/${dr.id}/approve`, sa.adminToken, { totp: '999999' })).statusCode).toBe(401);
    const ok = await req('POST', `/admin/deletion-requests/${dr.id}/approve`, sa.adminToken, { totp: FIXED, note: 'ok' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json(ok)).toMatchObject({ status: 'approved', decidedBy: { id: sa.user.id }, decisionNote: 'ok' });
    expect((await t.repo.getUser(w.teacher.user.id))!.deletedAt).not.toBeNull();
    expect((await req('GET', '/me', w.teacher.token)).statusCode).toBe(401);
    expect((await req('POST', `/admin/deletion-requests/${dr.id}/approve`, sa.adminToken, { totp: FIXED })).statusCode).toBe(409);
    expect((await journal()).filter((e) => e.group === 'deletion').map((e) => e.action).sort()).toEqual(['deletion.approved', 'deletion.requested']);
    expect((await journal({ action: 'teacher.deleted' }))[0]).toMatchObject({ actorId: sa.user.id, reason: 'Учитель уволился из школы' });
  });

  it('content still in use: 409 in_use and the request stays pending; reject with a note; managers see their own', async () => {
    const sa = await makeStaff(t.deps, 'superadmin');
    const m = await makeStaff(t.deps, 'manager', ['deletion.request']);
    const m2 = await makeStaff(t.deps, 'manager', ['deletion.request']);
    const c = json(await req('POST', '/admin/deletion-requests', m.adminToken, { kind: 'concept', targetId: 'bio.nucleus', reason: 'Дублирует другое понятие' }));
    const r = await req('POST', `/admin/deletion-requests/${c.id}/approve`, sa.adminToken, { totp: FIXED });
    expect(r.statusCode).toBe(409);
    expect(json(r).code).toBe('in_use');
    expect((await t.repo.getDeletionRequest(c.id))!.status).toBe('pending');
    expect((await journal({ action: 'deletion.failed' }))[0]).toMatchObject({ result: 'failed' });
    const rej = await req('POST', `/admin/deletion-requests/${c.id}/reject`, sa.adminToken, { totp: FIXED, note: 'Понятие используется' });
    expect(json(rej)).toMatchObject({ status: 'rejected', decisionNote: 'Понятие используется' });
    const topic = json(await req('POST', '/admin/deletion-requests', m2.adminToken, { kind: 'topic', targetId: 'animal-cell', reason: 'Тема устарела полностью' }));
    expect(json(await req('GET', '/admin/deletion-requests', m.adminToken)).items.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect(json(await req('GET', '/admin/deletion-requests', sa.adminToken)).items.map((x: { id: string }) => x.id)).toEqual([topic.id, c.id]);
    expect((await req('POST', `/admin/deletion-requests/${topic.id}/approve`, sa.adminToken, { totp: FIXED })).statusCode).toBe(200);
    expect((await t.repo.getTopicByKey('animal-cell'))!.status).toBe('archived');
    expect((await req('POST', '/admin/deletion-requests', m.adminToken, { kind: 'item', targetId: 'no.such', reason: 'Нет такого вопроса' })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('the teacher’s cabinet: profile status, classes with subjects, trial follows classes', () => {
  async function phoneTeacher() {
    const fx = (await import('../../services/teacher-signup.js'));
    const created = await t.repo.createUser({ id: (await import('../../ids.js')).newId(), kind: 'adult', email: null, emailVerifiedAt: null, phone: '+996555777888', phoneVerifiedAt: t.clock.now(), displayName: '+996 555 77 78 88', locale: 'ru', status: 'active' });
    if (created === 'conflict') throw new Error('conflict');
    const u = await fx.provisionSelfTeacher(t.deps, created, null, { method: 'phone', schoolName: fx.placeholderSchoolName('ru') });
    return { user: u, token: await tokenFor(t.deps, u) };
  }

  it('profileStatus: incomplete → complete (name, school, teaching language, a class with a subject)', async () => {
    const { token } = await phoneTeacher();
    const me = async () => json(await req('GET', '/me', token));
    expect(await me()).toMatchObject({ profileStatus: 'incomplete', setup: { name: false, school: false, teachingLang: false, classWithSubject: false } });
    await req('PATCH', '/me', token, { displayName: 'Айгүл Асанова', schoolName: 'Ош, №5 мектеп', teachingLang: 'ky' });
    expect(await me()).toMatchObject({ profileStatus: 'incomplete', teachingLang: 'ky', setup: { name: true, school: true, teachingLang: true, classWithSubject: false } });
    expect((await req('PATCH', '/me', token, { teachingLang: 'de' })).statusCode).toBe(400);
    const cls = await req('POST', '/classes', token, { name: '7А', grade: 7 });
    expect(cls.statusCode, cls.body).toBe(200);
    expect((await me()).profileStatus).toBe('incomplete'); // a class without a subject
    await req('PATCH', `/classes/${json(cls).id}`, token, { subjectKeys: ['bio'] });
    expect(await me()).toMatchObject({ profileStatus: 'complete', setup: { classWithSubject: true } });
    expect((await journal({ action: 'profile.updated' }))[0]).toMatchObject({ before: { displayName: '+996 555 77 78 88', teachingLang: null }, after: { teachingLang: 'ky' } });
  });

  it('a school teacher: the school is set by the admins', async () => {
    const w = await makeSchoolWorld(t.deps);
    const me = json(await req('GET', '/me', w.teacher.token));
    expect(me).toMatchObject({ profileStatus: 'incomplete', setup: { name: true, school: true, teachingLang: false, classWithSubject: false } });
    await req('PATCH', '/me', w.teacher.token, { teachingLang: 'ru' });
    await req('PATCH', `/classes/${w.cls.id}`, w.teacher.token, { subjectKeys: ['bio'] });
    expect(json(await req('GET', '/me', w.teacher.token)).profileStatus).toBe('complete');
  });

  it('the trial follows the classes (grade and subjects added automatically); PATCH /me teaching still works', async () => {
    const { user, token } = await phoneTeacher();
    const lic = async () => json(await req('GET', '/me', token)).licenses[0];
    expect(await lic()).toMatchObject({ subjects: [], grades: [] });
    const c = await req('POST', '/classes', token, { name: '12А', grade: 12, subjectKeys: ['bio'] });
    expect(c.statusCode, c.body).toBe(200);
    expect(json(c)).toMatchObject({ grade: 12, subjectKey: 'bio', subjectKeys: ['bio'] });
    expect(await lic()).toMatchObject({ subjects: ['bio'], grades: [12] });
    await req('PATCH', `/classes/${json(c).id}`, token, { grade: 9 });
    expect((await lic()).grades).toEqual([9, 12]);
    expect((await journal({ action: 'license.trial_extended' })).every((e) => e.actorId === user.id)).toBe(true);
    const p = await req('PATCH', '/me', token, { teaching: { subjects: ['bio'], grades: [7] } });
    expect(json(p).teaching).toEqual({ subjects: ['bio'], grades: [7] });
    expect((await req('POST', '/classes', token, { name: '13А', grade: 13 })).statusCode).toBe(400);
  });

  it('a class with several subjects keeps subjectKey = the first; subjects of an admin school must be licensed', async () => {
    const school = await makeSchool(t.deps);
    await licenseSchool(t.deps, school.id, ['bio', 'math'], [7]);
    const teacher = await makeUser(t.deps, { role: 'teacher', scopeId: school.id });
    const c = json(await req('POST', '/classes', teacher.token, { name: '7Б', grade: 7, subjectKeys: ['math', 'bio', 'math'] }));
    expect(c).toMatchObject({ subjectKey: 'math', subjectKeys: ['math', 'bio'] });
    expect(json(await req('PATCH', `/classes/${c.id}`, teacher.token, { subjectKey: 'bio' }))).toMatchObject({ subjectKey: 'bio', subjectKeys: ['bio', 'math'] });
    const bad = await req('PATCH', `/classes/${c.id}`, teacher.token, { subjectKeys: ['chem'] });
    expect(json(bad).detail).toBe('subject_not_licensed');
    expect(json(await req('PATCH', `/classes/${c.id}`, teacher.token, { subjectKeys: [] }))).toMatchObject({ subjectKey: null, subjectKeys: [] });
  });
});

// ---------------------------------------------------------------------------
describe('classes → subjects: КТП status, next lesson, progress; КТП class links', () => {
  it('links КТП class columns by name on upload, editable via PATCH; the class shows the plan', async () => {
    const { importContent, loadContentDir } = await import('../../services/seed.js');
    const { algebraKtp } = await import('../../ktp/__tests__/fixtures.js');
    await importContent(t.repo, t.clock, loadContentDir(), t.deps.config);
    const school = await makeSchool(t.deps);
    await licenseSchool(t.deps, school.id, ['math'], [8]);
    const teacher = await makeUser(t.deps, { role: 'teacher', scopeId: school.id });
    const c8b = await makeClass(t.deps, school.id, teacher.user.id, '8 Б');
    const c8v = await makeClass(t.deps, school.id, teacher.user.id, '8-В');
    const other = await makeClass(t.deps, school.id, undefined, '8Г');
    await t.repo.updateClass(c8b.id, { subjectKeys: ['math'] });
    await t.repo.updateClass(c8v.id, { subjectKeys: ['math', 'bio'] });

    const none = json(await req('GET', `/classes/${c8b.id}/subjects`, teacher.token));
    expect(none.items).toEqual([{ subjectKey: 'math', ktp: { status: 'none', planId: null, errors: 0, warnings: 0 }, nextLesson: null, progress: { done: 0, total: 0 } }]);

    const up = await req('POST', '/ktp', teacher.token, { fileName: 'КТП.docx', data: algebraKtp().toString('base64') });
    expect(up.statusCode, up.body).toBe(200);
    const plan = json(up);
    expect(plan.classLinks).toEqual({ '8Б': c8b.id, '8В': c8v.id });

    t.clock.advance(30 * 86400_000); // mid-November
    teacher.token = await tokenFor(t.deps, teacher.user);
    const sub = await req('GET', `/classes/${c8b.id}/subjects`, teacher.token);
    expect(sub.statusCode, sub.body).toBe(200);
    const res = json(sub).items[0];
    expect(res).toMatchObject({ subjectKey: 'math', ktp: { status: 'parsed', planId: plan.id }, progress: { total: plan.rows.length } });
    expect(res.ktp.errors + res.ktp.warnings).toBeGreaterThan(0);
    expect(res.progress.done).toBeGreaterThan(0);
    expect(res.progress.done).toBeLessThan(res.progress.total);
    expect(res.nextLesson.date >= '2026-11-14').toBe(true);
    const row = plan.rows.find((r: { index: number }) => r.index === res.nextLesson.index);
    expect(row.dates['8Б']).toBe(res.nextLesson.date);
    // 8В also teaches bio: no КТП for it
    expect(json(await req('GET', `/classes/${c8v.id}/subjects`, teacher.token)).items.map((x: { ktp: { status: string } }) => x.ktp.status)).toEqual(['parsed', 'none']);

    // PATCH: unlink 8в; another teacher's class or an unknown column is refused
    const patch = (body: object, v: number) => req('PATCH', `/ktp/${plan.id}`, teacher.token, { version: v, ...body }, { 'if-match': String(v) });
    expect((await patch({ classLinks: { '8В': other.id } }, 1)).statusCode).toBe(400);
    expect((await patch({ classLinks: { '9А': null } }, 1)).statusCode).toBe(400);
    const p = await patch({ classLinks: { '8В': null } }, 1);
    expect(p.statusCode, p.body).toBe(200);
    expect(json(p).classLinks).toEqual({ '8Б': c8b.id, '8В': null });
    expect(json(await req('GET', `/classes/${c8v.id}/subjects`, teacher.token)).items[0].ktp.status).toBe('none');
    expect((await journal({ action: 'ktp.updated' }))[0]).toMatchObject({ actorId: teacher.user.id, group: 'teacher_data' });
  }, 60_000);
});

describe('grades 1–12', () => {
  it('g12 is valid; 13 is not', async () => {
    expect((await req('GET', '/textbooks?grade=12')).statusCode).toBe(200);
    expect((await req('GET', '/textbooks?grade=13')).statusCode).toBe(400);
    const { gradeOf } = await import('../../ktp/plan-content.js');
    expect(gradeOf('12А', null)).toBe(12);
    expect(gradeOf('13А', null)).toBeNull();
    const { cleanTeaching } = await import('../../services/teacher-signup.js');
    expect((await cleanTeaching(t.repo, { subjects: ['bio'], grades: [11, 12, 13] })).grades).toEqual([11, 12]);
  });
});
