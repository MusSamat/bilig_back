import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totpAt } from '../domain/totp.js';
import { API, json, makeTestApp, type TestCtx } from '../test/helpers.js';
import { DEMO_EMAILS, DEMO_JOIN_CODE, DEMO_PASSWORD, DEMO_PIN, DEMO_SCHOOL_NAME, DEMO_STUDENTS, assertDemoAllowed, seedDemo } from './demo-seed.js';

let t: TestCtx;
const lines: string[] = [];
const seed = () => seedDemo(t.repo, { ...t.deps, log: (l) => lines.push(l) });

beforeEach(async () => {
  t = await makeTestApp();
  lines.length = 0;
});
afterEach(() => t.close());

const login = (email: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  t.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email, password: DEMO_PASSWORD, ...extra }, headers });

async function counts() {
  const schools = (await t.repo.listSchools({}, { limit: 100 })).items;
  const school = schools.find((s) => s.name === DEMO_SCHOOL_NAME)!;
  const classes = (await t.repo.listClasses({ schoolIds: [school.id] }, { limit: 100 })).items;
  return {
    schools: schools.filter((s) => s.name === DEMO_SCHOOL_NAME).length,
    licences: (await t.repo.listLicenses({ schoolIds: [school.id] }, { limit: 100 })).items.length,
    classes: classes.length,
    enrolments: (await t.repo.listEnrollments({ classIds: classes.map((c) => c.id) })).length,
    assignments: (await t.repo.listAssignments({ classIds: classes.map((c) => c.id) }, { limit: 100 })).items.length,
    users: (await t.repo.listUsers({}, { limit: 1000 })).items.length,
    teacherGrants: (await t.repo.listGrants((await t.repo.getUserByEmail(DEMO_EMAILS.teacher))!.id)).length,
  };
}

describe('demo seed', () => {
  it('creates a working teacher and student login', async () => {
    const report = await seed();
    expect(report.created).toBe(true);

    const res = await login(DEMO_EMAILS.teacher);
    expect(res.statusCode, res.body).toBe(200);
    const token = json(res).accessToken as string;
    const classes = await t.inject({ method: 'GET', url: `${API}/classes`, token });
    expect(classes.statusCode, classes.body).toBe(200);
    expect(json(classes).items).toMatchObject([{ name: '7А', grade: 7, joinCode: DEMO_JOIN_CODE, studentCount: 5 }]);

    const code = await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: 'demo77' } });
    expect(code.statusCode, code.body).toBe(200);
    const { classId, students } = json(code) as { classId: string; students: { id: string; displayName: string }[] };
    expect(students.map((s) => s.displayName).sort()).toEqual([...DEMO_STUDENTS].sort());
    const student = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId, studentId: students[0].id, pin: DEMO_PIN } });
    expect(student.statusCode, student.body).toBe(200);

    const mine = await t.inject({ method: 'GET', url: `${API}/me/assignments`, token: json(student).accessToken });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(json(mine).items).toMatchObject([{ topicKey: 'animal-cell', activities: ['tour', 'quiz'], status: 'not_started' }]);
    const due = new Date(json(mine).items[0].dueAt).getTime() - t.clock.now().getTime();
    expect(due).toBe(7 * 24 * 3600 * 1000);
  });

  it('logs the school admin in and licenses the school for live subjects, grades 6–11', async () => {
    const { schoolId } = await seed();
    expect((await login(DEMO_EMAILS.schoolAdmin)).statusCode).toBe(200);
    const [lic] = (await t.repo.listLicenses({ schoolIds: [schoolId] }, { limit: 10 })).items;
    expect(lic.subjects).toContain('bio');
    expect(lic.grades).toEqual([6, 7, 8, 9, 10, 11]);
    expect(lic.endsAt.getTime() - lic.startsAt.getTime()).toBe(365 * 24 * 3600 * 1000);
  });

  it('enrols the superadmin in TOTP and prints the secret', async () => {
    const { totp } = await seed();
    expect(totp?.otpauthUrl).toContain(`secret=${totp?.secret}`);
    expect(lines.join('\n')).toContain(totp!.otpauthUrl);
    const admin = { 'x-bilig-audience': 'admin' };
    expect(json(await login(DEMO_EMAILS.superadmin, {}, admin)).code).toBe('totp_required');
    const ok = await login(DEMO_EMAILS.superadmin, { totp: totpAt(totp!.secret, t.clock.now()) }, admin);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('is idempotent', async () => {
    const first = await seed();
    const before = await counts();
    expect(before).toMatchObject({ schools: 1, licences: 1, classes: 1, enrolments: 6, assignments: 1, teacherGrants: 1 });
    const second = await seed();
    expect(second.created).toBe(false);
    expect(second.schoolId).toBe(first.schoolId);
    expect(second.totp?.secret).toBe(first.totp?.secret);
    expect(await counts()).toEqual(before);
    expect((await login(DEMO_EMAILS.teacher)).statusCode).toBe(200);
  });

  it('refuses to run in production', async () => {
    expect(() => assertDemoAllowed('production')).toThrow(/production/);
    await expect(seedDemo(t.repo, { ...t.deps, config: { env: 'production' } })).rejects.toThrow(/production/);
    expect((await t.repo.listSchools({}, { limit: 10 })).items).toHaveLength(0);
  });
});
