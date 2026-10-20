import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from './i18n.js';
import { ENDPOINTS, LoginRequestSchema, OtpStartRequestSchema, PhoneSchema, formatKgPhone, normalizeKgPhone } from './api/index.js';

describe('contract 0.7.0: phone-first accounts', () => {
  it('version is 0.7.0 or later', () => expect(CONTRACT_VERSION >= '0.7.0').toBe(true));

  it.each([
    ['+996 555 12 34 56', '+996555123456'],
    ['0555123456', '+996555123456'],
    ['996 (700) 12-34-56', '+996700123456'],
    ['555123456', '+996555123456'],
  ])('normalizes %s', (raw, e164) => {
    expect(normalizeKgPhone(raw)).toBe(e164);
    expect(PhoneSchema.parse(raw)).toBe(e164);
  });

  it('rejects numbers that are not Kyrgyz mobiles', () => {
    for (const bad of ['+7 701 123 45 67', '+99655512345', '12345', '']) expect(PhoneSchema.safeParse(bad).success).toBe(false);
  });

  it('formats for display', () => expect(formatKgPhone('+996555123456')).toBe('+996 555 12 34 56'));

  it('login takes exactly one of email and phone', () => {
    expect(LoginRequestSchema.safeParse({ phone: '0555123456', password: 'x' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ email: 'a@b.kg', password: 'x' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ password: 'x' }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({ email: 'a@b.kg', phone: '0555123456', password: 'x' }).success).toBe(false);
  });

  it('otp endpoints are public; purposes register and reset', () => {
    expect([ENDPOINTS.otpStart.auth, ENDPOINTS.otpVerify.auth, ENDPOINTS.registerComplete.auth, ENDPOINTS.passwordSet.auth]).toEqual([null, null, null, null]);
    expect(OtpStartRequestSchema.safeParse({ phone: '0555123456', purpose: 'login' }).success).toBe(false);
  });
});
