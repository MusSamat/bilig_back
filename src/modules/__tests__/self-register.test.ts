/** Contract 0.6.0: teachers register themselves (code by e-mail → personal school + trial licence → teacher cabinet). */
import { afterEach, describe, expect, it } from 'vitest';
import { RegisterResponseSchema } from '@bilig/content-model/api';
import { algebraKtp } from '../../ktp/__tests__/fixtures.js';
import { CODE_MAX_ATTEMPTS, CODE_TTL_MS } from '../auth.js';
import { loadConfig } from '../../config.js';
import { API, PASSWORD, json, makeSchoolWorld, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';

const OTP = '012345';
let t: TestCtx;
afterEach(() => t?.close());

const fixed = async () => (t = await makeTestApp({ config: { authFixedOtp: OTP, trialDays: 30 } }));

const register = (payload: Record<string, unknown>, ip?: string) =>
  t.inject({ method: 'POST', url: `${API}/auth/register`, payload: { password: PASSWORD, displayName: 'Айгүл Асанова', ...payload }, ...(ip ? { remoteAddress: ip } : {}) });
const verify = (email: string, code: string) => t.inject({ method: 'POST', url: `${API}/auth/register/verify`, payload: { email, code } });
const resend = (email: string) => t.inject({ method: 'POST', url: `${API}/auth/register/resend`, payload: { email } });
const login = (email: string, password = PASSWORD) => t.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email, password } });

async function signUp(email: string, extra: Record<string, unknown> = {}) {
  const reg = await register({ email, locale: 'ky', teaching: { subjects: ['bio', 'nosuch'], grades: [7, 8] }, ...extra });
  expect(reg.statusCode, reg.body).toBe(200);
  const res = await verify(email, OTP);
  expect(res.statusCode, res.body).toBe(200);
  return json(res).accessToken as string;
}

describe('register → verify with the fixed code', () => {
  it('signs in a teacher with a personal school, a trial licence and the whole teacher journey', async () => {
    await fixed();
    const email = 'aigul@example.kg';
    const reg = await register({ email: 'Aigul@Example.kg', locale: 'ky', teaching: { subjects: ['bio', 'nosuch'], grades: [7, 8] }, region: 'Ош' });
    expect(reg.statusCode, reg.body).toBe(200);
    expect(RegisterResponseSchema.parse(json(reg))).toEqual({ ok: true, expiresIn: 900, resendAfter: 60 });
    const mail = t.mailer.last('email_code')!;
    expect(mail).toMatchObject({ to: email, code: OTP });
    expect(mail.subject).toContain(OTP);
    expect(mail.text).toContain('мүнөт'); // Kyrgyz
    expect(mail.link).toMatch(/\/verify-email\?token=/);
    expect((await login(email)).statusCode).toBe(403); // pending: email_not_verified

    const res = await verify(email, OTP);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(String(res.headers['set-cookie'])).toMatch(/bilig_rt=/);
    const token = json(res).accessToken as string;
    // the code is consumed: a second verify fails cleanly
    expect(json(await verify(email, OTP))).toMatchObject({ code: 'invalid_credentials', detail: 'code_expired' });
    expect((await login(email)).statusCode).toBe(200);

    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token }));
    expect(me.teaching).toEqual({ subjects: ['bio'], grades: [7, 8] });
    expect(me.licenses).toHaveLength(1);
    expect(me.licenses[0]).toMatchObject({ schoolName: 'Айгүл Асанова — жеке мектеп', subjects: ['bio'], grades: [7, 8], trial: true, startsAt: t.clock.now().toISOString() });
    expect(new Date(me.licenses[0].endsAt).getTime() - t.clock.now().getTime()).toBe(30 * 86400_000);
    expect(me.permissions).toEqual(expect.arrayContaining(['class.manage', 'assignment.manage', 'lesson.plan', 'topic.view']));
    const schoolId = me.licenses[0].schoolId;
    expect(await t.repo.getSchool(schoolId)).toMatchObject({ origin: 'self', type: 'private', region: 'Ош', language: 'ky', status: 'active' });
    expect((await t.repo.getUserByEmail(email))?.signup ?? null).toBeNull();
    expect((await t.repo.listAudit({ action: 'auth.self_registered' }, { limit: 5 })).items).toHaveLength(1);

    // classes with a licensed subject; an unlicensed one is a clear 400
    const bad = await t.inject({ method: 'POST', url: `${API}/classes`, token, payload: { name: '7А', grade: 7, subjectKey: 'chem' } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad)).toMatchObject({ code: 'validation_failed', detail: 'subject_not_licensed', issues: [{ path: ['subjectKey'] }] });
    const created = await t.inject({ method: 'POST', url: `${API}/classes`, token, payload: { name: '7А', grade: 7, subjectKey: 'bio' } });
    expect(created.statusCode, created.body).toBe(200);
    const cls = json(created);
    expect(cls).toMatchObject({ schoolId, subjectKey: 'bio', studentCount: 0 });
    expect(json(await t.inject({ method: 'GET', url: `${API}/classes/${cls.id}`, token })).subjectKey).toBe('bio');
    expect((await t.inject({ method: 'PATCH', url: `${API}/classes/${cls.id}`, token, payload: { subjectKey: 'math' } })).statusCode).toBe(400);
    expect(json(await t.inject({ method: 'PATCH', url: `${API}/classes/${cls.id}`, token, payload: { subjectKey: null } })).subjectKey).toBeNull();

    // students, join code, assignment, КТП
    const added = await t.inject({ method: 'POST', url: `${API}/classes/${cls.id}/students`, token, payload: { students: [{ displayName: 'Бакыт' }, { displayName: 'Нургүл' }] } });
    expect(added.statusCode, added.body).toBe(200);
    const roster = await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: cls.joinCode } });
    expect(json(roster).students).toHaveLength(2);
    const asg = await t.inject({ method: 'POST', url: `${API}/classes/${cls.id}/assignments`, token, payload: { topicKey: 'animal-cell', activities: ['quiz'] } });
    expect(asg.statusCode, asg.body).toBe(200);
    const ktp = await t.inject({ method: 'POST', url: `${API}/ktp`, token, payload: { fileName: 'КТП алгебра 8.docx', data: algebraKtp().toString('base64') } });
    expect(ktp.statusCode, ktp.body).toBe(200);

    // licensed topic (bio, grade 7) opens
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token })).statusCode).toBe(200);
    // the class's students open it too (the class belongs to the licensed school)
    const studentLogin = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId: cls.id, studentId: json(added).items[0].student.id, pin: json(added).items[0].pin } });
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token: json(studentLogin).accessToken })).statusCode).toBe(200);
  });

  it('does not open a topic outside the trial licence; PATCH /me teaching moves the licence', async () => {
    await fixed();
    const token = await signUp('g8@example.kg', { teaching: { subjects: ['bio'], grades: [8] } });
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token })).statusCode).toBe(403); // grade 7 unlicensed
    expect((await t.inject({ method: 'GET', url: `${API}/topics/demo-cell/manifest`, token })).statusCode).toBe(200); // demo stays open

    const before = json(await t.inject({ method: 'GET', url: `${API}/me`, token })).licenses[0];
    t.clock.advance(60_000);
    const p = await t.inject({ method: 'PATCH', url: `${API}/me`, token, payload: { teaching: { subjects: ['bio', 'nosuch'], grades: [9, 7] }, displayName: 'Айгүл А.' } });
    expect(p.statusCode, p.body).toBe(200);
    expect(json(p)).toMatchObject({ displayName: 'Айгүл А.', teaching: { subjects: ['bio'], grades: [7, 9] } });
    expect(json(p).licenses[0]).toMatchObject({ startsAt: before.startsAt, endsAt: before.endsAt, trial: true }); // dates unchanged
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token })).statusCode).toBe(200);
    expect((await t.repo.listAudit({ action: 'license.updated' }, { limit: 5 })).items).toHaveLength(1);

    const none = await t.inject({ method: 'PATCH', url: `${API}/me`, token, payload: { teaching: { subjects: ['nosuch'], grades: [7] } } });
    expect(none.statusCode).toBe(400);
    expect(json(none).issues[0].path).toEqual(['teaching', 'subjects']);
  });

  it('PATCH /me teaching is 403 for a teacher of an admin-created school', async () => {
    await fixed();
    const w = await makeSchoolWorld(t.deps);
    const res = await t.inject({ method: 'PATCH', url: `${API}/me`, token: w.teacher.token, payload: { teaching: { subjects: ['bio'], grades: [7] } } });
    expect(res.statusCode).toBe(403);
    expect(json(res).detail).toBe('teaching_not_editable');
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token: w.teacher.token }));
    expect(me.teaching).toBeUndefined();
    expect(me.licenses).toEqual([expect.objectContaining({ schoolId: w.school.id, schoolName: w.school.name, trial: false, subjects: ['bio'], grades: [7] })]);
    // a user without schools: no licences block, no teaching
    const loner = await makeUser(t.deps);
    expect(json(await t.inject({ method: 'GET', url: `${API}/me`, token: loner.token }))).not.toHaveProperty('licenses');
    expect((await t.inject({ method: 'PATCH', url: `${API}/me`, token: loner.token, payload: { teaching: { subjects: ['bio'], grades: [7] } } })).statusCode).toBe(403);
  });

  it('names the school as given and in the user language otherwise', async () => {
    await fixed();
    const a = await signUp('named@example.kg', { schoolName: 'Ош шаарындагы №5 мектеп' });
    expect(json(await t.inject({ method: 'GET', url: `${API}/me`, token: a })).licenses[0].schoolName).toBe('Ош шаарындагы №5 мектеп');
    const b = await signUp('ru@example.kg', { locale: 'ru', displayName: 'Иван' });
    expect(json(await t.inject({ method: 'GET', url: `${API}/me`, token: b })).licenses[0].schoolName).toBe('Иван — личная школа');
    expect(t.mailer.last('email_code')!.text).toContain('минут');
  });

  it('registration without teaching gives an empty trial the teacher fills through PATCH /me', async () => {
    await fixed();
    await register({ email: 'plain@example.kg' });
    const token = json(await verify('plain@example.kg', OTP)).accessToken;
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token }));
    expect(me.teaching).toBeUndefined();
    expect(me.licenses[0]).toMatchObject({ subjects: [], grades: [], trial: true });
    expect(json(await t.inject({ method: 'PATCH', url: `${API}/me`, token, payload: { teaching: { subjects: ['bio'], grades: [7] } } })).teaching).toEqual({ subjects: ['bio'], grades: [7] });
  });
});

describe('codes', () => {
  it(`${CODE_MAX_ATTEMPTS} wrong codes burn it; a resend gives a fresh one`, async () => {
    await fixed();
    await register({ email: 'w@example.kg' });
    for (let i = 1; i < CODE_MAX_ATTEMPTS; i++) expect(json(await verify('w@example.kg', '999999'))).toMatchObject({ code: 'invalid_credentials', detail: 'code_invalid' });
    expect(json(await verify('w@example.kg', '999999'))).toMatchObject({ detail: 'code_expired' }); // 5th: burned
    expect(json(await verify('w@example.kg', OTP))).toMatchObject({ detail: 'code_expired' }); // even the right one
    t.clock.advance(61_000);
    expect((await resend('w@example.kg')).statusCode).toBe(200);
    expect((await verify('w@example.kg', OTP)).statusCode).toBe(200);
  });

  it('expires after 15 minutes', async () => {
    await fixed();
    await register({ email: 'x@example.kg' });
    t.clock.advance(CODE_TTL_MS);
    expect(json(await verify('x@example.kg', OTP))).toMatchObject({ code: 'invalid_credentials', detail: 'code_expired' });
  });

  it('resend: 429 with Retry-After within 60 s, then a new code invalidates the old one (random codes)', async () => {
    t = await makeTestApp(); // no AUTH_FIXED_OTP: random codes
    await register({ email: 'r@example.kg', locale: 'en' });
    const first = t.mailer.last('email_code')!;
    expect(first.code).toMatch(/^\d{6}$/);
    expect(first.text).toContain(first.code!);
    expect(first.subject).toContain('confirmation code');
    const soon = await resend('r@example.kg');
    expect(soon.statusCode).toBe(429);
    expect(json(soon)).toMatchObject({ code: 'rate_limited', detail: 'resend_too_soon' });
    expect(Number(soon.headers['retry-after'])).toBeGreaterThan(0);
    t.clock.advance(60_000);
    expect(RegisterResponseSchema.parse(json(await resend('r@example.kg')))).toMatchObject({ ok: true });
    const second = t.mailer.last('email_code')!;
    expect(second).not.toBe(first);
    if (second.code !== first.code) expect(json(await verify('r@example.kg', first.code!)).detail).toBe('code_invalid');
    const ok = await verify('r@example.kg', second.code!);
    expect(ok.statusCode, ok.body).toBe(200);
    // an unknown address answers the same and sends nothing
    t.clock.advance(60_000);
    const n = t.mailer.outbox.length;
    expect(json(await resend('nobody@example.kg'))).toEqual({ ok: true, expiresIn: 900, resendAfter: 60 });
    expect(t.mailer.outbox.length).toBe(n);
  });

  it('unknown address on verify gives the same answer as an expired code', async () => {
    await fixed();
    expect(json(await verify('ghost@example.kg', OTP))).toMatchObject({ code: 'invalid_credentials', detail: 'code_expired' });
  });
});

describe('no enumeration, restarts, the v0.2.1 link', () => {
  it('a taken address: same response, an «account exists» mail with a reset link instead of a code', async () => {
    await fixed();
    await makeUser(t.deps, undefined, { email: 'taken@example.kg', password: PASSWORD });
    const fresh = await register({ email: 'free@example.kg' });
    const taken = await register({ email: 'taken@example.kg' });
    expect(taken.statusCode).toBe(200);
    expect(json(taken)).toEqual(json(fresh));
    const mail = t.mailer.last()!;
    expect(mail).toMatchObject({ kind: 'account_exists', to: 'taken@example.kg' });
    expect(mail.code).toBeUndefined();
    const token = new URL(mail.link).searchParams.get('token')!;
    expect((await t.inject({ method: 'POST', url: `${API}/auth/password/reset`, payload: { token, password: 'Brand-New-Pass-2026' } })).statusCode).toBe(200);
    expect(json(await verify('taken@example.kg', OTP)).detail).toBe('code_expired'); // active accounts have no code
  });

  it('a pending address can restart: new password, name and details, new code', async () => {
    await fixed();
    await register({ email: 'p@example.kg', displayName: 'Typo', teaching: { subjects: ['bio'], grades: [5] } });
    const re = await register({ email: 'p@example.kg', displayName: 'Айгүл', password: 'Second-Pass-2026', teaching: { subjects: ['bio'], grades: [7] }, schoolName: 'Лицей' });
    expect(re.statusCode).toBe(200);
    expect(t.mailer.outbox.filter((m) => m.kind === 'email_code')).toHaveLength(2);
    const token = json(await verify('p@example.kg', OTP)).accessToken;
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token }));
    expect(me).toMatchObject({ displayName: 'Айгүл', teaching: { subjects: ['bio'], grades: [7] } });
    expect(me.licenses[0].schoolName).toBe('Лицей');
    expect((await login('p@example.kg', 'Second-Pass-2026')).statusCode).toBe(200);
    expect((await login('p@example.kg')).statusCode).toBe(401);
  });

  it('the link from the code mail still verifies — and provisions the same workspace', async () => {
    t = await makeTestApp();
    await register({ email: 'link@example.kg', teaching: { subjects: ['bio'], grades: [7] } });
    const mail = t.mailer.last('email_code')!;
    const token = new URL(mail.link).searchParams.get('token')!;
    expect((await t.inject({ method: 'POST', url: `${API}/auth/email/verify`, payload: { token } })).statusCode).toBe(200);
    expect(json(await verify('link@example.kg', mail.code!)).detail).toBe('code_expired'); // the code died with the link
    const res = await login('link@example.kg');
    expect(res.statusCode).toBe(200);
    const me = json(await t.inject({ method: 'GET', url: `${API}/me`, token: json(res).accessToken }));
    expect(me.teaching).toEqual({ subjects: ['bio'], grades: [7] });
    expect(me.licenses).toHaveLength(1);
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token: json(res).accessToken })).statusCode).toBe(200);
  });
});

describe('rate limits', () => {
  it('10 registrations per IP per hour', async () => {
    await fixed();
    for (let i = 0; i < 10; i++) expect((await register({ email: `ip${i}@example.kg` }, '10.1.1.1')).statusCode).toBe(200);
    expect((await register({ email: 'ip10@example.kg' }, '10.1.1.1')).statusCode).toBe(429);
    expect((await register({ email: 'ip10@example.kg' }, '10.1.1.2')).statusCode).toBe(200);
  });

  it('5 registrations per e-mail per hour', async () => {
    await fixed();
    for (let i = 0; i < 5; i++) expect((await register({ email: 'same@example.kg' }, `10.2.0.${i}`)).statusCode).toBe(200);
    expect((await register({ email: 'same@example.kg' }, '10.2.0.9')).statusCode).toBe(429);
    t.clock.advance(3600_000);
    expect((await register({ email: 'same@example.kg' }, '10.2.0.9')).statusCode).toBe(200);
  });
});

describe('config', () => {
  const base = { NODE_ENV: 'test', STORAGE: 'memory' } as const;
  it('AUTH_FIXED_OTP must be 6 digits; TRIAL_DAYS 1..365, default 30', () => {
    expect(loadConfig({ ...base }).authFixedOtp).toBeUndefined();
    expect(loadConfig({ ...base, AUTH_FIXED_OTP: '' }).authFixedOtp).toBeUndefined();
    expect(loadConfig({ ...base, AUTH_FIXED_OTP: '012345' }).authFixedOtp).toBe('012345');
    expect(() => loadConfig({ ...base, AUTH_FIXED_OTP: '12345' })).toThrow(/6 digits/);
    expect(() => loadConfig({ ...base, AUTH_FIXED_OTP: 'abcdef' })).toThrow();
    expect(loadConfig({ ...base }).trialDays).toBe(30);
    expect(loadConfig({ ...base, TRIAL_DAYS: '14' }).trialDays).toBe(14);
    expect(() => loadConfig({ ...base, TRIAL_DAYS: '0' })).toThrow();
    expect(() => loadConfig({ ...base, TRIAL_DAYS: '366' })).toThrow();
  });
});
