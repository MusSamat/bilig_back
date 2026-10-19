import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ProblemSchema } from '@bilig/content-model/api';
import { totpAt } from '../../domain/totp.js';
import { API, PASSWORD, json, makeSchoolWorld, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';

let t: TestCtx;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(() => t.close());

const login = (email: string, password: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  t.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email, password, ...extra }, headers });

/** Extract `name=value` of the refresh cookie from a response. */
function rtCookie(res: { headers: Record<string, unknown> }, name = 'bilig_rt'): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw as string];
  const c = list.find((x) => x?.startsWith(`${name}=`));
  if (!c) throw new Error('no refresh cookie');
  return c.split(';')[0];
}

describe('login', () => {
  it('issues a 15-min Bearer token and an HttpOnly Secure SameSite=Lax refresh cookie', async () => {
    await makeUser(t.deps, undefined, { email: 'a@example.kg', password: PASSWORD });
    const res = await login('A@Example.kg', PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/bilig_rt=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\/api\/v1\/auth/);
    const audit = await t.repo.listAudit({ action: 'auth.login' }, { limit: 10 });
    expect(audit.items).toHaveLength(1);
  });

  it('answers identically for an unknown e-mail and a wrong password', async () => {
    await makeUser(t.deps, undefined, { email: 'b@example.kg', password: PASSWORD });
    const a = await login('nobody@example.kg', PASSWORD);
    const b = await login('b@example.kg', 'wrong-password-123');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    const strip = (r: typeof a) => {
      const { instance: _i, ...rest } = ProblemSchema.parse(json(r));
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
    expect(strip(a)).toMatchObject({ code: 'invalid_credentials', i18nKey: 'errors.invalid_credentials' });
    expect(a.headers['set-cookie']).toBeUndefined();
  });

  it('rate-limits login attempts per e-mail', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await login('victim@example.kg', `wrong-password-${i}`);
    expect(last!.statusCode).toBe(429);
    expect(json(last!).code).toBe('rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rejects the old unsigned base64 principal and forged tokens', async () => {
    const forged = Buffer.from(JSON.stringify({ userId: 'x', grants: [{ role: 'superadmin', scope: 'platform' }] })).toString('base64url');
    const r1 = await t.inject({ method: 'GET', url: `${API}/me`, token: forged });
    expect(r1.statusCode).toBe(401);
    const r2 = await t.inject({ method: 'GET', url: `${API}/me`, token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' });
    expect(r2.statusCode).toBe(401);
    // a forged principal must not unlock admin content either
    const r3 = await t.inject({ method: 'GET', url: `${API}/admin/audit`, token: forged });
    expect(r3.statusCode).toBe(401);
  });

  it('client-audience tokens do not work on the admin API', async () => {
    const su = await makeUser(t.deps, { role: 'superadmin' });
    const r = await t.inject({ method: 'GET', url: `${API}/admin/audit`, token: su.token });
    expect(r.statusCode).toBe(401);
  });

  it('expired access tokens are rejected', async () => {
    const u = await makeUser(t.deps);
    t.clock.advance(16 * 60_000);
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: u.token })).statusCode).toBe(401);
  });
});

describe('refresh rotation & reuse detection', () => {
  it('rotates the refresh token and revokes the whole family when an old one is replayed', async () => {
    await makeUser(t.deps, undefined, { email: 'r@example.kg', password: PASSWORD });
    const l = await login('r@example.kg', PASSWORD);
    const c1 = rtCookie(l);
    const r1 = await t.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: { cookie: c1 } });
    expect(r1.statusCode, r1.body).toBe(200);
    const c2 = rtCookie(r1);
    expect(c2).not.toBe(c1);
    const access2 = json(r1).accessToken as string;
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: access2 })).statusCode).toBe(200);

    // attacker replays the first (already rotated) token
    const replay = await t.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: { cookie: c1 } });
    expect(replay.statusCode).toBe(401);
    // … which kills the legitimate chain too
    const legit = await t.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: { cookie: c2 } });
    expect(legit.statusCode).toBe(401);
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: access2 })).statusCode).toBe(401);
    const audit = await t.repo.listAudit({ action: 'auth.refresh_reuse' }, { limit: 10 });
    expect(audit.items).toHaveLength(1);
  });

  it('refresh without a cookie or with a garbage cookie is 401', async () => {
    expect((await t.inject({ method: 'POST', url: `${API}/auth/refresh` })).statusCode).toBe(401);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: { cookie: 'bilig_rt=nope' } })).statusCode).toBe(401);
  });

  it('students get 8-hour sessions that do not slide', async () => {
    const w = await makeSchoolWorld(t.deps);
    const res = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId: w.cls.id, studentId: w.students[0].user.id, pin: '123456' } });
    expect(res.statusCode, res.body).toBe(200);
    let cookie = rtCookie(res);
    t.clock.advance(7 * 3600_000);
    const r = await t.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    cookie = rtCookie(r);
    t.clock.advance(1.5 * 3600_000);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('logout, logout-all, sessions', () => {
  it('lists sessions, logs out one and all', async () => {
    await makeUser(t.deps, undefined, { email: 's@example.kg', password: PASSWORD });
    const a = await login('s@example.kg', PASSWORD, {}, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' });
    const b = await login('s@example.kg', PASSWORD);
    const tokA = json(a).accessToken;
    const tokB = json(b).accessToken;
    const list = await t.inject({ method: 'GET', url: `${API}/me/sessions`, token: tokA });
    expect(json(list).items.filter((s: { device: string }) => s.device !== 'test')).toHaveLength(2);
    expect(json(list).items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(json(list).items.map((s: { device: string }) => s.device)).toContain('Chrome on Windows');

    const out = await t.inject({ method: 'POST', url: `${API}/auth/logout`, token: tokB, headers: { cookie: rtCookie(b) } });
    expect(out.statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: tokB })).statusCode).toBe(401);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: { cookie: rtCookie(b) } })).statusCode).toBe(401);
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: tokA })).statusCode).toBe(200);

    const all = await t.inject({ method: 'POST', url: `${API}/auth/logout-all`, token: tokA });
    expect(all.statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: tokA })).statusCode).toBe(401);
  });

  it('revokes a single session by id (own only)', async () => {
    const u = await makeUser(t.deps);
    const other = await makeUser(t.deps);
    const list = json(await t.inject({ method: 'GET', url: `${API}/me/sessions`, token: u.token })).items;
    expect((await t.inject({ method: 'DELETE', url: `${API}/me/sessions/${list[0].id}`, token: other.token })).statusCode).toBe(404);
    expect((await t.inject({ method: 'DELETE', url: `${API}/me/sessions/${list[0].id}`, token: u.token })).statusCode).toBe(200);
  });
});

describe('registration, verification, password reset', () => {
  it('enforces the password policy', async () => {
    const short = await t.inject({ method: 'POST', url: `${API}/auth/register`, payload: { email: 'n@example.kg', password: 'short', displayName: 'N' } });
    expect(short.statusCode).toBe(400);
    const leaked = await t.inject({ method: 'POST', url: `${API}/auth/register`, payload: { email: 'n@example.kg', password: 'password123', displayName: 'N' } });
    expect(leaked.statusCode).toBe(400);
    expect(json(leaked)).toMatchObject({ code: 'password_weak', detail: 'leaked' });
  });

  it('register → login blocked until the e-mail is verified', async () => {
    const reg = await t.inject({ method: 'POST', url: `${API}/auth/register`, payload: { email: 'teacher@example.kg', password: PASSWORD, displayName: 'Мугалим' } });
    expect(reg.statusCode, reg.body).toBe(200);
    expect((await login('teacher@example.kg', PASSWORD)).statusCode).toBe(403);
    const mail = t.mailer.last('email_code')!; // v0.6.0: the code mail also carries the v0.2.1 link
    const token = new URL(mail.link).searchParams.get('token')!;
    expect((await t.inject({ method: 'POST', url: `${API}/auth/email/verify`, payload: { token } })).statusCode).toBe(200);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/email/verify`, payload: { token } })).statusCode).toBe(404);
    expect((await login('teacher@example.kg', PASSWORD)).statusCode).toBe(200);
    // re-registering an existing address looks the same (no enumeration) and sends no code (v0.6.0: an «account exists» mail)
    const again = await t.inject({ method: 'POST', url: `${API}/auth/register`, payload: { email: 'teacher@example.kg', password: PASSWORD, displayName: 'X' } });
    expect(again.statusCode).toBe(200);
    expect(json(again)).toEqual(json(reg));
    expect(t.mailer.outbox.filter((m) => m.kind === 'email_code')).toHaveLength(1);
    expect(t.mailer.last()!.kind).toBe('account_exists');
  });

  it('reset link works once, within 30 minutes, and logs out other sessions', async () => {
    const u = await makeUser(t.deps, undefined, { email: 'p@example.kg', password: PASSWORD });
    expect((await t.inject({ method: 'POST', url: `${API}/auth/password/forgot`, payload: { email: 'unknown@example.kg' } })).statusCode).toBe(200);
    expect(t.mailer.outbox).toHaveLength(0);
    await t.inject({ method: 'POST', url: `${API}/auth/password/forgot`, payload: { email: 'p@example.kg' } });
    const token = new URL(t.mailer.last('password_reset')!.link).searchParams.get('token')!;
    const weak = await t.inject({ method: 'POST', url: `${API}/auth/password/reset`, payload: { token, password: '1234567890' } });
    expect(json(weak).code).toBe('password_weak'); // the link stays usable after a weak attempt
    const token2 = token;
    const ok = await t.inject({ method: 'POST', url: `${API}/auth/password/reset`, payload: { token: token2, password: 'New-Strong-Pass-2026' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: u.token })).statusCode).toBe(401);
    expect((await login('p@example.kg', 'New-Strong-Pass-2026')).statusCode).toBe(200);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/password/reset`, payload: { token: token2, password: 'Another-Pass-2026x' } })).statusCode).toBe(404);

    await t.inject({ method: 'POST', url: `${API}/auth/password/forgot`, payload: { email: 'p@example.kg' } });
    const token3 = new URL(t.mailer.last('password_reset')!.link).searchParams.get('token')!;
    t.clock.advance(31 * 60_000);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/password/reset`, payload: { token: token3, password: 'Late-Strong-Pass-2026' } })).statusCode).toBe(404);
  });
});

describe('students: class code → names → PIN', () => {
  it('lists names for a valid class code, rejects disabled/unknown codes', async () => {
    const w = await makeSchoolWorld(t.deps);
    const res = await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: w.cls.joinCode.toLowerCase() } });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res).students.map((s: { displayName: string }) => s.displayName)).toEqual(['Айбек Асанов', 'Нургүл Токтогулова']);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: 'ZZZZZZ' } })).statusCode).toBe(404);
    await t.repo.updateClass(w.cls.id, { joinCodeEnabled: false });
    expect(json(await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: w.cls.joinCode } })).code).toBe('class_code_invalid');
  });

  it('locks the PIN for 15 minutes after 5 wrong tries', async () => {
    const w = await makeSchoolWorld(t.deps);
    const body = (pin: string) => ({ classId: w.cls.id, studentId: w.students[0].user.id, pin });
    for (let i = 0; i < 4; i++) {
      const r = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: body('000000') });
      expect(r.statusCode).toBe(401);
    }
    const fifth = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: body('000000') });
    expect(fifth.statusCode).toBe(423);
    expect(json(fifth)).toMatchObject({ code: 'pin_locked', retryAfter: 900 });
    // even the right PIN is refused while locked
    const locked = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: body('123456') });
    expect(locked.statusCode).toBe(423);
    t.clock.advance(15 * 60_000 + 1000);
    const ok = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: body('123456') });
    expect(ok.statusCode, ok.body).toBe(200);
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token: json(ok).accessToken }));
    expect(me).toMatchObject({ kind: 'student', displayName: 'Айбек Асанов' });
    expect(me.permissions).toContain('quiz.attempt.save');
    expect(me.email).toBeUndefined();
    expect((await t.repo.listAudit({ action: 'auth.pin_locked' }, { limit: 5 })).items).toHaveLength(1);
  });

  it('a student of another class cannot log in through this class', async () => {
    const w = await makeSchoolWorld(t.deps);
    const w2 = await makeSchoolWorld(t.deps);
    const r = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId: w.cls.id, studentId: w2.students[0].user.id, pin: '123456' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('2FA for the admin audience', () => {
  it('requires TOTP enrolment and a code for editors on aud=admin', async () => {
    const ed = await makeUser(t.deps, { role: 'editor', scopeId: 'bio' }, { email: 'ed@example.kg', password: PASSWORD });
    const admin = { 'x-bilig-audience': 'admin' };
    const noEnrol = await login('ed@example.kg', PASSWORD, {}, admin);
    expect(noEnrol.statusCode).toBe(403);
    expect(json(noEnrol).detail).toBe('totp_enrollment_required');

    // enrol through the client app (/me/2fa)
    const setup = await t.inject({ method: 'POST', url: `${API}/me/2fa`, token: ed.token, payload: { action: 'setup' } });
    expect(setup.statusCode, setup.body).toBe(200);
    const secret = new URL(json(setup).otpauthUrl).searchParams.get('secret')!;
    expect((await t.inject({ method: 'POST', url: `${API}/me/2fa`, token: ed.token, payload: { action: 'verify', code: '000000' } })).statusCode).toBe(401);
    const verify = await t.inject({ method: 'POST', url: `${API}/me/2fa`, token: ed.token, payload: { action: 'verify', code: totpAt(secret, t.clock.now()) } });
    expect(json(verify)).toEqual({ enabled: true });
    expect(json(await t.inject({ method: 'GET', url: `${API}/me`, token: ed.token })).totpEnabled).toBe(true);

    const missing = await login('ed@example.kg', PASSWORD, {}, admin);
    expect(missing.statusCode).toBe(401);
    expect(json(missing).code).toBe('totp_required');
    expect((await login('ed@example.kg', PASSWORD, { totp: '123456' }, admin)).statusCode).toBe(401);
    const ok = await login('ed@example.kg', PASSWORD, { totp: totpAt(secret, t.clock.now()) }, admin);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/bilig_admin_rt=/);
    // the client audience does not need TOTP
    expect((await login('ed@example.kg', PASSWORD)).statusCode).toBe(200);

    // disable needs a valid code
    expect((await t.inject({ method: 'POST', url: `${API}/me/2fa`, token: ed.token, payload: { action: 'disable', code: '000000' } })).statusCode).toBe(401);
    const dis = await t.inject({ method: 'POST', url: `${API}/me/2fa`, token: ed.token, payload: { action: 'disable', code: totpAt(secret, t.clock.now()) } });
    expect(json(dis)).toEqual({ enabled: false });
  });

  it('teachers can use the admin audience without TOTP', async () => {
    await makeUser(t.deps, { role: 'teacher', scopeId: '0192f000-0000-7000-8000-000000000001' }, { email: 'tt@example.kg', password: PASSWORD });
    expect((await login('tt@example.kg', PASSWORD, {}, { 'x-bilig-audience': 'admin' })).statusCode).toBe(200);
  });
});

describe('me', () => {
  it('returns grants + permissions and patches the profile', async () => {
    const u = await makeUser(t.deps, { role: 'author', scopeId: 'bio', subrole: 'translator' });
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token: u.token }));
    expect(me.grants).toEqual([{ role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'translator' }]);
    expect(me.permissions).toContain('content.draft.edit');
    expect(me.permissions).not.toContain('model.upload');
    const p = await t.inject({ method: 'PATCH', url: `${API}/me`, token: u.token, payload: { locale: 'en', displayName: 'Aigul' } });
    expect(json(p)).toMatchObject({ locale: 'en', displayName: 'Aigul' });
    expect((await t.inject({ method: 'PATCH', url: `${API}/me`, token: u.token, payload: { locale: 'de' } })).statusCode).toBe(400);
    expect((await t.inject({ method: 'GET', url: `${API}/me` })).statusCode).toBe(401);
  });
});

describe('invites', () => {
  it('accepts an invite: creates the user with the granted role and signs in', async () => {
    const { hashToken } = await import('../../domain/crypto.js');
    const { newId } = await import('../../ids.js');
    const inviter = await makeUser(t.deps, { role: 'superadmin' });
    await t.repo.createInvite({ id: newId(), email: 'new@example.kg', role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'artist', tokenHash: hashToken('invite-token-1'), invitedBy: inviter.user.id, createdAt: t.clock.now(), expiresAt: new Date(t.clock.now().getTime() + 86400_000), acceptedAt: null });
    const weak = await t.inject({ method: 'POST', url: `${API}/auth/invites/invite-token-1/accept`, payload: { displayName: 'Artist', password: '1234567890' } });
    expect(weak.statusCode).toBe(400);
    const res = await t.inject({ method: 'POST', url: `${API}/auth/invites/invite-token-1/accept`, payload: { displayName: 'Artist', password: PASSWORD } });
    expect(res.statusCode, res.body).toBe(200);
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token: json(res).accessToken }));
    expect(me.grants).toEqual([{ role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'artist' }]);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/invites/invite-token-1/accept`, payload: { displayName: 'A', password: PASSWORD } })).statusCode).toBe(404);
    expect((await t.repo.listAudit({ action: 'user.grants_changed' }, { limit: 5 })).items).toHaveLength(1);
  });
});

describe('ADMIN_TOTP_DISABLED (dev only)', () => {
  it('lets an editor sign in to aud=admin without TOTP when the dev switch is on', async () => {
    const dev = await makeTestApp({ config: { adminTotpDisabled: true } });
    try {
      await makeUser(dev.deps, { role: 'editor', scopeId: 'bio' }, { email: 'ed2@example.kg', password: PASSWORD });
      const r = await dev.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: 'ed2@example.kg', password: PASSWORD }, headers: { 'x-bilig-audience': 'admin' } });
      expect(r.statusCode, r.body).toBe(200);
    } finally {
      await dev.close();
    }
  });

  it('is refused in production', async () => {
    const { loadConfig } = await import('../../config.js');
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), PSEUDONYM_SECRET: 'y'.repeat(16), ADMIN_TOTP_DISABLED: '1' })).toThrow(/dev-only/);
  });
});
