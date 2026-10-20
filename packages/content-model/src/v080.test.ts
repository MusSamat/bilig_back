import { describe, expect, it } from 'vitest';
import { MANAGER_ASSIGNABLE, grantFor } from '@bilig/permissions';
import { CONTRACT_VERSION } from './i18n.js';
import { parseGradeSegment } from './curriculum.js';
import { ClassCreateRequestSchema, ENDPOINTS, StaffInviteRequestSchema, SupportStartRequestSchema } from './api/index.js';

describe('contract 0.8.0: roles, support, journal', () => {
  it('version', () => expect(CONTRACT_VERSION).toBe('0.8.0'));

  it('grades 1–12 (g12 is a valid URL segment)', () => {
    expect(parseGradeSegment('g12')).toBe(12);
    expect(parseGradeSegment('g13')).toBeNull();
    expect(ClassCreateRequestSchema.safeParse({ name: '12А', grade: 12, subjectKeys: ['phys', 'chem'] }).success).toBe(true);
  });

  it('edit support needs a reason and the 2FA code; view needs neither', () => {
    expect(SupportStartRequestSchema.safeParse({ mode: 'view' }).success).toBe(true);
    expect(SupportStartRequestSchema.safeParse({ mode: 'edit', reason: 'fix the КТП dates' }).success).toBe(false);
    expect(SupportStartRequestSchema.safeParse({ mode: 'edit', reason: 'short', totp: '123456' }).success).toBe(false);
    expect(SupportStartRequestSchema.safeParse({ mode: 'edit', reason: 'teacher asked to fix the КТП dates', totp: '123456' }).success).toBe(true);
  });

  it('only SuperAdmin manages staff and approves deletions; managers request', () => {
    const sa = { userId: 's', grants: [{ role: 'superadmin' as const, scope: 'platform' as const }] };
    const mgr = { userId: 'm', grants: [{ role: 'manager' as const, scope: 'platform' as const, permissions: [...MANAGER_ASSIGNABLE] }] };
    expect(ENDPOINTS.staffInvite.auth).toBe('staff.manage');
    expect(grantFor(sa, 'staff.manage')).toBe('all');
    expect(grantFor(mgr, 'staff.manage')).toBe(false);
    expect(grantFor(mgr, 'deletion.request')).toBe('all');
    expect(grantFor(mgr, 'deletion.approve')).toBe(false);
    expect(grantFor(mgr, 'audit.read')).toBe('own');
    expect(StaffInviteRequestSchema.safeParse({ email: 'm@bilig.kg', displayName: 'Менеджер', permissions: ['teacher.view'] }).success).toBe(true);
  });
});
