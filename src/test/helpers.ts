/**
 * Test harness: an app on the in-memory repository with a manual clock,
 * memory mailer/storage, the contract fixture content, and helpers to mint
 * users with real sessions and signed tokens. `npm test` needs no Docker.
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { ContentPackage } from '@bilig/content-model';
import { animalCellCatalog, animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import type { AuthorSubrole, Role, Scope } from '@bilig/permissions';
import { buildApp } from '../app.js';
import { createDeps } from '../bootstrap.js';
import { testConfig, type Config } from '../config.js';
import type { Deps } from '../deps.js';
import { newId } from '../ids.js';
import { hashToken, joinCode, randomPin, randomToken } from '../domain/crypto.js';
import { hashSecret } from '../domain/passwords.js';
import { MemoryRepository } from '../repo/memory.js';
import type { Audience, ClassRec, Repository, SchoolRec, UserRec } from '../repo/types.js';
import { ManualClock } from '../services/clock.js';
import { MemoryMailer } from '../services/mailer.js';
import { MemoryStorage } from '../services/storage.js';
import { importContent } from '../services/seed.js';
import type { TutorProvider } from '../services/tutor-provider.js';

export const API = '/api/v1';
export const PASSWORD = 'Correct-Horse-Battery-77';

/** The fixture topic as a second, open demo topic (`demo-cell`). */
export function demoPackage(): ContentPackage {
  const p = structuredClone(animalCellPackage);
  p.manifest.topicKey = 'demo-cell';
  p.manifest.hash = 'e5'.repeat(32);
  p.topic.key = 'demo-cell';
  p.topic.demo = true;
  return p;
}

export function fixtureContent() {
  const { topics: _t, ...base } = animalCellCatalog;
  return { base, packages: [structuredClone(animalCellPackage), demoPackage()] };
}

export interface TestCtx {
  app: FastifyInstance;
  deps: Deps;
  repo: Repository;
  clock: ManualClock;
  mailer: MemoryMailer;
  storage: MemoryStorage;
  inject(opts: InjectOptions & { token?: string }): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function makeTestApp(opts: { tutor?: TutorProvider | null; config?: Partial<Config>; seed?: boolean; repo?: Repository } = {}): Promise<TestCtx> {
  const config = testConfig(opts.config);
  const clock = new ManualClock();
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage(config.publicUrl);
  const repo = opts.repo ?? new MemoryRepository();
  const deps = await createDeps(config, { repo, clock, mailer, storage, tutor: opts.tutor === undefined ? null : opts.tutor });
  if (opts.seed !== false) await importContent(repo, clock, fixtureContent(), config);
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    repo,
    clock,
    mailer,
    storage,
    inject: ({ token, headers, ...rest }) =>
      app.inject({ ...rest, headers: { ...(headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
    close: () => app.close(),
  };
}

/** A session row + signed access token for a user (bypasses the login endpoint). */
export async function tokenFor(deps: Deps, user: UserRec, aud: Audience = 'client'): Promise<string> {
  const now = deps.clock.now();
  const id = newId();
  await deps.repo.createSession({
    id,
    userId: user.id,
    refreshHash: hashToken(randomToken()),
    family: id,
    audience: aud,
    device: 'test',
    ip: '127.0.0.1',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3600_000),
    revokedAt: null,
    replacedById: null,
  });
  return deps.jwt.sign({ sub: user.id, sid: id, aud, kind: user.kind }, now);
}

export interface MadeUser {
  user: UserRec;
  token: string;
  adminToken: string;
}

let seq = 0;
export async function makeUser(
  deps: Deps,
  grant?: { role: Role; scope?: Scope; scopeId?: string; subrole?: AuthorSubrole },
  opts: { email?: string; password?: string; displayName?: string } = {},
): Promise<MadeUser> {
  const email = opts.email ?? `user${++seq}-${Date.now()}@example.kg`;
  const u = await deps.repo.createUser({ id: newId(), kind: 'adult', email, emailVerifiedAt: deps.clock.now(), displayName: opts.displayName ?? `User ${seq}`, locale: 'ru', status: 'active' });
  if (u === 'conflict') throw new Error('user conflict');
  if (opts.password) await deps.repo.setCredential(u.id, 'password', await hashSecret(opts.password));
  if (grant) {
    const scope = grant.scope ?? ({ student: 'class', teacher: 'school', school_admin: 'school', author: 'subject', editor: 'subject', superadmin: 'platform', guest: 'platform' } as const)[grant.role];
    await deps.repo.addGrant({ userId: u.id, role: grant.role, scope, scopeId: grant.scopeId ?? null, subrole: grant.subrole ?? null });
  }
  return { user: u, token: await tokenFor(deps, u, 'client'), adminToken: await tokenFor(deps, u, 'admin') };
}

export async function makeSchool(deps: Deps, name = 'Школа №1'): Promise<SchoolRec> {
  const s: SchoolRec = { id: newId(), name, region: 'Бишкек', type: 'state', language: 'ky', status: 'active', createdAt: deps.clock.now() };
  await deps.repo.createSchool(s);
  return s;
}

export async function licenseSchool(deps: Deps, schoolId: string, subjects = ['bio'], grades = [7]) {
  const now = deps.clock.now();
  await deps.repo.createLicense({ id: newId(), schoolId, subjects, grades, seats: 500, startsAt: new Date(now.getTime() - 86400_000), endsAt: new Date(now.getTime() + 365 * 86400_000) });
}

export async function makeClass(deps: Deps, schoolId: string, teacherId?: string, name = '7А'): Promise<ClassRec> {
  const c = await deps.repo.createClass({ id: newId(), schoolId, name, grade: 7, joinCode: joinCode(), joinCodeEnabled: true, createdBy: teacherId ?? newId(), createdAt: deps.clock.now(), deletedAt: null });
  if (c === 'conflict') throw new Error('class conflict');
  if (teacherId) await deps.repo.addEnrollment({ classId: c.id, userId: teacherId, role: 'teacher' });
  return c;
}

export async function makeStudent(deps: Deps, classId: string, displayName = 'Айбек Асанов', pin = randomPin()) {
  const u = await deps.repo.createUser({ id: newId(), kind: 'student', email: null, emailVerifiedAt: null, displayName, locale: 'ky', status: 'active' });
  if (u === 'conflict') throw new Error('student conflict');
  await deps.repo.setCredential(u.id, 'pin', await hashSecret(pin));
  await deps.repo.addEnrollment({ classId, userId: u.id, role: 'student' });
  await deps.repo.addGrant({ userId: u.id, role: 'student', scope: 'class', scopeId: classId, subrole: null });
  return { user: u, pin, token: await tokenFor(deps, u, 'client') };
}

/** A licensed school with a teacher, a school admin, a class and two students. */
export async function makeSchoolWorld(deps: Deps) {
  const school = await makeSchool(deps);
  await licenseSchool(deps, school.id);
  const teacher = await makeUser(deps, { role: 'teacher', scopeId: school.id });
  const schoolAdmin = await makeUser(deps, { role: 'school_admin', scopeId: school.id });
  const cls = await makeClass(deps, school.id, teacher.user.id);
  const s1 = await makeStudent(deps, cls.id, 'Айбек Асанов', '123456');
  const s2 = await makeStudent(deps, cls.id, 'Нургүл Токтогулова', '654321');
  return { school, teacher, schoolAdmin, cls, students: [s1, s2] };
}

export const json = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
