/**
 * DEV-ONLY demo dataset (`DEMO_SEED=1` at startup, or `npm run db:seed:demo`):
 * one licensed school with an admin, a verified teacher, a class 7А (join code
 * DEMO77) with five students (PIN 1234), an animal-cell assignment, and a
 * superadmin with TOTP already enrolled (the secret is printed so it can be
 * added to an authenticator app).
 *
 * Writes go through the repository and the same helpers the routes use
 * (argon2id `hashSecret`, `newId`, grants, enrolments, audit log). Idempotent:
 * when the demo school already exists nothing is written and only the
 * accounts (and the superadmin's current TOTP secret) are printed again.
 * Refuses to run when NODE_ENV=production.
 */
import type { Config } from '../config.js';
import type { Deps } from '../deps.js';
import { hashSecret } from '../domain/passwords.js';
import { newTotpSecret, otpauthUrl } from '../domain/totp.js';
import { newId } from '../ids.js';
import type { GrantRec, Id, Repository, SchoolRec, UserRec } from '../repo/types.js';
import { AuditService } from './audit.js';

export const DEMO_SCHOOL_NAME = 'Bilig Demo School';
export const DEMO_PASSWORD = 'bilig-demo-2026';
export const DEMO_PIN = '1234';
export const DEMO_JOIN_CODE = 'DEMO77';
export const DEMO_CLASS_NAME = '7А';
export const DEMO_TOPIC = 'animal-cell';
export const DEMO_EMAILS = {
  schoolAdmin: 'admin@demo.bilig.kg',
  teacher: 'teacher@demo.bilig.kg',
  superadmin: 'super@demo.bilig.kg',
} as const;
export const DEMO_STUDENTS = ['Айбек Асанов', 'Айпери Токтогулова', 'Нурсултан Жумабеков', 'Мария Иванова', 'Дмитрий Ким'] as const;

const DAY_MS = 24 * 3600 * 1000;

export type DemoSeedDeps = Pick<Deps, 'clock'> &
  Partial<Pick<Deps, 'audit' | 'content'>> & {
    config: Pick<Config, 'env'>;
    /** Where the account summary goes (default: stdout). */
    log?: (line: string) => void;
  };

export interface DemoSeedReport {
  /** false when the demo school already existed (nothing written). */
  created: boolean;
  schoolId: Id;
  classId: Id | null;
  /** The superadmin's active TOTP secret (null when not enrolled). */
  totp: { secret: string; otpauthUrl: string } | null;
}

export function assertDemoAllowed(env: Config['env']): void {
  if (env === 'production') throw new Error('DEMO_SEED refused: the demo dataset (known passwords and PINs) must never be loaded in production');
}

async function findSchool(repo: Repository, name: string): Promise<SchoolRec | null> {
  let cursor: string | undefined;
  do {
    const page = await repo.listSchools({}, { cursor, limit: 100 });
    const hit = page.items.find((s) => s.name === name);
    if (hit) return hit;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

async function liveSubjects(repo: Repository): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.content('subject').list({}, { cursor, limit: 100 });
    for (const s of page.items) if (s.data.status === 'live') keys.push(s.key);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return keys.sort();
}

/** An active adult with a verified e-mail and the demo password (reuses an existing account). */
async function adult(repo: Repository, now: Date, email: string, displayName: string, grant: Omit<GrantRec, 'userId'>): Promise<UserRec> {
  let user = await repo.getUserByEmail(email);
  if (!user) {
    const created = await repo.createUser({ id: newId(), kind: 'adult', email, emailVerifiedAt: now, displayName, locale: 'ru', status: 'active' });
    if (created === 'conflict') throw new Error(`demo seed: user conflict for ${email}`);
    user = created;
  }
  await repo.setCredential(user.id, 'password', await hashSecret(DEMO_PASSWORD));
  const grants = await repo.listGrants(user.id);
  if (!grants.some((g) => g.role === grant.role && g.scope === grant.scope && g.scopeId === grant.scopeId)) await repo.addGrant({ userId: user.id, ...grant });
  return user;
}

async function currentTotp(repo: Repository, email: string): Promise<DemoSeedReport['totp']> {
  const user = await repo.getUserByEmail(email);
  const cred = user ? await repo.getCredential(user.id, 'totp') : null;
  if (!cred || cred.secretHash.startsWith('pending:')) return null;
  return { secret: cred.secretHash, otpauthUrl: otpauthUrl(cred.secretHash, email) };
}

export async function seedDemo(repo: Repository, deps: DemoSeedDeps): Promise<DemoSeedReport> {
  assertDemoAllowed(deps.config.env);
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const audit = deps.audit ?? new AuditService(repo, deps.clock);

  const existing = await findSchool(repo, DEMO_SCHOOL_NAME);
  if (existing) {
    const cls = await repo.getClassByJoinCode(DEMO_JOIN_CODE);
    const report: DemoSeedReport = { created: false, schoolId: existing.id, classId: cls?.id ?? null, totp: await currentTotp(repo, DEMO_EMAILS.superadmin) };
    printReport(log, report);
    return report;
  }

  const now = deps.clock.now();

  // School + licence: every live subject, grades 6–11, one year.
  const school: SchoolRec = { id: newId(), name: DEMO_SCHOOL_NAME, region: 'Bishkek', type: 'state', language: 'ky', status: 'active', createdAt: now, version: 1 };
  await repo.createSchool(school);
  await audit.log(null, 'school.created', { type: 'school', id: school.id }, { diff: { name: school.name, demo: true } });
  const subjects = await liveSubjects(repo);
  if (subjects.length) {
    const lic = await repo.createLicense({
      id: newId(),
      schoolId: school.id,
      subjects,
      grades: [6, 7, 8, 9, 10, 11],
      seats: 100,
      startsAt: now,
      endsAt: new Date(now.getTime() + 365 * DAY_MS),
    });
    if (lic === 'conflict') throw new Error('demo seed: licence conflict');
    deps.content?.invalidate();
    await audit.log(null, 'license.created', { type: 'license', id: lic.id }, { diff: { subjects, grades: lic.grades, demo: true } });
  } else {
    log('demo seed: no live subjects in the catalog yet — licence skipped (run the content seed first)');
  }

  // Staff.
  const schoolGrant = (role: 'school_admin' | 'teacher') => ({ role, scope: 'school' as const, scopeId: school.id, subrole: null });
  await adult(repo, now, DEMO_EMAILS.schoolAdmin, 'Гүлнара Садыкова', schoolGrant('school_admin'));
  const teacher = await adult(repo, now, DEMO_EMAILS.teacher, 'Айгүл Мамытова', schoolGrant('teacher'));
  const superadmin = await adult(repo, now, DEMO_EMAILS.superadmin, 'Demo Superadmin', { role: 'superadmin', scope: 'platform', scopeId: null, subrole: null });

  // TOTP is mandatory for a superadmin on the admin audience. Store an active
  // secret — the same state `POST /me/2fa` {setup, verify} leaves behind.
  let totp = await currentTotp(repo, DEMO_EMAILS.superadmin);
  if (!totp) {
    const secret = newTotpSecret();
    await repo.setCredential(superadmin.id, 'totp', secret);
    await audit.log(superadmin.id, 'auth.2fa_enabled', { type: 'user', id: superadmin.id }, { diff: { demo: true } });
    totp = { secret, otpauthUrl: otpauthUrl(secret, DEMO_EMAILS.superadmin) };
  }

  // Class 7А with the teacher enrolled.
  const cls = await repo.createClass({
    id: newId(),
    schoolId: school.id,
    name: DEMO_CLASS_NAME,
    grade: 7,
    joinCode: DEMO_JOIN_CODE,
    joinCodeEnabled: true,
    createdBy: teacher.id,
    createdAt: now,
    deletedAt: null,
  });
  if (cls === 'conflict') throw new Error(`demo seed: join code ${DEMO_JOIN_CODE} is already used by another class`);
  await repo.addEnrollment({ classId: cls.id, userId: teacher.id, role: 'teacher' });

  // Students (same writes as POST /classes/:id/students, with a fixed PIN).
  const pinHash = await hashSecret(DEMO_PIN);
  for (const displayName of DEMO_STUDENTS) {
    const u = await repo.createUser({ id: newId(), kind: 'student', email: null, emailVerifiedAt: null, displayName, locale: 'ky', status: 'active' });
    if (u === 'conflict') throw new Error('demo seed: student conflict');
    await repo.setCredential(u.id, 'pin', pinHash);
    await repo.addEnrollment({ classId: cls.id, userId: u.id, role: 'student' });
    await repo.addGrant({ userId: u.id, role: 'student', scope: 'class', scopeId: cls.id, subrole: null });
  }
  await audit.log(teacher.id, 'student.created', { type: 'class', id: cls.id }, { diff: { count: DEMO_STUDENTS.length, demo: true } });

  // Assignment: animal cell, tour + quiz, due in 7 days (needs the published topic).
  const topic = await repo.getTopicByKey(DEMO_TOPIC);
  if (topic?.publishedVersionId) {
    await repo.createAssignment({
      id: newId(),
      classId: cls.id,
      topicKey: DEMO_TOPIC,
      activities: ['tour', 'quiz'],
      dueAt: new Date(now.getTime() + 7 * DAY_MS),
      createdBy: teacher.id,
      createdAt: now,
    });
  } else {
    log(`demo seed: topic ${DEMO_TOPIC} is not published — assignment skipped (run the content seed first)`);
  }

  const report: DemoSeedReport = { created: true, schoolId: school.id, classId: cls.id, totp };
  printReport(log, report);
  return report;
}

function printReport(log: (line: string) => void, r: DemoSeedReport): void {
  log(r.created ? `demo dataset created: ${DEMO_SCHOOL_NAME}` : `demo dataset already present: ${DEMO_SCHOOL_NAME} (nothing changed)`);
  log(`  school admin  ${DEMO_EMAILS.schoolAdmin} / ${DEMO_PASSWORD}`);
  log(`  teacher       ${DEMO_EMAILS.teacher} / ${DEMO_PASSWORD}  (class ${DEMO_CLASS_NAME}, join code ${DEMO_JOIN_CODE})`);
  log(`  students      class code ${DEMO_JOIN_CODE} → pick a name → PIN ${DEMO_PIN}`);
  log(`  superadmin    ${DEMO_EMAILS.superadmin} / ${DEMO_PASSWORD}  + TOTP code on the admin audience`);
  if (r.totp) {
    log(`  TOTP secret   ${r.totp.secret}`);
    log(`  otpauth URL   ${r.totp.otpauthUrl}`);
    log('  (add it to an authenticator app: scan the URL as a QR code or enter the secret manually)');
  } else {
    log('  TOTP not enrolled: log in on the client audience, then POST /api/v1/me/2fa {"action":"setup"} and {"action":"verify","code":"…"}');
  }
}
