/**
 * Classes (TZ §9 Classes, W-53): classes & join codes, students (list/CSV),
 * PIN reset, printable login cards (PDF), assignments and results.
 *
 * Scope: `class.manage` / `assignment.manage` are 'own' grants on the
 * school; additionally a teacher may only touch classes they teach, while a
 * school admin manages every class of their school and a superadmin all.
 */
import type { FastifyInstance } from 'fastify';
import type { Assignment, AssignmentResults, SchoolClass, Student } from '@bilig/content-model/api';
import { normalizeClassName } from '@bilig/content-model/api';
import type { Permission } from '@bilig/permissions';
import { newId } from '../ids.js';
import type { Deps } from '../deps.js';
import { route, type Ctx } from '../http/route.js';
import { fail } from '../http/errors.js';
import { joinCode, randomPin } from '../domain/crypto.js';
import { parseStudentNames } from '../domain/csv.js';
import { hashSecret } from '../domain/passwords.js';
import { pageOf, sortedPage } from '../repo/paging.js';
import { t } from '@bilig/content-model';
import type { AssignmentRec, AttemptRec, ClassRec, Repository, UserRec } from '../repo/types.js';
import type { AuthCtx } from '../http/auth-context.js';
import { renderLoginCards } from '../export/login-cards.js';
import type { TeachingPlanRec } from '../repo/types.js';
import type { PlanDoc } from '../ktp/teaching-plan.js';
import { extendTrialForClass, liveSubjectKeys } from '../services/teacher-signup.js';
import { classSubjects } from '../repo/class-subjects.js';

/** The calendar date (YYYY-MM-DD) in Kyrgyzstan (UTC+6, no DST). */
export const localDate = (d: Date) => new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10);

const iso = (d: Date) => d.toISOString();

export type Guard = Pick<Ctx<'classGet'>, 'auth' | 'authorize'>;

/** Status and score of a student's attempts for one assignment (latest finished wins). */
export function assignmentStatus(attempts: readonly AttemptRec[]): { status: 'not_started' | 'in_progress' | 'done'; score?: number; finishedAt?: Date } {
  if (!attempts.length) return { status: 'not_started' };
  const done = attempts.filter((a) => a.finishedAt).sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime());
  if (!done.length) return { status: 'in_progress' };
  const last = done[done.length - 1];
  return { status: 'done', score: last.score ?? 0, finishedAt: last.finishedAt! };
}

/** Aggregate results: who submitted, average score, hardest items (lowest correct rate first). */
export function aggregateResults(
  assignmentId: string,
  students: readonly UserRec[],
  attempts: readonly AttemptRec[],
  answers: readonly { attemptId: string; itemKey: string; correct: boolean; response: { type: string; value: unknown } }[],
): AssignmentResults {
  const rows = students.map((s) => {
    const st = assignmentStatus(attempts.filter((a) => a.userId === s.id));
    return {
      studentId: s.id,
      displayName: s.displayName,
      status: st.status,
      ...(st.score !== undefined ? { score: st.score } : {}),
      ...(st.finishedAt ? { finishedAt: iso(st.finishedAt) } : {}),
      _attempt: st.status === 'done' ? attempts.filter((a) => a.userId === s.id && a.finishedAt).sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime()).pop()?.id : undefined,
    };
  });
  const scored = rows.filter((r) => r.score !== undefined);
  const counted = new Set(rows.map((r) => r._attempt).filter(Boolean));
  const per = new Map<string, { n: number; ok: number; wrong: Map<string, number> }>();
  for (const a of answers) {
    if (!counted.has(a.attemptId)) continue;
    const e = per.get(a.itemKey) ?? { n: 0, ok: 0, wrong: new Map() };
    e.n++;
    if (a.correct) e.ok++;
    else {
      const v = a.response.value;
      const keys = Array.isArray(v) ? v.map(String) : typeof v === 'object' && v ? [] : [String(v)];
      for (const k of keys) e.wrong.set(k, (e.wrong.get(k) ?? 0) + 1);
    }
    per.set(a.itemKey, e);
  }
  const hardestItems = [...per.entries()]
    .map(([itemKey, e]) => {
      const common = [...e.wrong.entries()].sort((x, y) => y[1] - x[1])[0];
      return { itemKey, correctRate: e.ok / e.n, ...(common ? { commonWrong: common[0] } : {}) };
    })
    .sort((a, b) => a.correctRate - b.correctRate || a.itemKey.localeCompare(b.itemKey));
  return {
    assignmentId,
    students: rows.map(({ _attempt: _a, ...r }) => r),
    averageScore: scored.length ? scored.reduce((n, r) => n + (r.score ?? 0), 0) / scored.length : null,
    hardestItems,
  };
}

export async function toClassDto(repo: Repository, c: ClassRec): Promise<SchoolClass> {
  const n = (await repo.listEnrollments({ classId: c.id, role: 'student' })).length;
  const subjectKeys = c.subjectKeys ?? (c.subjectKey ? [c.subjectKey] : []);
  return { id: c.id, schoolId: c.schoolId, name: normalizeClassName(c.name), grade: c.grade, joinCode: c.joinCode, joinCodeEnabled: c.joinCodeEnabled, studentCount: n, subjectKey: subjectKeys[0] ?? null, subjectKeys, books: c.books ?? {} };
}

export const toAssignmentDto = (a: AssignmentRec): Assignment => ({
  id: a.id,
  classId: a.classId,
  topicKey: a.topicKey,
  activities: a.activities as Assignment['activities'],
  ...(a.dueAt ? { dueAt: iso(a.dueAt) } : {}),
  createdBy: a.createdBy,
  createdAt: iso(a.createdAt),
});

/** May the caller manage this class? Teachers only their own classes (see module doc). */
export async function classAccess(repo: Repository, auth: AuthCtx, cls: ClassRec, permission: Permission, authorize: Guard['authorize']): Promise<void> {
  authorize(permission, { schoolId: cls.schoolId });
  const g = auth.grants;
  if (g.some((x) => x.role === 'superadmin')) return;
  if (g.some((x) => x.role === 'school_admin' && x.scopeId === cls.schoolId)) return;
  const teaches = await repo.listEnrollments({ classId: cls.id, userId: auth.user!.id, role: 'teacher' });
  if (!teaches.length) fail('forbidden', { detail: 'not_your_class' });
}

export function registerClasses(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit } = deps;

  async function loadClass(ctx: Guard, id: string, permission: Permission = 'class.manage') {
    const cls = await repo.getClass(id);
    if (!cls) fail('not_found', { detail: 'class' });
    await classAccess(repo, ctx.auth, cls, permission, ctx.authorize);
    return cls;
  }

  async function loadStudent(ctx: Guard, studentId: string) {
    const enr = await repo.listEnrollments({ userId: studentId, role: 'student' });
    const user = await repo.getUser(studentId);
    if (!user || user.kind !== 'student' || user.deletedAt || !enr.length) fail('not_found', { detail: 'student' });
    let last: unknown;
    for (const e of enr) {
      try {
        const cls = await loadClass(ctx, e.classId);
        return { user, cls };
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /**
   * v0.6.0: a class subject must be one of the school's actively licensed subjects.
   * v0.8.0: in a self-registered teacher's own school any live subject is accepted
   * (the trial then follows the class: see extendTrialForClass).
   */
  async function checkSubjects(schoolId: string, subjectKeys: readonly string[]) {
    if (!subjectKeys.length) return;
    const school = await repo.getSchool(schoolId);
    if (school?.origin === 'self') {
      const live = await liveSubjectKeys(repo);
      const bad = subjectKeys.filter((k) => !live.has(k));
      if (bad.length) fail('validation_failed', { detail: 'subject_unknown', issues: [{ path: ['subjectKeys'], message: `Unknown or not live subject(s): ${bad.join(', ')}` }] });
      return;
    }
    const now = clock.now();
    const licensed = new Set(
      (await repo.listLicenses({ schoolIds: [schoolId] }, { limit: 1000 })).items.filter((l) => l.startsAt <= now && now < l.endsAt).flatMap((l) => l.subjects),
    );
    for (const subjectKey of subjectKeys) {
      if (!licensed.has(subjectKey)) {
        const allowed = [...licensed].sort();
        fail('validation_failed', {
          detail: 'subject_not_licensed',
          issues: [{ path: ['subjectKey'], message: `Subject "${subjectKey}" is not licensed for this school${allowed.length ? ` (licensed: ${allowed.join(', ')})` : ' (no active licence)'}` }],
        });
      }
    }
  }

  /** v0.9.3: books per subject must be published books of that subject, and the subject one of the class's. */
  async function checkBooks(books: Record<string, string>, subjects: readonly string[]): Promise<Record<string, string>> {
    for (const [subject, id] of Object.entries(books)) {
      const book = await repo.getBook(id);
      if (!subjects.includes(subject) || !book || book.status !== 'published' || book.subjectKey !== subject)
        fail('validation_failed', { detail: 'book', issues: [{ path: ['books', subject], message: 'Not a published book of a subject of this class' }] });
    }
    return { ...books };
  }

  /** v0.8.0: the subjects a create / patch body asks for (`subjectKeys` wins); undefined = unchanged. */
  const bodySubjects = (b: { subjectKey?: string | null; subjectKeys?: string[] }): string[] | undefined =>
    b.subjectKeys !== undefined ? [...new Set(b.subjectKeys)] : b.subjectKey !== undefined ? (b.subjectKey ? [b.subjectKey] : []) : undefined;

  async function uniqueJoinCode(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const c = joinCode();
      if (!(await repo.getClassByJoinCode(c))) return c;
    }
    fail('internal', { detail: 'join_code_space' });
  }

  async function toStudents(classId: string, users: UserRec[]): Promise<Student[]> {
    const consents = new Set((await repo.listConsents(users.map((u) => u.id))).map((c) => c.studentId));
    return users.map((u) => ({ id: u.id, classId, displayName: u.displayName, hasConsent: consents.has(u.id) }));
  }

  // GET /classes
  route(app, deps, 'classList', async ({ auth, query }) => {
    const g = auth.grants;
    const page = pageOf(query);
    if (g.some((x) => x.role === 'superadmin')) {
      const res = await repo.listClasses({}, page);
      return { items: await Promise.all(res.items.map((c) => toClassDto(repo, c))), nextCursor: res.nextCursor };
    }
    const adminSchools = g.filter((x) => x.role === 'school_admin' && x.scopeId).map((x) => x.scopeId!);
    const taught = (await repo.listEnrollments({ userId: auth.user!.id, role: 'teacher' })).map((e) => e.classId);
    const ids = new Set<string>(taught);
    if (adminSchools.length) (await repo.listClasses({ schoolIds: adminSchools }, { limit: 10_000 })).items.forEach((c) => ids.add(c.id));
    const res = await repo.listClasses({ ids: [...ids] }, page);
    return { items: await Promise.all(res.items.map((c) => toClassDto(repo, c))), nextCursor: res.nextCursor };
  });

  // POST /classes
  route(app, deps, 'classCreate', async ({ auth, body, authorize, ip }) => {
    const uid = auth.user!.id;
    let schoolId = body.schoolId;
    if (!schoolId) {
      const schools = [...new Set(auth.grants.filter((g) => (g.role === 'teacher' || g.role === 'school_admin') && g.scopeId).map((g) => g.scopeId!))];
      if (schools.length !== 1) fail('validation_failed', { detail: 'schoolId required' });
      schoolId = schools[0];
    }
    authorize('class.manage', { schoolId });
    if (!(await repo.getSchool(schoolId))) fail('not_found', { detail: 'school' });
    const subjects = bodySubjects(body) ?? [];
    await checkSubjects(schoolId, subjects);
    // v0.9.3: the books chosen in the new class form — only for the class's subjects.
    const books = body.books ? await checkBooks(body.books, subjects) : {};
    let created: ClassRec | 'conflict' = 'conflict';
    for (let i = 0; i < 5 && created === 'conflict'; i++) {
      created = await repo.createClass({ id: newId(), schoolId, name: normalizeClassName(body.name), grade: body.grade, joinCode: await uniqueJoinCode(), joinCodeEnabled: true, subjectKey: subjects[0] ?? null, subjectKeys: subjects, ...(Object.keys(books).length ? { books } : {}), createdBy: uid, createdAt: clock.now(), deletedAt: null });
    }
    if (created === 'conflict') fail('conflict');
    if (auth.grants.some((g) => g.role === 'teacher' && g.scopeId === schoolId)) await repo.addEnrollment({ classId: created.id, userId: uid, role: 'teacher' });
    await audit.log(uid, 'class.created', { type: 'class', id: created.id, label: created.name }, { ip, after: { name: created.name, grade: created.grade, subjectKeys: subjects } });
    await extendTrialForClass(deps, schoolId, created.grade, subjects, uid, ip);
    return toClassDto(repo, created);
  });

  route(app, deps, 'classGet', async (ctx) => toClassDto(repo, await loadClass(ctx, ctx.params.id)));

  // PATCH /classes/:id (rename, grade, disable/enable the join code)
  route(app, deps, 'classPatch', async (ctx) => {
    const cls = await loadClass(ctx, ctx.params.id);
    // `subjectKeys` replaces the list; a lone `subjectKey` (≤ 0.7 clients) becomes the first one, the rest stay.
    const subjects = ctx.body.subjectKeys !== undefined || ctx.body.subjectKey !== undefined ? classSubjects(ctx.body, cls).subjectKeys : undefined;
    if (subjects) await checkSubjects(cls.schoolId, subjects.filter((k) => !(cls.subjectKeys ?? []).includes(k)));
    const { subjectKey: _k, subjectKeys: _ks, books: bookPatch, ...rest } = ctx.body;
    // v0.9.3: the book per subject — only published books; null clears one subject, the others stay.
    let books: Record<string, string> | undefined;
    if (bookPatch) {
      books = { ...(cls.books ?? {}) };
      for (const [subject, id] of Object.entries(bookPatch)) if (id === null) delete books[subject];
      const set = Object.fromEntries(Object.entries(bookPatch).filter((e): e is [string, string] => e[1] !== null));
      Object.assign(books, await checkBooks(set, subjects ?? cls.subjectKeys ?? []));
    }
    const next = await repo.updateClass(cls.id, { ...rest, ...(rest.name !== undefined ? { name: normalizeClassName(rest.name) } : {}), ...(subjects ? { subjectKeys: subjects } : {}), ...(books ? { books } : {}) });
    if (!next || next === 'conflict') fail('conflict');
    const uid = ctx.auth.user!.id;
    await audit.log(uid, 'class.updated', { type: 'class', id: cls.id, label: next.name }, {
      ip: ctx.ip,
      before: { name: cls.name, grade: cls.grade, joinCodeEnabled: cls.joinCodeEnabled, subjectKeys: cls.subjectKeys ?? [] },
      after: { name: next.name, grade: next.grade, joinCodeEnabled: next.joinCodeEnabled, subjectKeys: next.subjectKeys ?? [] },
    });
    if (subjects || ctx.body.grade !== undefined) await extendTrialForClass(deps, cls.schoolId, next.grade, next.subjectKeys ?? [], uid, ctx.ip);
    return toClassDto(repo, next);
  });

  // v0.8.0 GET /classes/:id/subjects — the class's subjects with the КТП status, the next lesson and progress.
  route(app, deps, 'classSubjects', async (ctx) => {
    const cls = await loadClass(ctx, ctx.params.id);
    const keys = cls.subjectKeys ?? (cls.subjectKey ? [cls.subjectKey] : []);
    const owners = new Set([ctx.auth.user!.id, ...(await repo.listEnrollments({ classId: cls.id, role: 'teacher' })).map((e) => e.userId)]);
    const plans: TeachingPlanRec[] = [];
    for (const owner of owners) plans.push(...(await repo.listTeachingPlans(owner, { limit: 1000 })).items);
    plans.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const today = localDate(clock.now());
    return {
      items: keys.map((subjectKey) => {
        const plan = plans.find((p) => {
          const d = p.doc as PlanDoc;
          return d.subjectKey === subjectKey && Object.values(d.classLinks ?? {}).includes(cls.id);
        });
        if (!plan) return { subjectKey, ktp: { status: 'none' as const, planId: null, errors: 0, warnings: 0 }, nextLesson: null, progress: { done: 0, total: 0 } };
        const d = plan.doc as PlanDoc;
        const col = Object.entries(d.classLinks ?? {}).find(([, v]) => v === cls.id)![0];
        const dated = d.rows.map((r) => ({ r, date: r.dates[col] ?? null }));
        const upcoming = dated.filter((x) => x.date && x.date >= today).sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.r.index - b.r.index))[0];
        return {
          subjectKey,
          ktp: { status: 'parsed' as const, planId: plan.id, errors: d.issues.filter((i) => i.severity === 'error').length, warnings: d.issues.filter((i) => i.severity === 'warning').length },
          nextLesson: upcoming ? { index: upcoming.r.index, title: upcoming.r.title, date: upcoming.date!, topicKey: upcoming.r.topicKey ?? null } : null,
          progress: { done: dated.filter((x) => x.date && x.date < today).length, total: d.rows.length },
        };
      }),
    };
  });

  // POST /classes/:id/join-code → re-issue (the old code stops working immediately)
  route(app, deps, 'classJoinCode', async (ctx) => {
    const cls = await loadClass(ctx, ctx.params.id);
    const code = await uniqueJoinCode();
    const next = await repo.updateClass(cls.id, { joinCode: code, joinCodeEnabled: true });
    if (!next || next === 'conflict') fail('conflict');
    await audit.log(ctx.auth.user!.id, 'class.join_code_reissued', { type: 'class', id: cls.id }, { ip: ctx.ip });
    return { joinCode: code };
  });

  // GET /classes/:id/students — student-data access is audited
  route(app, deps, 'classStudents', async (ctx) => {
    const cls = await loadClass(ctx, ctx.params.id);
    const enr = await repo.listEnrollments({ classId: cls.id, role: 'student' });
    const users = (await repo.getUsers(enr.map((e) => e.userId))).filter((u) => !u.deletedAt).sort((a, b) => (a.id < b.id ? -1 : 1));
    const page = pageOf(ctx.query, 100, 100);
    const start = page.cursor ? users.findIndex((u) => Buffer.from(page.cursor!, 'base64url').toString() < u.id) : 0;
    const from = start < 0 ? users.length : start;
    const slice = users.slice(from, from + page.limit);
    await audit.log(ctx.auth.user!.id, 'student.data_access', { type: 'class', id: cls.id }, { ip: ctx.ip, diff: { count: slice.length } });
    return {
      items: await toStudents(cls.id, slice),
      nextCursor: from + page.limit < users.length && slice.length ? Buffer.from(slice[slice.length - 1].id).toString('base64url') : null,
    };
  });

  // POST /classes/:id/students — a list or CSV; PINs are returned once
  route(
    app,
    deps,
    'classStudentsAdd',
    async (ctx) => {
      const cls = await loadClass(ctx, ctx.params.id);
      const names = 'csv' in ctx.body ? parseStudentNames(ctx.body.csv) : ctx.body.students.map((s) => s.displayName.trim()).filter(Boolean);
      if (!names.length) fail('validation_failed', { detail: 'no students' });
      if (names.length > 200) fail('validation_failed', { detail: 'max 200 students per request' });
      // Licence seats (when the school has licences): active students of the school must fit.
      const lic = (await repo.listLicenses({ schoolIds: [cls.schoolId] }, { limit: 100 })).items.filter((l) => l.endsAt > clock.now());
      if (lic.length) {
        const seats = Math.max(...lic.map((l) => l.seats));
        const schoolClasses = (await repo.listClasses({ schoolIds: [cls.schoolId] }, { limit: 10_000 })).items.map((c) => c.id);
        const current = new Set((await repo.listEnrollments({ classIds: schoolClasses, role: 'student' })).map((e) => e.userId)).size;
        if (current + names.length > seats) fail('conflict', { detail: 'license_seats_exceeded' });
      }
      const items = [];
      for (const displayName of names) {
        const pin = randomPin();
        const u = await repo.createUser({ id: newId(), kind: 'student', email: null, emailVerifiedAt: null, displayName: displayName.slice(0, 80), locale: 'ky', status: 'active' });
        if (u === 'conflict') fail('conflict');
        await repo.setCredential(u.id, 'pin', await hashSecret(pin));
        await repo.addEnrollment({ classId: cls.id, userId: u.id, role: 'student' });
        await repo.addGrant({ userId: u.id, role: 'student', scope: 'class', scopeId: cls.id, subrole: null });
        items.push({ student: { id: u.id, classId: cls.id, displayName: u.displayName, hasConsent: false }, pin });
      }
      await audit.log(ctx.auth.user!.id, 'student.created', { type: 'class', id: cls.id }, { ip: ctx.ip, diff: { count: items.length } });
      return { items };
    },
    { bodyLimit: 512 * 1024 },
  );

  // POST /students/:id/reset-pin
  route(app, deps, 'studentResetPin', async (ctx) => {
    const { user } = await loadStudent(ctx, ctx.params.id);
    const pin = randomPin();
    await repo.setCredential(user.id, 'pin', await hashSecret(pin));
    await audit.log(ctx.auth.user!.id, 'student.pin_reset', { type: 'user', id: user.id }, { ip: ctx.ip });
    return { pin };
  });

  // PATCH /students/:id — rename (pseudonym) / consent mark
  route(app, deps, 'studentPatch', async (ctx) => {
    const { user, cls } = await loadStudent(ctx, ctx.params.id);
    const uid = ctx.auth.user!.id;
    let u = user;
    if (ctx.body.displayName) u = (await repo.updateUser(user.id, { displayName: ctx.body.displayName }))!;
    if (ctx.body.hasConsent === true) await repo.setConsent({ studentId: user.id, schoolId: cls.schoolId, confirmedBy: uid, confirmedAt: clock.now() });
    if (ctx.body.hasConsent === false) await repo.setConsent({ studentId: user.id, remove: true });
    await audit.log(uid, 'student.updated', { type: 'user', id: user.id }, { ip: ctx.ip, diff: { fields: Object.keys(ctx.body) } });
    return (await toStudents(cls.id, [u]))[0];
  });

  // DELETE /students/:id — soft delete; physically erased after 30 days (TZ §6)
  route(app, deps, 'studentDelete', async (ctx) => {
    const { user, cls } = await loadStudent(ctx, ctx.params.id);
    const now = clock.now();
    await repo.updateUser(user.id, { deletedAt: now, status: 'blocked' });
    await repo.revokeUserSessions(user.id, now);
    await audit.log(ctx.auth.user!.id, 'student.deleted', { type: 'user', id: user.id }, { ip: ctx.ip, diff: { classId: cls.id } });
    return { ok: true as const };
  });

  // POST /classes/:id/login-cards → PDF (class code + name + PIN when re-issued)
  route(app, deps, 'classLoginCards', async (ctx) => {
    const cls = await loadClass(ctx, ctx.params.id);
    const enr = await repo.listEnrollments({ classId: cls.id, role: 'student' });
    let users = (await repo.getUsers(enr.map((e) => e.userId))).filter((u) => !u.deletedAt);
    if (ctx.body.studentIds) {
      const want = new Set(ctx.body.studentIds);
      users = users.filter((u) => want.has(u.id));
    }
    users.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
    const cards = [];
    for (const u of users) {
      let pin: string | undefined;
      if (ctx.body.resetPins) {
        pin = randomPin();
        await repo.setCredential(u.id, 'pin', await hashSecret(pin));
      }
      cards.push({ name: u.displayName, pin });
    }
    await audit.log(ctx.auth.user!.id, 'student.data_access', { type: 'class', id: cls.id }, { ip: ctx.ip, diff: { loginCards: cards.length, resetPins: !!ctx.body.resetPins } });
    const pdf = await renderLoginCards({ className: cls.name, joinCode: cls.joinCode, loginUrl: deps.config.appUrl, lang: ctx.lang, cards });
    ctx.reply.header('Cache-Control', 'no-store');
    return { body: pdf, contentType: 'application/pdf', filename: `login-cards-${cls.name}.pdf` };
  });

  // --- assignments ------------------------------------------------------------------
  route(app, deps, 'assignmentList', async (ctx) => {
    const cls = await loadClass(ctx, ctx.params.id, 'assignment.manage');
    const res = await repo.listAssignments({ classIds: [cls.id] }, pageOf(ctx.query));
    return { items: res.items.map(toAssignmentDto), nextCursor: res.nextCursor };
  });

  route(app, deps, 'assignmentCreate', async (ctx) => {
    const cls = await loadClass(ctx, ctx.params.id, 'assignment.manage');
    const pub = await deps.content.getPublished(ctx.body.topicKey);
    if (!pub) fail('not_found', { detail: 'topic' });
    const rec: AssignmentRec = {
      id: newId(),
      classId: cls.id,
      topicKey: ctx.body.topicKey,
      activities: [...new Set(ctx.body.activities)],
      dueAt: ctx.body.dueAt ? new Date(ctx.body.dueAt) : null,
      createdBy: ctx.auth.user!.id,
      createdAt: clock.now(),
    };
    await repo.createAssignment(rec);
    return toAssignmentDto(rec);
  });

  route(app, deps, 'assignmentResults', async (ctx) => {
    const a = await repo.getAssignment(ctx.params.id);
    if (!a) fail('not_found', { detail: 'assignment' });
    const cls = await loadClass(ctx, a.classId, 'assignment.manage');
    const enr = await repo.listEnrollments({ classId: cls.id, role: 'student' });
    const students = (await repo.getUsers(enr.map((e) => e.userId))).filter((u) => !u.deletedAt).sort((x, y) => x.displayName.localeCompare(y.displayName, 'ru'));
    const attempts = await repo.listAttempts({ assignmentId: a.id, userIds: students.map((s) => s.id) });
    const answers = await repo.listAnswers({ attemptIds: attempts.map((t) => t.id) });
    await audit.log(ctx.auth.user!.id, 'student.data_access', { type: 'assignment', id: a.id }, { ip: ctx.ip });
    const res = aggregateResults(a.id, students, attempts, answers);
    // v0.3.0: question texts in the request language from the published package.
    const pub = await deps.content.getPublished(a.topicKey);
    const prompts = new Map((pub?.build.pkg.items ?? []).map((i) => [i.key, t(i.prompt, ctx.lang)]));
    const hardestItems = res.hardestItems.map((h) => (prompts.has(h.itemKey) ? { ...h, prompt: prompts.get(h.itemKey)! } : h));
    // v0.3.0: optional paging of `students` (name order); aggregates always cover the class.
    const q = ctx.query;
    if (q.cursor === undefined && q.limit === undefined) return { ...res, hardestItems, totalStudents: res.students.length };
    const page = sortedPage(res.students, { value: (s) => s.displayName, tie: (s) => s.studentId }, pageOf(q, 20, 100));
    return { ...res, hardestItems, students: page.items, nextCursor: page.nextCursor, totalStudents: res.students.length };
  });
}
