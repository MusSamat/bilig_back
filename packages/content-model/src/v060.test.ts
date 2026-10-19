import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from './i18n.js';
import { ClassCreateRequestSchema, ENDPOINTS, MePatchRequestSchema, RegisterRequestSchema, RegisterVerifyRequestSchema } from './api/index.js';

describe('contract 0.6.0: teacher self-registration', () => {
  it('version', () => expect(CONTRACT_VERSION).toBe('0.6.0'));

  it('register needs subjects and grades; the code is 6 digits', () => {
    const ok = { email: 'a@b.kg', displayName: 'Айгүл', password: 'long-enough-1', locale: 'ky', teaching: { subjects: ['phys'], grades: [8] } };
    expect(RegisterRequestSchema.safeParse(ok).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...ok, teaching: { subjects: [], grades: [8] } }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...ok, password: 'short' }).success).toBe(false);
    expect(RegisterVerifyRequestSchema.safeParse({ email: 'a@b.kg', code: '012345' }).success).toBe(true);
    expect(RegisterVerifyRequestSchema.safeParse({ email: 'a@b.kg', code: '12345' }).success).toBe(false);
  });

  it('endpoints are public; teaching on PATCH /me and subjectKey on classes are optional', () => {
    expect([ENDPOINTS.register.auth, ENDPOINTS.registerVerify.auth, ENDPOINTS.registerResend.auth]).toEqual([null, null, null]);
    expect(MePatchRequestSchema.safeParse({ teaching: { subjects: ['chem', 'bio'], grades: [8, 9] } }).success).toBe(true);
    expect(ClassCreateRequestSchema.safeParse({ name: '8А', grade: 8 }).success).toBe(true);
    expect(ClassCreateRequestSchema.safeParse({ name: '8А', grade: 8, subjectKey: 'phys' }).success).toBe(true);
  });
});
