/**
 * Auth (TZ §6, §9 Auth): e-mail + password (+TOTP for admin roles), class
 * code → name list → PIN for students, refresh rotation, logout(-all),
 * password reset (30-min link), e-mail verification, invites.
 * Unknown e-mail and wrong password produce the same response and timing.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../ids.js';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import { hashToken, randomPin, randomToken, safeEqual, sha256Hex } from '../domain/crypto.js';
import { checkPassword, hashSecret, verifyDummy, verifySecret } from '../domain/passwords.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../domain/totp.js';
import { SessionService, audienceOf } from '../services/sessions.js';
import type { SignupRec, UserRec } from '../repo/types.js';
import { accountExistsMail, codeMail, provisionSelfTeacher } from '../services/teacher-signup.js';

export const RESET_TTL_MS = 30 * 60 * 1000;
export const VERIFY_TTL_MS = 24 * 3600 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export const PIN_MAX_FAILS = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;
/** v0.3.0: lifetime of the admin TOTP enrolment token. */
export const ENROLL_TTL_MS = 10 * 60 * 1000;

/** v0.6.0: e-mail registration codes — 6 digits, 15 minutes, 5 wrong tries, resend after 60 s. */
export const CODE_TTL_MS = 15 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_AFTER_S = 60;
/** Codes are short, so the stored hash is bound to the token id (equal codes never collide on the unique index). */
export const codeHash = (tokenId: string, code: string) => sha256Hex(`bilig:email_code:${tokenId}:${code}`);

/** Roles that must use TOTP for the admin audience (TZ §6). */
export const TOTP_ROLES = new Set(['author', 'editor', 'superadmin']);

const emailKey = (email: string) => sha256Hex(`email:${email.toLowerCase()}`).slice(0, 24);

export function registerAuth(app: FastifyInstance, deps: Deps) {
  const sessions = new SessionService(deps);
  const { repo, limiter, clock, audit, mailer, config } = deps;

  const limit = async (key: string, max: number, windowSec: number) => {
    const r = await limiter.hit(key, max, windowSec);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
  };

  const passwordOk = (pw: string, ctx: string[]) => {
    const problem = checkPassword(pw, ctx);
    if (problem) fail('password_weak', { detail: problem, i18nKey: `errors.password_weak.${problem}` });
  };

  // POST /auth/login
  route(app, deps, 'login', async ({ req, reply, body, ip }) => {
    const email = body.email.toLowerCase();
    await limit(`login:ip:${ip}`, 30, 15 * 60);
    await limit(`login:email:${emailKey(email)}`, 10, 15 * 60);
    const aud = audienceOf(req);
    const user = await repo.getUserByEmail(email);
    const cred = user && user.kind === 'adult' && !user.deletedAt ? await repo.getCredential(user.id, 'password') : null;
    const ok = cred ? await verifySecret(cred.secretHash, body.password) : await verifyDummy(body.password);
    if (!ok || !user) {
      await audit.log(user?.id ?? null, 'auth.login_failed', { type: 'user', id: user?.id ?? emailKey(email) }, { ip });
      fail('invalid_credentials');
    }
    const u = user!;
    if (u.status === 'pending') fail('email_not_verified');
    if (u.status !== 'active') fail('forbidden', { detail: 'account_blocked' });

    if (aud === 'admin' && !config.adminTotpDisabled) {
      const grants = await repo.listGrants(u.id);
      if (grants.some((g) => TOTP_ROLES.has(g.role))) {
        const totp = await repo.getCredential(u.id, 'totp');
        if (!totp || totp.secretHash.startsWith('pending:')) {
          // v0.3.0: a short-lived, single-user enrolment token (POST /auth/2fa/setup → /auth/2fa/verify).
          const token = randomToken();
          await repo.createAuthToken({ id: newId(), userId: u.id, purpose: 'totp_enroll', tokenHash: hashToken(token), expiresAt: new Date(clock.now().getTime() + ENROLL_TTL_MS), usedAt: null });
          await audit.log(u.id, 'auth.2fa_enrollment_started', { type: 'user', id: u.id }, { ip });
          fail('forbidden', { detail: 'totp_enrollment_required', enrollmentToken: token });
        }
        if (!body.totp) fail('totp_required');
        await limit(`totp:${u.id}`, 10, 15 * 60);
        if (!verifyTotp(totp!.secretHash, body.totp!, clock.now())) {
          await audit.log(u.id, 'auth.login_failed', { type: 'user', id: u.id }, { ip, diff: { reason: 'totp' } });
          fail('invalid_credentials');
        }
      }
    }
    const issued = await sessions.start(req, reply, u, aud);
    await audit.log(u.id, 'auth.login', { type: 'user', id: u.id }, { ip, diff: { aud } });
    return issued;
  });

  // v0.3.0: first-time TOTP enrolment for the admin audience with the token from the 403.
  async function enrollee(token: string, ip: string): Promise<UserRec> {
    await limit(`enroll:ip:${ip}`, 30, 15 * 60);
    const t = await repo.findAuthToken(hashToken(token), 'totp_enroll', clock.now());
    const user = t ? await repo.getUser(t.userId) : null;
    if (!t || !user || user.deletedAt || user.status !== 'active' || user.kind !== 'adult' || !user.email) fail('unauthorized', { detail: 'enrollment_token_invalid' });
    const active = await repo.getCredential(user!.id, 'totp');
    if (active && !active.secretHash.startsWith('pending:')) fail('conflict', { detail: 'totp_already_enabled' });
    return user!;
  }

  route(app, deps, 'authTotpEnrollSetup', async ({ body, ip }) => {
    const user = await enrollee(body.enrollmentToken, ip);
    const secret = newTotpSecret();
    await repo.setCredential(user.id, 'totp', `pending:${secret}`);
    return { enabled: false, otpauthUrl: otpauthUrl(secret, user.email!) };
  });

  route(app, deps, 'authTotpEnrollVerify', async ({ req, reply, body, ip }) => {
    const user = await enrollee(body.enrollmentToken, ip);
    await limit(`totp:${user.id}`, 10, 15 * 60);
    const cur = await repo.getCredential(user.id, 'totp');
    if (!cur) fail('conflict', { detail: 'totp_not_pending' });
    const secret = cur!.secretHash.slice('pending:'.length);
    if (!verifyTotp(secret, body.code, clock.now())) {
      await audit.log(user.id, 'auth.login_failed', { type: 'user', id: user.id }, { ip, diff: { reason: 'totp_enroll' } });
      fail('invalid_credentials');
    }
    if (!(await repo.consumeAuthToken(hashToken(body.enrollmentToken), 'totp_enroll', clock.now()))) fail('unauthorized', { detail: 'enrollment_token_invalid' });
    await repo.setCredential(user.id, 'totp', secret);
    await audit.log(user.id, 'auth.2fa_enabled', { type: 'user', id: user.id }, { ip, diff: { via: 'admin_enrollment' } });
    const issued = await sessions.start(req, reply, user, 'admin');
    await audit.log(user.id, 'auth.login', { type: 'user', id: user.id }, { ip, diff: { aud: 'admin' } });
    return issued;
  });

  // POST /auth/class-code → class name + student list
  route(app, deps, 'classCode', async ({ body, ip }) => {
    await limit(`classcode:ip:${ip}`, 20, 60);
    const cls = await repo.getClassByJoinCode(body.code);
    if (!cls || !cls.joinCodeEnabled) fail('class_code_invalid');
    const enr = await repo.listEnrollments({ classId: cls!.id, role: 'student' });
    const users = (await repo.getUsers(enr.map((e) => e.userId))).filter((u) => u.status === 'active' && !u.deletedAt);
    await audit.log(null, 'student.data_access', { type: 'class', id: cls!.id }, { ip, diff: { via: 'class_code', count: users.length } });
    return {
      classId: cls!.id,
      className: cls!.name,
      students: users
        .map((u) => ({ id: u.id, displayName: u.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru')),
    };
  });

  // POST /auth/student-login → PIN, lockout after 5 bad tries for 15 minutes
  route(app, deps, 'studentLogin', async ({ req, reply, body, ip }) => {
    await limit(`studentlogin:ip:${ip}`, 60, 60);
    const now = clock.now();
    const cls = await repo.getClass(body.classId);
    const enrolled = cls?.joinCodeEnabled
      ? (await repo.listEnrollments({ classId: cls.id, userId: body.studentId, role: 'student' })).length > 0
      : false;
    const student = enrolled ? await repo.getUser(body.studentId) : null;
    const cred = student && student.status === 'active' && !student.deletedAt ? await repo.getCredential(student.id, 'pin') : null;
    if (!cred || !student) {
      await verifyDummy(body.pin);
      fail('invalid_credentials');
    }
    if (cred!.lockedUntil && cred!.lockedUntil > now) {
      fail('pin_locked', { retryAfter: Math.ceil((cred!.lockedUntil.getTime() - now.getTime()) / 1000) });
    }
    if (!(await verifySecret(cred!.secretHash, body.pin))) {
      const fails = cred!.failedCount + 1;
      if (fails >= PIN_MAX_FAILS) {
        await repo.updateCredential(student!.id, 'pin', { failedCount: 0, lockedUntil: new Date(now.getTime() + PIN_LOCK_MS) });
        await audit.log(null, 'auth.pin_locked', { type: 'user', id: student!.id }, { ip });
        fail('pin_locked', { retryAfter: PIN_LOCK_MS / 1000 });
      }
      await repo.updateCredential(student!.id, 'pin', { failedCount: fails, lockedUntil: null });
      fail('invalid_credentials');
    }
    await repo.updateCredential(student!.id, 'pin', { failedCount: 0, lockedUntil: null });
    const issued = await sessions.start(req, reply, student!, 'client');
    await audit.log(student!.id, 'auth.student_login', { type: 'user', id: student!.id }, { ip });
    return issued;
  });

  // POST /auth/refresh — rotation with family reuse detection
  route(app, deps, 'refresh', async ({ req, reply, ip }) => {
    await limit(`refresh:ip:${ip}`, 120, 60);
    const aud = audienceOf(req);
    const issued = await sessions.refresh(req, reply, aud);
    if (!issued) {
      sessions.clearCookie(reply, aud);
      fail('unauthorized', { detail: 'refresh_invalid' });
    }
    return issued!;
  });

  route(app, deps, 'logout', async ({ req, reply }) => {
    await sessions.logout(req, reply, audienceOf(req));
    return { ok: true as const };
  });

  route(app, deps, 'logoutAll', async ({ req, reply, userId, ip }) => {
    const uid = userId();
    const n = await repo.revokeUserSessions(uid, clock.now());
    sessions.clearCookie(reply, audienceOf(req));
    await audit.log(uid, 'auth.logout_all', { type: 'user', id: uid }, { ip, diff: { revoked: n } });
    return { ok: true as const };
  });

  // POST /auth/password/forgot — always 200 (no account enumeration)
  route(app, deps, 'passwordForgot', async ({ body, ip }) => {
    const email = body.email.toLowerCase();
    await limit(`forgot:ip:${ip}`, 10, 3600);
    const perEmail = await limiter.hit(`forgot:email:${emailKey(email)}`, 3, 3600);
    const user = perEmail.allowed ? await repo.getUserByEmail(email) : null;
    if (user && user.kind === 'adult' && user.status !== 'blocked' && !user.deletedAt) await sendReset(user);
    return { ok: true as const };
  });

  async function sendReset(user: UserRec) {
    const token = randomToken();
    const now = clock.now();
    await repo.createAuthToken({ id: newId(), userId: user.id, purpose: 'password_reset', tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + RESET_TTL_MS), usedAt: null });
    const link = `${config.appUrl}/reset-password?token=${token}`;
    await mailer.send({ to: user.email!, kind: 'password_reset', link, subject: 'Bilig: восстановление пароля', text: `Ссылка действует 30 минут:\n${link}` });
  }
  app.decorate('sendPasswordReset', sendReset);

  route(app, deps, 'passwordReset', async ({ body, ip }) => {
    await limit(`reset:ip:${ip}`, 20, 3600);
    passwordOk(body.password, []); // before consuming, so a weak attempt keeps the link usable
    const t = await repo.consumeAuthToken(hashToken(body.token), 'password_reset', clock.now());
    if (!t) fail('not_found', { detail: 'token_invalid' });
    const user = await repo.getUser(t!.userId);
    if (!user || user.deletedAt) fail('not_found', { detail: 'token_invalid' });
    passwordOk(body.password, [user!.email ?? '', user!.displayName]);
    await repo.setCredential(user!.id, 'password', await hashSecret(body.password));
    if (user!.status === 'pending') await repo.updateUser(user!.id, { status: 'active', emailVerifiedAt: clock.now() });
    await repo.revokeUserSessions(user!.id, clock.now());
    await audit.log(user!.id, 'auth.password_reset', { type: 'user', id: user!.id }, { ip });
    return { ok: true as const };
  });

  // --- v0.2.1 + v0.6.0: teacher self-registration -----------------------------------
  const codeResponse = () => ({ ok: true as const, expiresIn: CODE_TTL_MS / 1000, resendAfter: CODE_RESEND_AFTER_S });

  /** A new 6-digit code (the old one is invalidated) + the v0.2.1 link, mailed in the user's language. */
  async function sendCode(user: UserRec) {
    const now = clock.now();
    await repo.revokeAuthTokens(user.id, 'email_code', now);
    await repo.revokeAuthTokens(user.id, 'email_verify', now);
    const code = config.authFixedOtp ?? randomPin(6);
    const id = newId();
    await repo.createAuthToken({ id, userId: user.id, purpose: 'email_code', tokenHash: codeHash(id, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS), usedAt: null, attempts: 0 });
    const token = randomToken();
    await repo.createAuthToken({ id: newId(), userId: user.id, purpose: 'email_verify', tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + VERIFY_TTL_MS), usedAt: null });
    const link = `${config.appUrl}/verify-email?token=${token}`;
    await mailer.send({ to: user.email!, kind: 'email_code', code, link, ...codeMail(user.locale, code, CODE_TTL_MS / 60_000, link) });
  }

  /** An active account got a sign-up attempt: tell its owner and offer a password reset (no code). */
  async function sendAccountExists(user: UserRec) {
    const token = randomToken();
    await repo.createAuthToken({ id: newId(), userId: user.id, purpose: 'password_reset', tokenHash: hashToken(token), expiresAt: new Date(clock.now().getTime() + RESET_TTL_MS), usedAt: null });
    const link = `${config.appUrl}/reset-password?token=${token}`;
    await mailer.send({ to: user.email!, kind: 'account_exists', link, ...accountExistsMail(user.locale, link) });
  }

  const pendingAdult = (u: UserRec | null): UserRec | null => (u && u.kind === 'adult' && !u.deletedAt && u.status === 'pending' && u.email ? u : null);

  /** Starts the 60-s resend window for this address (counted for every address: no enumeration). */
  const resendWindow = (email: string) => limiter.hit(`regcode:email:${emailKey(email)}`, 1, CODE_RESEND_AFTER_S);

  // POST /auth/register — the same answer whether or not the address is taken.
  route(app, deps, 'register', async ({ body, ip }) => {
    await limit(`register:ip:${ip}`, 10, 3600);
    const email = body.email.toLowerCase();
    await limit(`register:email:${emailKey(email)}`, 5, 3600);
    passwordOk(body.password, [email, body.displayName]);
    const pwHash = await hashSecret(body.password); // always hashed: equal timing for taken / free addresses
    const signup: SignupRec = {
      ...(body.teaching ? { teaching: body.teaching } : {}),
      ...(body.schoolName ? { schoolName: body.schoolName } : {}),
      ...(body.region ? { region: body.region } : {}),
    };
    await resendWindow(email);
    const existing = await repo.getUserByEmail(email);
    const pending = pendingAdult(existing);
    if (pending) {
      // A restart (e.g. a mistyped name or password): new details, new code.
      const user = (await repo.updateUser(pending.id, { displayName: body.displayName, locale: body.locale ?? pending.locale, signup }))!;
      await repo.setCredential(user.id, 'password', pwHash);
      await sendCode(user);
      return codeResponse();
    }
    if (existing) {
      if (existing.kind === 'adult' && existing.status === 'active' && !existing.deletedAt && existing.email) await sendAccountExists(existing);
      return codeResponse();
    }
    const user = await repo.createUser({ id: newId(), kind: 'adult', email, emailVerifiedAt: null, displayName: body.displayName, locale: body.locale ?? 'ky', status: 'pending', signup });
    if (user === 'conflict') return codeResponse();
    await repo.setCredential(user.id, 'password', pwHash);
    await sendCode(user);
    return codeResponse();
  });

  // POST /auth/register/resend — a new code for a pending account; 429 within 60 s of the last one.
  route(app, deps, 'registerResend', async ({ body, ip }) => {
    await limit(`register:ip:${ip}`, 10, 3600);
    const email = body.email.toLowerCase();
    const w = await resendWindow(email);
    if (!w.allowed) fail('rate_limited', { detail: 'resend_too_soon', retryAfter: w.retryAfter });
    await limit(`register:email:${emailKey(email)}`, 5, 3600);
    const user = pendingAdult(await repo.getUserByEmail(email));
    if (user) await sendCode(user);
    return codeResponse();
  });

  // POST /auth/register/verify — the 6-digit code activates the account, provisions the workspace and signs in.
  route(app, deps, 'registerVerify', async ({ req, reply, body, ip }) => {
    await limit(`regverify:ip:${ip}`, 30, 3600);
    const email = body.email.toLowerCase();
    await limit(`regverify:email:${emailKey(email)}`, 20, 3600);
    const now = clock.now();
    const user = pendingAdult(await repo.getUserByEmail(email));
    const tok = user ? await repo.latestAuthToken(user.id, 'email_code') : null;
    // Unknown address, already active, consumed, burned or expired: one answer — request a new code.
    if (!user || !tok || tok.usedAt || tok.expiresAt <= now) fail('invalid_credentials', { detail: 'code_expired' });
    if (!safeEqual(codeHash(tok!.id, body.code), tok!.tokenHash)) {
      const n = await repo.failAuthTokenAttempt(tok!.id, CODE_MAX_ATTEMPTS, now);
      await audit.log(user!.id, 'auth.login_failed', { type: 'user', id: user!.id }, { ip, diff: { reason: 'email_code', attempts: n } });
      fail('invalid_credentials', { detail: n === 0 || n >= CODE_MAX_ATTEMPTS ? 'code_expired' : 'code_invalid' });
    }
    if (!(await repo.consumeAuthToken(tok!.tokenHash, 'email_code', now))) fail('invalid_credentials', { detail: 'code_expired' });
    await repo.revokeAuthTokens(user!.id, 'email_verify', now);
    const active = await provisionSelfTeacher(deps, user!, ip);
    const issued = await sessions.start(req, reply, active, 'client');
    await audit.log(active.id, 'auth.login', { type: 'user', id: active.id }, { ip, diff: { aud: 'client', via: 'email_code' } });
    return issued;
  });

  // POST /auth/email/verify — the v0.2.1 link; provisions like the code when sign-up details are pending.
  route(app, deps, 'emailVerify', async ({ body, ip }) => {
    await limit(`verify:ip:${ip}`, 30, 3600);
    const t = await repo.consumeAuthToken(hashToken(body.token), 'email_verify', clock.now());
    if (!t) fail('not_found', { detail: 'token_invalid' });
    const user = await repo.getUser(t!.userId);
    if (!user) fail('not_found', { detail: 'token_invalid' });
    if (user!.status === 'pending' && user!.signup) {
      await repo.revokeAuthTokens(user!.id, 'email_code', clock.now());
      await provisionSelfTeacher(deps, user!, ip);
      return { ok: true as const };
    }
    await repo.updateUser(user!.id, { emailVerifiedAt: clock.now(), ...(user!.status === 'pending' ? { status: 'active' as const } : {}) });
    return { ok: true as const };
  });

  // POST /auth/invites/:token/accept
  route(app, deps, 'inviteAccept', async ({ req, reply, body, params, ip }) => {
    await limit(`invite:ip:${ip}`, 20, 3600);
    const now = clock.now();
    const inv = await repo.getInviteByHash(hashToken(params.token ?? ''));
    if (!inv || inv.acceptedAt || inv.expiresAt <= now) fail('not_found', { detail: 'invite_invalid' });
    let user = await repo.getUserByEmail(inv!.email);
    if (user && (user.deletedAt || user.status === 'blocked')) fail('forbidden');
    if (!user) {
      passwordOk(body.password, [inv!.email, body.displayName]);
      const created = await repo.createUser({ id: newId(), kind: 'adult', email: inv!.email, emailVerifiedAt: now, displayName: body.displayName, locale: 'ky', status: 'active' });
      if (created === 'conflict') fail('conflict');
      user = created as UserRec;
      await repo.setCredential(user.id, 'password', await hashSecret(body.password));
    } else if (user.status === 'pending' || user.status === 'invited') {
      user = (await repo.updateUser(user.id, { status: 'active', emailVerifiedAt: now }))!;
    }
    if (!(await repo.markInviteAccepted(inv!.id, now))) fail('not_found', { detail: 'invite_invalid' });
    const grant = { userId: user.id, role: inv!.role, scope: inv!.scope, scopeId: inv!.scopeId, subrole: inv!.subrole };
    await repo.addGrant(grant);
    await audit.log(user.id, 'auth.invite_accepted', { type: 'invite', id: inv!.id }, { ip });
    await audit.log(inv!.invitedBy, 'user.grants_changed', { type: 'user', id: user.id }, { ip, diff: { added: [grant] } });
    return sessions.start(req, reply, user, 'client');
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    sendPasswordReset(user: UserRec): Promise<void>;
  }
}
