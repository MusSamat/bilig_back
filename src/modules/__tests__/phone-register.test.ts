/** Contract 0.7.0: phone-first teacher accounts (WhatsApp code → token → password; login by phone). */
import { afterEach, describe, expect, it } from 'vitest';
import { OtpStartResponseSchema, OtpVerifyResponseSchema, TokenResponseSchema } from '@bilig/content-model/api';
import { loadConfig } from '../../config.js';
import { newId } from '../../ids.js';
import { hashSecret } from '../../domain/passwords.js';
import { ConsoleOtpSender, MemoryOtpSender, WhatsAppOtpSender } from '../../services/otp-sender.js';
import { OTP_MAX_ATTEMPTS, OTP_TOKEN_TTL_MS, OTP_TTL_MS } from '../auth.js';
import { API, PASSWORD, json, makeSchoolWorld, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';

const OTP = '012345';
const PHONE = '+996555123456';
let t: TestCtx;
afterEach(() => t?.close());

const fixed = async () => (t = await makeTestApp({ config: { authFixedOtp: OTP, trialDays: 30 } }));
const sent = () => t.deps.otp as MemoryOtpSender;

const post = (path: string, payload: Record<string, unknown>, extra: { ip?: string; headers?: Record<string, string> } = {}) =>
  t.inject({ method: 'POST', url: `${API}${path}`, payload, ...(extra.ip ? { remoteAddress: extra.ip } : {}), ...(extra.headers ? { headers: extra.headers } : {}) });
const start = (phone: string, purpose: 'register' | 'reset' = 'register', locale?: string) => post('/auth/otp/start', { phone, purpose, ...(locale ? { locale } : {}) });
const verify = (phone: string, code: string, purpose: 'register' | 'reset' = 'register') => post('/auth/otp/verify', { phone, purpose, code });
const complete = (token: string, password = PASSWORD) => post('/auth/register/complete', { token, password });
const setPassword = (token: string, password: string) => post('/auth/password/set', { token, password });
const login = (body: Record<string, unknown>, headers?: Record<string, string>) => post('/auth/login', { password: PASSWORD, ...body }, { headers });
const me = (token: string) => t.inject({ method: 'GET', url: `${API}/me`, token });
const patchMe = (token: string, payload: Record<string, unknown>) => t.inject({ method: 'PATCH', url: `${API}/me`, token, payload });

/** start → verify → token. */
async function otpToken(phone: string, purpose: 'register' | 'reset' = 'register', locale?: string) {
  const s = await start(phone, purpose, locale);
  expect(s.statusCode, s.body).toBe(200);
  const v = await verify(phone, OTP, purpose);
  expect(v.statusCode, v.body).toBe(200);
  return json(v).token as string;
}

async function signUp(phone = PHONE, locale?: string) {
  const res = await complete(await otpToken(phone, 'register', locale));
  expect(res.statusCode, res.body).toBe(200);
  return json(res).accessToken as string;
}

describe('register by phone with the fixed code', () => {
  it('start → verify → complete signs in; the cabinet finishes the setup; class + licensed topic', async () => {
    await fixed();
    const s = await start('0555 12-34-56', 'register', 'ru');
    expect(s.statusCode, s.body).toBe(200);
    expect(OtpStartResponseSchema.parse(json(s))).toEqual({ ok: true, channel: 'whatsapp', expiresIn: 600, resendAfter: 60 });
    expect(sent().last()).toMatchObject({ phone: PHONE, code: OTP, purpose: 'register', locale: 'ru' });

    const v = await verify('996555123456', OTP);
    expect(v.statusCode, v.body).toBe(200);
    const { token, expiresIn } = OtpVerifyResponseSchema.parse(json(v));
    expect(expiresIn).toBe(900);

    const c = await complete(token);
    expect(c.statusCode, c.body).toBe(200);
    expect(TokenResponseSchema.parse(json(c))).toMatchObject({ tokenType: 'Bearer' });
    expect(String(c.headers['set-cookie'])).toMatch(/bilig_rt=/);
    const access = json(c).accessToken as string;

    const user = (await t.repo.getUserByPhone(PHONE))!;
    expect(user).toMatchObject({ kind: 'adult', email: null, emailVerifiedAt: null, phone: PHONE, displayName: '+996 555 12 34 56', locale: 'ru', status: 'active' });
    expect(user.phoneVerifiedAt).toEqual(t.clock.now());
    const audit = (await t.repo.listAudit({ action: 'auth.self_registered' }, { limit: 5 })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.diff).toMatchObject({ method: 'phone', subjects: [], grades: [] });

    let m = json(await me(access));
    expect(m).toMatchObject({ phone: PHONE, displayName: '+996 555 12 34 56', setup: { name: false, school: false, teaching: false, teachingLang: false, classWithSubject: false }, profileStatus: 'incomplete' });
    expect(m).not.toHaveProperty('email');
    expect(m.teaching).toBeUndefined();
    expect(m.licenses).toEqual([expect.objectContaining({ schoolName: 'Моя школа', subjects: [], grades: [], trial: true })]);
    expect(new Date(m.licenses[0].endsAt).getTime() - t.clock.now().getTime()).toBe(30 * 86400_000);
    const schoolId = m.licenses[0].schoolId as string;
    expect(await t.repo.getSchool(schoolId)).toMatchObject({ origin: 'self', name: 'Моя школа', language: 'ru' });

    const p1 = await patchMe(access, { displayName: 'Айгүл Асанова' });
    expect(json(p1).setup).toEqual({ name: true, school: false, teaching: false, teachingLang: false, classWithSubject: false });
    const p2 = await patchMe(access, { schoolName: 'Ош, №5 мектеп', region: 'Ош', teaching: { subjects: ['bio'], grades: [7] } });
    expect(p2.statusCode, p2.body).toBe(200);
    m = json(p2);
    expect(m.setup).toEqual({ name: true, school: true, teaching: true, teachingLang: false, classWithSubject: false });
    expect(m.profileStatus).toBe('incomplete');
    expect(m.teaching).toEqual({ subjects: ['bio'], grades: [7] });
    expect(m.licenses[0].schoolName).toBe('Ош, №5 мектеп');
    expect(await t.repo.getSchool(schoolId)).toMatchObject({ name: 'Ош, №5 мектеп', region: 'Ош' });
    expect((await t.repo.listAudit({ action: 'school.updated' }, { limit: 5 })).items).toHaveLength(1);

    const cls = await t.inject({ method: 'POST', url: `${API}/classes`, token: access, payload: { name: '7А', grade: 7, subjectKey: 'bio' } });
    expect(cls.statusCode, cls.body).toBe(200);
    expect(json(cls).schoolId).toBe(schoolId);
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token: access })).statusCode).toBe(200);

    // the password works for a phone login, in any spelling of the number
    expect((await login({ phone: '0555 12 34 56' })).statusCode).toBe(200);
    expect((await login({ phone: '+996 555 12 34 56' })).statusCode).toBe(200);
  });

  it('the placeholder school name follows the language (ky by default)', async () => {
    await fixed();
    const a = await signUp('+996700000001');
    expect(json(await me(a)).licenses[0].schoolName).toBe('Менин мектебим');
    const b = await signUp('+996700000002', 'en');
    expect(json(await me(b)).licenses[0].schoolName).toBe('My school');
  });

  it('random codes reach the sender (no AUTH_FIXED_OTP)', async () => {
    t = await makeTestApp();
    await start(PHONE, 'register', 'en');
    const msg = sent().last(PHONE)!;
    expect(msg.code).toMatch(/^\d{6}$/);
    expect(msg.text).toContain(msg.code!);
    expect(msg.text).toContain('10 minutes');
    const v = await verify(PHONE, msg.code!);
    expect(v.statusCode, v.body).toBe(200);
    expect((await complete(json(v).token)).statusCode).toBe(200);
  });
});

describe('no enumeration', () => {
  it('register for a taken number: same answer, an «account exists» message, no code', async () => {
    await fixed();
    await signUp();
    const before = sent().outbox.length;
    t.clock.advance(61_000);
    const taken = await start(PHONE);
    const free = await start('+996700111222');
    expect(taken.statusCode).toBe(200);
    expect(json(taken)).toEqual(json(free));
    const msgs = sent().outbox.slice(before);
    expect(msgs.find((m) => m.phone === PHONE)).toMatchObject({ purpose: 'account_exists', code: null });
    expect(msgs.find((m) => m.phone === PHONE)!.text).toMatch(/аккаунт/);
    expect(json(await verify(PHONE, OTP))).toMatchObject({ code: 'invalid_credentials', detail: 'code_expired' });
  });

  it('reset for an unknown number: same answer, nothing sent; verify says code_expired', async () => {
    await fixed();
    const res = await start('+996777000000', 'reset');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, channel: 'whatsapp', expiresIn: 600, resendAfter: 60 });
    expect(sent().outbox).toHaveLength(0);
    expect(json(await verify('+996777000000', OTP, 'reset'))).toMatchObject({ detail: 'code_expired' });
  });

  it('a blocked account gets no reset code', async () => {
    await fixed();
    await signUp();
    const u = (await t.repo.getUserByPhone(PHONE))!;
    await t.repo.updateUser(u.id, { status: 'blocked' });
    const n = sent().outbox.length;
    expect((await start(PHONE, 'reset')).statusCode).toBe(200);
    expect(sent().outbox.length).toBe(n);
  });
});

describe('codes and tokens', () => {
  it('resend within 60 s: 429 with Retry-After for every number, known or not', async () => {
    await fixed();
    await signUp();
    t.clock.advance(61_000);
    for (const phone of [PHONE, '+996700999888']) {
      expect((await start(phone)).statusCode).toBe(200);
      const soon = await start(phone);
      expect(soon.statusCode).toBe(429);
      expect(json(soon)).toMatchObject({ code: 'rate_limited', detail: 'resend_too_soon' });
      expect(Number(soon.headers['retry-after'])).toBeGreaterThan(0);
    }
    t.clock.advance(60_000);
    expect((await start('+996700999888')).statusCode).toBe(200);
  });

  it('a new code invalidates the old one; 5 starts per number per hour', async () => {
    t = await makeTestApp();
    await start(PHONE);
    const first = sent().last()!.code!;
    for (let i = 0; i < 4; i++) {
      t.clock.advance(61_000);
      expect((await start(PHONE)).statusCode).toBe(200);
    }
    const last = sent().last()!.code!;
    if (first !== last) expect(json(await verify(PHONE, first)).detail).toBe('code_invalid');
    t.clock.advance(61_000);
    expect((await start(PHONE)).statusCode).toBe(429); // 6th in the hour
    expect((await verify(PHONE, last)).statusCode).toBe(200);
  });

  it(`${OTP_MAX_ATTEMPTS} wrong codes burn it`, async () => {
    await fixed();
    await start(PHONE);
    for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) expect(json(await verify(PHONE, '999999'))).toMatchObject({ code: 'invalid_credentials', detail: 'code_invalid' });
    const fifth = await verify(PHONE, '999999');
    expect(fifth.statusCode).toBe(401);
    expect(json(fifth).detail).toBe('code_expired');
    expect(json(await verify(PHONE, OTP)).detail).toBe('code_expired'); // even the right one
    t.clock.advance(61_000);
    await start(PHONE);
    expect((await verify(PHONE, OTP)).statusCode).toBe(200);
  });

  it('codes expire after 10 minutes, tokens after 15', async () => {
    await fixed();
    await start(PHONE);
    t.clock.advance(OTP_TTL_MS);
    expect(json(await verify(PHONE, OTP))).toMatchObject({ code: 'invalid_credentials', detail: 'code_expired' });
    t.clock.advance(1000);
    const token = await otpToken(PHONE);
    t.clock.advance(OTP_TOKEN_TTL_MS);
    expect(json(await complete(token))).toMatchObject({ code: 'not_found', detail: 'token_invalid' });
  });

  it('a code is for its purpose; a token is single use and bound to its purpose', async () => {
    await fixed();
    await start(PHONE, 'register');
    expect(json(await verify(PHONE, OTP, 'reset')).detail).toBe('code_expired');
    const reg = json(await verify(PHONE, OTP, 'register')).token as string;
    expect(json(await verify(PHONE, OTP, 'register')).detail).toBe('code_expired'); // the code is consumed
    // a register token cannot set a password (and is not consumed by trying)
    expect(json(await setPassword(reg, 'Brand-New-Pass-2026'))).toMatchObject({ code: 'not_found', detail: 'token_invalid' });
    expect((await complete(reg)).statusCode).toBe(200);
    expect(json(await complete(reg))).toMatchObject({ detail: 'token_invalid' }); // single use
    // a reset token cannot register
    const reset = await otpToken(PHONE, 'reset');
    expect(json(await complete(reset))).toMatchObject({ detail: 'token_invalid' });
    expect((await setPassword(reset, 'Brand-New-Pass-2026')).statusCode).toBe(200);
    expect(json(await complete('x'.repeat(43)))).toMatchObject({ detail: 'token_invalid' });
  });

  it('a weak password (or the number in it) keeps the token usable', async () => {
    await fixed();
    const token = await otpToken(PHONE);
    const weak = await complete(token, 'Pass555123456');
    expect(weak.statusCode).toBe(400);
    expect(json(weak)).toMatchObject({ code: 'password_weak', detail: 'too_simple' });
    expect((await complete(token)).statusCode).toBe(200);
  });

  it('the number registered meanwhile → 409', async () => {
    await fixed();
    const token = await otpToken(PHONE);
    await t.repo.createUser({ id: newId(), kind: 'adult', email: null, emailVerifiedAt: null, phone: PHONE, phoneVerifiedAt: t.clock.now(), displayName: 'other', locale: 'ky', status: 'active' });
    const res = await complete(token);
    expect(res.statusCode).toBe(409);
    expect(json(res)).toMatchObject({ code: 'conflict', detail: 'phone_taken' });
  });
});

describe('password reset by phone', () => {
  it('sets the password, signs in and revokes every other session', async () => {
    await fixed();
    await signUp();
    const other = await login({ phone: PHONE });
    expect(other.statusCode).toBe(200);
    const u = (await t.repo.getUserByPhone(PHONE))!;
    expect(await t.repo.listActiveSessions(u.id, t.clock.now())).toHaveLength(2);

    t.clock.advance(1000);
    const token = await otpToken(PHONE, 'reset');
    expect(sent().last()).toMatchObject({ purpose: 'reset', locale: 'ky' });
    const res = await setPassword(token, 'Brand-New-Pass-2026');
    expect(res.statusCode, res.body).toBe(200);
    expect(TokenResponseSchema.parse(json(res)).tokenType).toBe('Bearer');
    const active = await t.repo.listActiveSessions(u.id, t.clock.now());
    expect(active).toHaveLength(1);
    expect((await me(json(other).accessToken)).statusCode).toBe(401); // the old session is gone
    expect((await me(json(res).accessToken)).statusCode).toBe(200);
    expect((await login({ phone: PHONE })).statusCode).toBe(401);
    expect((await login({ phone: PHONE, password: 'Brand-New-Pass-2026' })).statusCode).toBe(200);
    expect((await t.repo.listAudit({ action: 'auth.password_reset' }, { limit: 5 })).items[0]!.diff).toMatchObject({ via: 'phone_code' });
  });
});

describe('login', () => {
  it('by phone or by e-mail, exactly one', async () => {
    await fixed();
    await signUp();
    await makeUser(t.deps, undefined, { email: 'staff@example.kg', password: PASSWORD });
    expect((await login({ email: 'staff@example.kg' })).statusCode).toBe(200);
    expect((await login({ phone: '555123456' })).statusCode).toBe(200);
    expect((await login({ phone: PHONE, password: 'Wrong-Password-123' })).statusCode).toBe(401);
    const unknown = await login({ phone: '+996700000000' });
    expect(unknown.statusCode).toBe(401);
    expect(json(unknown).code).toBe('invalid_credentials');
    expect((await login({ phone: PHONE, email: 'staff@example.kg' })).statusCode).toBe(400);
    expect((await login({})).statusCode).toBe(400);
    expect((await login({ phone: '+7 701 123 45 67' })).statusCode).toBe(400);
  });

  it('a blocked phone account is 403 account_blocked', async () => {
    await fixed();
    await signUp();
    const u = (await t.repo.getUserByPhone(PHONE))!;
    await t.repo.updateUser(u.id, { status: 'blocked' });
    const res = await login({ phone: PHONE });
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'forbidden', detail: 'account_blocked' });
  });

  it('the admin audience stays e-mail: a phone login there is 400 email_required', async () => {
    await fixed();
    await signUp();
    const res = await login({ phone: PHONE }, { 'x-bilig-audience': 'admin' });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ code: 'validation_failed', detail: 'email_required' });
    // the same answer for an unknown number (no lookup)
    expect(json(await login({ phone: '+996700000000' }, { 'x-bilig-audience': 'admin' })).detail).toBe('email_required');
  });

  it('per-number rate limit: 10 tries per 15 minutes', async () => {
    await fixed();
    const u = await t.repo.createUser({ id: newId(), kind: 'adult', email: null, emailVerifiedAt: null, phone: PHONE, displayName: 'x', locale: 'ky', status: 'active' });
    if (u === 'conflict') throw new Error('conflict');
    await t.repo.setCredential(u.id, 'password', await hashSecret(PASSWORD));
    for (let i = 0; i < 10; i++) expect((await post('/auth/login', { phone: PHONE, password: 'Wrong-Password-123' }, { ip: `10.9.0.${i}` })).statusCode).toBe(401);
    expect((await post('/auth/login', { phone: '0555123456', password: PASSWORD }, { ip: '10.9.1.1' })).statusCode).toBe(429);
  });
});

describe('PATCH /me school', () => {
  it('schoolName / region only for the own self school', async () => {
    await fixed();
    const w = await makeSchoolWorld(t.deps);
    const res = await patchMe(w.teacher.token, { schoolName: 'Чужая школа' });
    expect(res.statusCode).toBe(403);
    expect(json(res).detail).toBe('school_not_editable');
    expect((await t.repo.getSchool(w.school.id))!.name).toBe(w.school.name);
    // v0.8.0: school teachers get the checklist too; their school is set by the admins.
    expect(json(await me(w.teacher.token)).setup).toMatchObject({ school: true, teaching: true });
    const loner = await makeUser(t.deps);
    expect(json(await patchMe(loner.token, { region: 'Ош' })).detail).toBe('school_not_editable');
    // validation before writes: a forbidden teaching leaves the profile untouched
    expect((await patchMe(loner.token, { displayName: 'New', teaching: { subjects: ['bio'], grades: [7] } })).statusCode).toBe(403);
    expect((await t.repo.getUser(loner.user.id))!.displayName).not.toBe('New');
  });

  it('a 0.6.0 e-mail teacher gets setup too', async () => {
    await fixed();
    await post('/auth/register', { email: 'e@example.kg', password: PASSWORD, displayName: 'Айгүл', teaching: { subjects: ['bio'], grades: [7] } });
    const token = json(await post('/auth/register/verify', { email: 'e@example.kg', code: OTP })).accessToken;
    expect(json(await me(token)).setup).toEqual({ name: true, school: true, teaching: true, teachingLang: false, classWithSubject: false });
  });
});

describe('OTP sender and config', () => {
  const base = { NODE_ENV: 'test', STORAGE: 'memory' } as const;
  const prod = { NODE_ENV: 'production', STORAGE: 'memory', JWT_SECRET: 'x'.repeat(32), PSEUDONYM_SECRET: 'y'.repeat(16) } as const;

  it('the console sender prints the WhatsApp message', async () => {
    const out: string[] = [];
    await new ConsoleOtpSender((s) => out.push(s)).send(PHONE, '123456', 'ru', 'register');
    expect(out.join('')).toContain('WhatsApp → +996 555 12 34 56');
    expect(out.join('')).toContain('123456');
    await expect(new WhatsAppOtpSender().send()).rejects.toThrow(/not configured/);
  });

  it('defaults: fixed with AUTH_FIXED_OTP, console in development, refused in production without a sender', () => {
    expect(loadConfig({ ...base, AUTH_FIXED_OTP: OTP }).otpSender).toBe('fixed');
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).otpSender).toBe('console');
    expect(loadConfig({ ...prod, AUTH_FIXED_OTP: OTP }).otpSender).toBe('fixed');
    expect(() => loadConfig({ ...prod })).toThrow(/No working sender for phone one-time codes/);
    expect(() => loadConfig({ ...prod, OTP_SENDER: 'whatsapp' })).toThrow(/not configured/);
    expect(() => loadConfig({ ...prod, OTP_SENDER: 'console' })).toThrow(/refused in production/);
    expect(() => loadConfig({ ...base, OTP_SENDER: 'fixed' })).toThrow(/requires AUTH_FIXED_OTP/);
    expect(() => loadConfig({ ...base, OTP_SENDER: 'sms' })).toThrow();
    expect(loadConfig({ ...base, NODE_ENV: 'development', AUTH_FIXED_OTP: OTP, OTP_SENDER: 'console' }).otpSender).toBe('console');
  });
});
