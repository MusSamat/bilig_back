import { describe, it, expect } from 'vitest';
import {
  can,
  grantFor,
  grantedPermissions,
  GUEST,
  MATRIX,
  type Principal,
  type Permission,
  type Role,
} from './index.js';

const student = (classId: string): Principal => ({
  userId: 'u-student',
  grants: [{ role: 'student', scope: 'class', scopeId: classId }],
});

const teacher = (schoolId: string): Principal => ({
  userId: 'u-teacher',
  grants: [{ role: 'teacher', scope: 'school', scopeId: schoolId }],
});

const author = (subjectId: string): Principal => ({
  userId: 'u-author',
  grants: [{ role: 'author', scope: 'subject', scopeId: subjectId }],
});

const editor = (subjectId: string): Principal => ({
  userId: 'u-editor',
  grants: [{ role: 'editor', scope: 'subject', scopeId: subjectId }],
});

const superadmin: Principal = {
  userId: 'u-root',
  grants: [{ role: 'superadmin', scope: 'platform' }],
};

describe('MATRIX (TZ §2 permission table)', () => {
  const roles: Role[] = [
    'guest',
    'student',
    'teacher',
    'school_admin',
    'author',
    'editor',
    'superadmin',
  ];

  it('defines every role for every permission', () => {
    for (const perm of Object.keys(MATRIX) as Permission[]) {
      for (const role of roles) {
        expect(MATRIX[perm][role], `${perm}/${role}`).toBeDefined();
      }
    }
  });

  it('superadmin can do everything', () => {
    for (const perm of Object.keys(MATRIX) as Permission[]) {
      expect(MATRIX[perm].superadmin, perm).not.toBe(false);
    }
  });

  it('demo.view is open to everyone including guests', () => {
    for (const role of roles) expect(MATRIX['demo.view'][role]).toBe('all');
  });
});

describe('guests', () => {
  it('can view demos and ask the assistant with a limit', () => {
    expect(can(GUEST, 'demo.view')).toBe(true);
    expect(grantFor(GUEST, 'assistant.ask.online')).toBe('limit');
    expect(can(GUEST, 'assistant.ask.online')).toBe(true); // limit = allowed, quota elsewhere
  });

  it('cannot view licensed topics or save quiz attempts', () => {
    expect(can(GUEST, 'topic.view')).toBe(false);
    expect(can(GUEST, 'quiz.attempt.save')).toBe(false);
  });
});

describe("'own' scope resolution", () => {
  it('teacher manages classes only in their own school', () => {
    const t = teacher('school-1');
    expect(can(t, 'class.manage', { schoolId: 'school-1' })).toBe(true);
    expect(can(t, 'class.manage', { schoolId: 'school-2' })).toBe(false);
    expect(can(t, 'class.manage', {})).toBe(false); // no scope context => deny
  });

  it('author edits drafts only in their own subject', () => {
    const a = author('subj-bio');
    expect(can(a, 'content.draft.edit', { subjectId: 'subj-bio' })).toBe(true);
    expect(can(a, 'content.draft.edit', { subjectId: 'subj-chem' })).toBe(false);
  });

  it('author cannot publish, editor can publish own subject', () => {
    expect(can(author('subj-bio'), 'content.publish', { subjectId: 'subj-bio' })).toBe(
      false,
    );
    expect(can(editor('subj-bio'), 'content.publish', { subjectId: 'subj-bio' })).toBe(
      true,
    );
    expect(can(editor('subj-bio'), 'content.publish', { subjectId: 'subj-chem' })).toBe(
      false,
    );
  });
});

describe('superadmin & platform scope', () => {
  it('passes every permission regardless of resource', () => {
    for (const perm of Object.keys(MATRIX) as Permission[]) {
      expect(can(superadmin, perm, { schoolId: 'x', subjectId: 'y' })).toBe(true);
    }
  });

  it('platform.manage is superadmin-only', () => {
    expect(can(teacher('s1'), 'platform.manage')).toBe(false);
    expect(can(editor('subj'), 'platform.manage')).toBe(false);
    expect(can(superadmin, 'platform.manage')).toBe(true);
  });
});

describe('multiple roles take the strongest grant', () => {
  it('teacher in one school + author in biology', () => {
    const multi: Principal = {
      userId: 'u-multi',
      grants: [
        { role: 'teacher', scope: 'school', scopeId: 'school-1' },
        { role: 'author', scope: 'subject', scopeId: 'subj-bio' },
      ],
    };
    expect(can(multi, 'class.manage', { schoolId: 'school-1' })).toBe(true);
    expect(can(multi, 'content.draft.edit', { subjectId: 'subj-bio' })).toBe(true);
    expect(can(multi, 'content.draft.edit', { subjectId: 'subj-chem' })).toBe(false);
  });
});

describe('grantedPermissions (FE button hiding)', () => {
  it('lists only non-false permissions for the principal', () => {
    const perms = grantedPermissions(student('class-1'));
    expect(perms).toContain('topic.view');
    expect(perms).toContain('quiz.attempt.save');
    expect(perms).not.toContain('content.publish');
    expect(perms).not.toContain('platform.manage');
  });

  it('a guest still sees demo + assistant', () => {
    const perms = grantedPermissions(GUEST);
    expect(perms).toEqual(
      expect.arrayContaining(['demo.view', 'assistant.ask.online']),
    );
    expect(perms).not.toContain('topic.view');
  });
});
