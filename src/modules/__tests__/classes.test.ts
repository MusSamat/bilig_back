import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleItems } from '@bilig/content-model';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import { newId } from '../../ids.js';
import { API, json, makeSchool, makeSchoolWorld, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';

let t: TestCtx;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(() => t.close());

describe('classes', () => {
  it('teacher creates a class in their school; other schools are forbidden', async () => {
    const w = await makeSchoolWorld(t.deps);
    const r = await t.inject({ method: 'POST', url: `${API}/classes`, token: w.teacher.token, payload: { name: '7Б', grade: 7 } });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ name: '7Б', schoolId: w.school.id, joinCodeEnabled: true, studentCount: 0 });
    const other = await makeSchool(t.deps, 'Другая');
    expect((await t.inject({ method: 'POST', url: `${API}/classes`, token: w.teacher.token, payload: { name: 'X', grade: 7, schoolId: other.id } })).statusCode).toBe(403);
    const student = await t.inject({ method: 'POST', url: `${API}/classes`, token: w.students[0].token, payload: { name: 'X', grade: 7 } });
    expect(student.statusCode).toBe(403);
    expect((await t.inject({ method: 'GET', url: `${API}/classes` })).statusCode).toBe(401);
    const list = json(await t.inject({ method: 'GET', url: `${API}/classes`, token: w.teacher.token }));
    expect(list.items).toHaveLength(2);
  });

  it('a teacher manages only classes they teach; the school admin manages all', async () => {
    const w = await makeSchoolWorld(t.deps);
    const colleague = await makeUser(t.deps, { role: 'teacher', scopeId: w.school.id });
    expect((await t.inject({ method: 'GET', url: `${API}/classes/${w.cls.id}`, token: colleague.token })).statusCode).toBe(403);
    expect((await t.inject({ method: 'GET', url: `${API}/classes/${w.cls.id}`, token: w.schoolAdmin.token })).statusCode).toBe(200);
    const foreignAdmin = await makeUser(t.deps, { role: 'school_admin', scopeId: (await makeSchool(t.deps)).id });
    expect((await t.inject({ method: 'GET', url: `${API}/classes/${w.cls.id}`, token: foreignAdmin.token })).statusCode).toBe(403);
    expect(json(await t.inject({ method: 'GET', url: `${API}/classes`, token: w.schoolAdmin.token })).items).toHaveLength(1);
  });

  it('adds students from a list and CSV; returned PINs work; reset-pin; students listing is audited', async () => {
    const w = await makeSchoolWorld(t.deps);
    const r = await t.inject({ method: 'POST', url: `${API}/classes/${w.cls.id}/students`, token: w.teacher.token, payload: { csv: 'ФИО\nАсанова;Бермет\nУсенов Тимур\n' } });
    expect(r.statusCode, r.body).toBe(200);
    const added = json(r).items;
    expect(added.map((x: { student: { displayName: string } }) => x.student.displayName)).toEqual(['Асанова Бермет', 'Усенов Тимур']);
    const login = await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId: w.cls.id, studentId: added[0].student.id, pin: added[0].pin } });
    expect(login.statusCode).toBe(200);
    const list = await t.inject({ method: 'POST', url: `${API}/classes/${w.cls.id}/students`, token: w.teacher.token, payload: { students: [{ displayName: 'Жаңы Окуучу' }] } });
    expect(json(list).items).toHaveLength(1);
    const students = json(await t.inject({ method: 'GET', url: `${API}/classes/${w.cls.id}/students?limit=3`, token: w.teacher.token }));
    expect(students.items).toHaveLength(3);
    expect(students.nextCursor).toBeTruthy();
    const page2 = json(await t.inject({ method: 'GET', url: `${API}/classes/${w.cls.id}/students?limit=3&cursor=${students.nextCursor}`, token: w.teacher.token }));
    expect(page2.items).toHaveLength(2);
    expect((await t.repo.listAudit({ action: 'student.data_access' }, { limit: 50 })).items.length).toBeGreaterThan(0);

    const reset = await t.inject({ method: 'POST', url: `${API}/students/${added[0].student.id}/reset-pin`, token: w.teacher.token, payload: {} });
    const pin = json(reset).pin;
    expect(pin).toMatch(/^\d{6}$/);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId: w.cls.id, studentId: added[0].student.id, pin: added[0].pin } })).statusCode).toBe(401);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId: w.cls.id, studentId: added[0].student.id, pin } })).statusCode).toBe(200);
    const colleague = await makeUser(t.deps, { role: 'teacher', scopeId: w.school.id });
    expect((await t.inject({ method: 'POST', url: `${API}/students/${added[0].student.id}/reset-pin`, token: colleague.token, payload: {} })).statusCode).toBe(403);
  });

  it('patches consent, deletes a student (soft), re-issues and disables the join code', async () => {
    const w = await makeSchoolWorld(t.deps);
    const sid = w.students[0].user.id;
    expect(json(await t.inject({ method: 'PATCH', url: `${API}/students/${sid}`, token: w.teacher.token, payload: { hasConsent: true } })).hasConsent).toBe(true);
    expect((await t.inject({ method: 'DELETE', url: `${API}/students/${sid}`, token: w.teacher.token })).statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/me`, token: w.students[0].token })).statusCode).toBe(401);

    const old = w.cls.joinCode;
    const re = json(await t.inject({ method: 'POST', url: `${API}/classes/${w.cls.id}/join-code`, token: w.teacher.token, payload: {} }));
    expect(re.joinCode).not.toBe(old);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: old } })).statusCode).toBe(404);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: re.joinCode } })).statusCode).toBe(200);
    expect(json(await t.inject({ method: 'PATCH', url: `${API}/classes/${w.cls.id}`, token: w.teacher.token, payload: { joinCodeEnabled: false } })).joinCodeEnabled).toBe(false);
    expect((await t.inject({ method: 'POST', url: `${API}/auth/class-code`, payload: { code: re.joinCode } })).statusCode).toBe(404);
  });

  it('prints login cards as a PDF', async () => {
    const w = await makeSchoolWorld(t.deps);
    const r = await t.inject({ method: 'POST', url: `${API}/classes/${w.cls.id}/login-cards`, token: w.teacher.token, payload: { resetPins: true } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // PINs were re-issued
    expect((await t.inject({ method: 'POST', url: `${API}/auth/student-login`, payload: { classId: w.cls.id, studentId: w.students[0].user.id, pin: '123456' } })).statusCode).toBe(401);
  });
});

describe('assignments & results', () => {
  it('who submitted, average score, hardest questions; student cabinet', async () => {
    const w = await makeSchoolWorld(t.deps);
    const a = await t.inject({ method: 'POST', url: `${API}/classes/${w.cls.id}/assignments`, token: w.teacher.token, payload: { topicKey: 'animal-cell', activities: ['quiz', 'tour'], dueAt: '2026-10-20T00:00:00Z' } });
    expect(a.statusCode, a.body).toBe(200);
    const asg = json(a);
    expect(json(await t.inject({ method: 'GET', url: `${API}/classes/${w.cls.id}/assignments`, token: w.teacher.token })).items).toHaveLength(1);
    expect((await t.inject({ method: 'POST', url: `${API}/classes/${w.cls.id}/assignments`, token: w.teacher.token, payload: { topicKey: 'nope', activities: ['quiz'] } })).statusCode).toBe(404);

    const quiz = animalCellPackage.topic.activities.quiz!;
    const tok = w.students[0].token;
    const att = json(await t.inject({ method: 'POST', url: `${API}/attempts`, token: tok, payload: { clientId: newId(), topicKey: 'animal-cell', topicVersion: '1.0.0', seed: 'q', assignmentId: asg.id } }));
    expect(att.itemKeys).toEqual(sampleItems(quiz.itemKeys, quiz.sampleSize, 'q'));
    for (const k of att.itemKeys) await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/answers`, token: tok, payload: { itemKey: k, response: { type: 'single', value: 'zz' }, timeMs: 10 } });
    await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/finish`, token: tok, payload: {} });

    const res = json(await t.inject({ method: 'GET', url: `${API}/assignments/${asg.id}/results`, token: w.teacher.token }));
    expect(res.students.find((s: { studentId: string }) => s.studentId === w.students[0].user.id).status).toBe('done');
    expect(res.students.find((s: { studentId: string }) => s.studentId === w.students[1].user.id).status).toBe('not_started');
    expect(res.averageScore).toBe(0);
    expect(res.hardestItems.length).toBe(quiz.sampleSize);
    expect(res.hardestItems[0].correctRate).toBe(0);
    const colleague = await makeUser(t.deps, { role: 'teacher', scopeId: w.school.id });
    expect((await t.inject({ method: 'GET', url: `${API}/assignments/${asg.id}/results`, token: colleague.token })).statusCode).toBe(403);

    const mine = json(await t.inject({ method: 'GET', url: `${API}/me/assignments`, token: tok }));
    expect(mine.items[0]).toMatchObject({ id: asg.id, className: '7А', status: 'done', score: 0 });
    expect(json(await t.inject({ method: 'GET', url: `${API}/me/assignments`, token: w.students[1].token })).items[0].status).toBe('not_started');
  });
});
