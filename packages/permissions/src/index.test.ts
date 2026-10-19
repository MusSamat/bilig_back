import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  can,
  canEditField,
  editableFields,
  grantFor,
  grantLevel,
  grantedPermissions,
  isGuest,
  isValidGrant,
  CONTRACT_VERSION,
  GUEST,
  MATRIX,
  PERMISSIONS,
  ROLES,
  ROLE_SCOPE,
  type Grant,
  type Principal,
  type Permission,
  type Role,
  type RoleGrant,
} from './index.js';

const p = (...grants: RoleGrant[]): Principal => ({ userId: 'u', grants });
const student = (classId: string) => p({ role: 'student', scope: 'class', scopeId: classId });
const teacher = (schoolId: string) => p({ role: 'teacher', scope: 'school', scopeId: schoolId });
const schoolAdmin = (schoolId: string) =>
  p({ role: 'school_admin', scope: 'school', scopeId: schoolId });
const author = (subjectId: string, subrole?: RoleGrant['subrole']) =>
  p({ role: 'author', scope: 'subject', scopeId: subjectId, subrole });
const editor = (subjectId: string) => p({ role: 'editor', scope: 'subject', scopeId: subjectId });
const superadmin = p({ role: 'superadmin', scope: 'platform' });

/**
 * TZ §2 matrix, row by row, in TZ column order:
 * guest, student, teacher, school_admin, author, editor, superadmin.
 */
const TZ: Record<Permission, Grant[]> = {
  'demo.view': ['all', 'all', 'all', 'all', 'all', 'all', 'all'],
  'topic.view': [false, 'all', 'all', 'all', 'all', 'all', 'all'],
  'assistant.ask.online': ['limit', 'all', 'all', 'all', 'all', 'all', 'all'],
  'quiz.attempt.save': [false, 'all', 'all', false, false, false, false],
  'class.manage': [false, false, 'own', 'own', false, false, 'all'],
  'assignment.manage': [false, false, 'own', 'own', false, false, 'all'],
  'school.teachers.manage': [false, false, false, 'own', false, false, 'all'],
  'content.draft.edit': [false, false, false, false, 'own', 'own', 'all'],
  'model.upload': [false, false, false, false, 'own', 'own', 'all'],
  'content.publish': [false, false, false, false, false, 'own', 'all'],
  'platform.manage': [false, false, false, false, false, false, 'all'],
  'audit.view': [false, false, false, 'own', false, false, 'all'],
  // v0.5.0, beyond TZ §2: КТП and lesson plans (records are owner-only)
  'lesson.plan': [false, false, 'all', 'all', false, false, 'all'],
};

describe('contract version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(CONTRACT_VERSION).toBe(pkg.version);
  });
});

describe('MATRIX (TZ §2 permission table, exact)', () => {
  it('equals the TZ table cell by cell', () => {
    for (const perm of PERMISSIONS) {
      ROLES.forEach((role, i) => {
        expect(MATRIX[perm][role], `${perm}/${role}`).toBe(TZ[perm][i]);
      });
    }
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('superadmin can do everything EXCEPT save quiz attempts', () => {
    for (const perm of PERMISSIONS) {
      if (perm === 'quiz.attempt.save') expect(MATRIX[perm].superadmin).toBe(false);
      else expect(MATRIX[perm].superadmin, perm).toBe('all');
    }
  });

  it('every role has a legal scope (guest has none)', () => {
    expect(ROLE_SCOPE.guest).toBeNull();
    for (const r of ROLES.filter((x) => x !== 'guest')) expect(ROLE_SCOPE[r]).toBeTruthy();
  });
});

describe('grant validity', () => {
  it('rejects a role on the wrong scope, missing scopeId, guest grants, bad subroles', () => {
    expect(isValidGrant({ role: 'teacher', scope: 'school', scopeId: 's1' })).toBe(true);
    expect(isValidGrant({ role: 'superadmin', scope: 'platform' })).toBe(true);
    expect(isValidGrant({ role: 'teacher', scope: 'platform' })).toBe(false);
    expect(isValidGrant({ role: 'teacher', scope: 'school' })).toBe(false);
    expect(isValidGrant({ role: 'guest', scope: 'platform' })).toBe(false);
    expect(isValidGrant({ role: 'nope' as Role, scope: 'platform' })).toBe(false);
    expect(
      isValidGrant({ role: 'author', scope: 'subject', scopeId: 'b', subrole: 'x' as never }),
    ).toBe(false);
  });

  it("an 'own' role with platform scope no longer passes everything", () => {
    const bad = p({ role: 'teacher', scope: 'platform' });
    expect(can(bad, 'class.manage', { schoolId: 'any' })).toBe(false);
    expect(can(bad, 'class.manage')).toBe(false);
    // the invalid grant is ignored => principal falls back to guest
    expect(isGuest(bad)).toBe(true);
    expect(grantedPermissions(bad)).toEqual(grantedPermissions(GUEST));
    const badEditor = p({ role: 'editor', scope: 'platform' });
    expect(can(badEditor, 'content.publish', { subjectId: 'bio' })).toBe(false);
  });

  it('invalid grants yield level false', () => {
    expect(grantLevel({ role: 'teacher', scope: 'platform' }, 'class.manage')).toBe(false);
  });
});

describe('guests', () => {
  it('can view demos and ask the assistant with a limit', () => {
    expect(can(GUEST, 'demo.view')).toBe(true);
    expect(grantFor(GUEST, 'assistant.ask.online')).toBe('limit');
    expect(can(GUEST, 'assistant.ask.online')).toBe(true);
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
    expect(can(t, 'class.manage', {})).toBe(false);
    expect(can(t, 'class.manage', { subjectId: 'school-1' })).toBe(false); // wrong axis
  });

  it('school admin: teachers + audit only in own school', () => {
    const a = schoolAdmin('s1');
    expect(can(a, 'school.teachers.manage', { schoolId: 's1' })).toBe(true);
    expect(can(a, 'audit.view', { schoolId: 's2' })).toBe(false);
    expect(can(a, 'quiz.attempt.save')).toBe(false);
  });

  it('student class scope never covers school resources', () => {
    expect(can(student('c1'), 'class.manage', { classId: 'c1' })).toBe(false);
  });

  it('author edits drafts only in their own subject', () => {
    const a = author('subj-bio');
    expect(can(a, 'content.draft.edit', { subjectId: 'subj-bio' })).toBe(true);
    expect(can(a, 'content.draft.edit', { subjectId: 'subj-chem' })).toBe(false);
  });

  it('author cannot publish, editor can publish own subject', () => {
    expect(can(author('bio'), 'content.publish', { subjectId: 'bio' })).toBe(false);
    expect(can(editor('bio'), 'content.publish', { subjectId: 'bio' })).toBe(true);
    expect(can(editor('bio'), 'content.publish', { subjectId: 'chem' })).toBe(false);
  });
});

describe('superadmin & platform scope', () => {
  it("passes every 'all' permission regardless of resource", () => {
    for (const perm of PERMISSIONS.filter((x) => x !== 'quiz.attempt.save')) {
      expect(can(superadmin, perm, { schoolId: 'x', subjectId: 'y' }), perm).toBe(true);
    }
    expect(can(superadmin, 'quiz.attempt.save')).toBe(false);
  });

  it('platform.manage is superadmin-only', () => {
    expect(can(teacher('s1'), 'platform.manage')).toBe(false);
    expect(can(editor('subj'), 'platform.manage', { subjectId: 'subj' })).toBe(false);
    expect(can(superadmin, 'platform.manage')).toBe(true);
  });
});

describe('author sub-roles narrow editing', () => {
  const res = { subjectId: 'bio' };

  it('translator edits strings only and cannot upload models', () => {
    const tr = author('bio', 'translator');
    expect(editableFields(tr, res)).toEqual(['strings']);
    expect(canEditField(tr, 'assets', res)).toBe(false);
    expect(can(tr, 'content.draft.edit', res)).toBe(true);
    expect(can(tr, 'model.upload', res)).toBe(false);
  });

  it('artist edits assets only and may upload models', () => {
    const ar = author('bio', 'artist');
    expect(editableFields(ar, res)).toEqual(['assets']);
    expect(can(ar, 'model.upload', res)).toBe(true);
    expect(can(ar, 'model.upload', { subjectId: 'chem' })).toBe(false);
  });

  it('methodist edits structure + strings, no model upload', () => {
    const m = author('bio', 'methodist');
    expect(editableFields(m, res)).toEqual(['structure', 'strings']);
    expect(can(m, 'model.upload', res)).toBe(false);
  });

  it('author without subrole, editor and superadmin edit all field groups', () => {
    expect(editableFields(author('bio'), res)).toEqual(['structure', 'strings', 'assets']);
    expect(editableFields(editor('bio'), res)).toEqual(['structure', 'strings', 'assets']);
    expect(editableFields(superadmin, res)).toEqual(['structure', 'strings', 'assets']);
  });

  it('subroles do not affect non-content permissions; ignored on non-author roles', () => {
    expect(can(author('bio', 'translator'), 'topic.view')).toBe(true);
    const ed = p({ role: 'editor', scope: 'subject', scopeId: 'bio', subrole: 'translator' });
    expect(editableFields(ed, res)).toEqual(['structure', 'strings', 'assets']);
  });

  it('no fields outside the scope or without the permission', () => {
    expect(editableFields(author('bio'), { subjectId: 'chem' })).toEqual([]);
    expect(editableFields(teacher('s1'), { schoolId: 's1' })).toEqual([]);
    expect(editableFields(GUEST)).toEqual([]);
  });

  it('two author grants union their fields', () => {
    const both = p(
      { role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'translator' },
      { role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'artist' },
    );
    expect(editableFields(both, res)).toEqual(['strings', 'assets']);
  });
});

describe('multiple roles take the strongest grant', () => {
  it('teacher in one school + author in biology', () => {
    const multi = p(
      { role: 'teacher', scope: 'school', scopeId: 'school-1' },
      { role: 'author', scope: 'subject', scopeId: 'subj-bio' },
    );
    expect(can(multi, 'class.manage', { schoolId: 'school-1' })).toBe(true);
    expect(can(multi, 'content.draft.edit', { subjectId: 'subj-bio' })).toBe(true);
    expect(can(multi, 'content.draft.edit', { subjectId: 'subj-chem' })).toBe(false);
    expect(grantFor(multi, 'content.draft.edit')).toBe('own');
    expect(grantFor(multi, 'quiz.attempt.save')).toBe('all');
  });
});

describe('grantedPermissions (FE button hiding)', () => {
  it('lists only non-false permissions for the principal', () => {
    const perms = grantedPermissions(student('class-1'));
    expect(perms).toEqual(['demo.view', 'topic.view', 'assistant.ask.online', 'quiz.attempt.save']);
  });

  it('a guest still sees demo + assistant', () => {
    expect(grantedPermissions(GUEST)).toEqual(['demo.view', 'assistant.ask.online']);
  });

  it('superadmin gets everything but quiz.attempt.save', () => {
    expect(grantedPermissions(superadmin)).toEqual(
      PERMISSIONS.filter((x) => x !== 'quiz.attempt.save'),
    );
  });

  it('a translator does not get model.upload', () => {
    expect(grantedPermissions(author('bio', 'translator'))).not.toContain('model.upload');
  });
});
