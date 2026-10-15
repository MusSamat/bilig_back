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
import { hashToken, randomToken, sha256Hex } from '../domain/crypto.js';
import { checkPassword, hashSecret, verifyDummy, verifySecret } from '../domain/passwords.js';
import { verifyTotp } from '../domain/totp.js';
import { SessionService, audienceOf } from '../services/sessions.js';
import type { UserRec } from '../repo/types.js';

export const RESET_TTL_MS = 30 * 60 * 1000;
export const VERIFY_TTL_MS = 24 * 3600 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export const PIN_MAX_FAILS = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;

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

    if (aud === 'admin') {
      const grants = await repo.listGrants(u.id);
      if (grants.some((g) => TOTP_ROLES.has(g.role))) {
        const totp = await repo.getCredential(u.id, 'totp');
        if (!totp || totp.secretHash.startsWith('pending:')) fail('forbidden', { detail: 'totp_enrollment_required' });
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

  // POST /auth/register — teacher self-registration with e-mail verification
  route(app, deps, 'register', async ({ body, ip }) => {
    await limit(`register:ip:${ip}`, 10, 3600);
    const email = body.email.toLowerCase();
    passwordOk(body.password, [email, body.displayName]);
    const existing = await repo.getUserByEmail(email);
    if (existing) return { ok: true as const }; // identical response: no enumeration
    const user = await repo.createUser({
      id: newId(),
      kind: 'adult',
      email,
      emailVerifiedAt: null,
      displayName: body.displayName,
      locale: body.locale ?? 'ky',
      status: 'pending',
    });
    if (user === 'conflict') return { ok: true as const };
    await repo.setCredential(user.id, 'password', await hashSecret(body.password));
    const token = randomToken();
    await repo.createAuthToken({ id: newId(), userId: user.id, purpose: 'email_verify', tokenHash: hashToken(token), expiresAt: new Date(clock.now().getTime() + VERIFY_TTL_MS), usedAt: null });
    const link = `${config.appUrl}/verify-email?token=${token}`;
    await mailer.send({ to: email, kind: 'email_verify', link, subject: 'Bilig: подтвердите e-mail', text: `Подтвердите адрес:\n${link}` });
    return { ok: true as const };
  });

  route(app, deps, 'emailVerify', async ({ body, ip }) => {
    await limit(`verify:ip:${ip}`, 30, 3600);
    const t = await repo.consumeAuthToken(hashToken(body.token), 'email_verify', clock.now());
    if (!t) fail('not_found', { detail: 'token_invalid' });
    const user = await repo.getUser(t!.userId);
    if (!user) fail('not_found', { detail: 'token_invalid' });
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
