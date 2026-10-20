/**
 * Repository contract suite: the same behavioural tests run against
 * MemoryRepository (always, in `npm test`) and PrismaRepository (when
 * TEST_DATABASE_URL is set; `npm run test:db`). `make()` must return an
 * EMPTY repository for every test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import { newId } from '../ids.js';
import type { ContentPackage } from '@bilig/content-model';
import type { AuditEventInput, BuildRec, ClassRec, GeneratedRec, PhoneOtpRec, Repository, SessionRec, TopicVersionRec, UserRec } from './types.js';

const T0 = new Date('2026-10-15T08:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

export function runRepositoryContract(name: string, make: () => Promise<Repository>, teardown?: () => Promise<void>) {
  describe(`Repository contract: ${name}`, () => {
    let repo: Repository;
    beforeEach(async () => {
      repo = await make();
    });
    if (teardown) afterAll(teardown);

    const user = async (patch: Partial<UserRec> = {}): Promise<UserRec> => {
      const r = await repo.createUser({
        id: newId(),
        kind: 'adult',
        email: `u${newId().slice(-12)}@example.kg`,
        emailVerifiedAt: null,
        displayName: 'Айгүл',
        locale: 'ky',
        status: 'active',
        ...patch,
      });
      if (r === 'conflict') throw new Error('conflict');
      return r;
    };
    const school = async () => {
      const s = { id: newId(), name: 'Школа', region: 'Ош', type: 'state' as const, language: 'ky' as const, status: 'active' as const, createdAt: T0 };
      await repo.createSchool(s);
      return s;
    };
    const klass = async (schoolId: string, joinCode = 'ABC234'): Promise<ClassRec> => {
      const c = await repo.createClass({ id: newId(), schoolId, name: '7А', grade: 7, joinCode, joinCodeEnabled: true, createdBy: newId(), createdAt: T0, deletedAt: null });
      if (c === 'conflict') throw new Error('conflict');
      return c;
    };
    const session = (userId: string, patch: Partial<SessionRec> = {}): SessionRec => {
      const id = newId();
      return { id, userId, refreshHash: `h-${id}`, family: id, audience: 'client', device: 'Chrome on Linux', ip: '10.0.0.1', createdAt: T0, expiresAt: at(60), revokedAt: null, replacedById: null, ...patch };
    };

    it('ping', async () => {
      expect(await repo.ping()).toBe(true);
    });

    describe('identity', () => {
      it('users: create, email conflict, lookup, update, list/paginate, getUsers order', async () => {
        const a = await user({ email: 'a@example.kg', displayName: 'Асан' });
        expect(await repo.createUser({ id: newId(), kind: 'adult', email: 'a@example.kg', emailVerifiedAt: null, displayName: 'x', locale: 'ru', status: 'active' })).toBe('conflict');
        expect((await repo.getUserByEmail('A@EXAMPLE.KG'))?.id).toBe(a.id);
        expect(await repo.getUser(newId())).toBeNull();
        const up = await repo.updateUser(a.id, { displayName: 'Асан Б', status: 'blocked' });
        expect(up).toMatchObject({ displayName: 'Асан Б', status: 'blocked' });
        expect(await repo.updateUser(newId(), { displayName: 'z' })).toBeNull();
        const b = await user({ displayName: 'Бакыт' });
        const c = await user({ displayName: 'Чынара', kind: 'student', email: null });
        const p1 = await repo.listUsers({}, { limit: 2 });
        expect(p1.items.map((u) => u.id)).toEqual([a.id, b.id]);
        expect(p1.nextCursor).not.toBeNull();
        const p2 = await repo.listUsers({}, { limit: 2, cursor: p1.nextCursor! });
        expect(p2.items.map((u) => u.id)).toEqual([c.id]);
        expect(p2.nextCursor).toBeNull();
        expect((await repo.listUsers({ q: 'бакыт' }, { limit: 10 })).items.map((u) => u.id)).toEqual([b.id]);
        expect((await repo.listUsers({ status: 'blocked' }, { limit: 10 })).items.map((u) => u.id)).toEqual([a.id]);
        expect((await repo.listUsers({ ids: [c.id, a.id] }, { limit: 10 })).items.map((u) => u.id)).toEqual([a.id, c.id]);
        expect((await repo.getUsers([c.id, newId(), a.id])).map((u) => u.id)).toEqual([c.id, a.id]);
        await repo.updateUser(b.id, { deletedAt: T0 });
        expect((await repo.listUsers({}, { limit: 10 })).items.map((u) => u.id)).toEqual([a.id, c.id]);
      });

      it('credentials: set resets counters, update, delete', async () => {
        const u = await user();
        expect(await repo.getCredential(u.id, 'password')).toBeNull();
        await repo.setCredential(u.id, 'pin', 'hash1');
        await repo.updateCredential(u.id, 'pin', { failedCount: 3, lockedUntil: at(15) });
        expect(await repo.getCredential(u.id, 'pin')).toMatchObject({ secretHash: 'hash1', failedCount: 3, lockedUntil: at(15) });
        await repo.setCredential(u.id, 'pin', 'hash2');
        expect(await repo.getCredential(u.id, 'pin')).toMatchObject({ secretHash: 'hash2', failedCount: 0, lockedUntil: null });
        await repo.deleteCredential(u.id, 'pin');
        expect(await repo.getCredential(u.id, 'pin')).toBeNull();
      });

      it('grants: add (dedupe by identity), list by user and scope, set replaces', async () => {
        const u = await user();
        await repo.addGrant({ userId: u.id, role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'translator' });
        await repo.addGrant({ userId: u.id, role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'artist' });
        await repo.addGrant({ userId: u.id, role: 'superadmin', scope: 'platform', scopeId: null, subrole: null });
        const g = await repo.listGrants(u.id);
        expect(g).toHaveLength(2);
        expect(g).toContainEqual({ userId: u.id, role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'artist' });
        expect(g).toContainEqual({ userId: u.id, role: 'superadmin', scope: 'platform', scopeId: null, subrole: null });
        expect((await repo.listGrantsByScope('subject', 'bio')).map((x) => x.userId)).toEqual([u.id]);
        await repo.setGrants(u.id, [{ role: 'teacher', scope: 'school', scopeId: 's1', subrole: null }]);
        expect(await repo.listGrants(u.id)).toEqual([{ userId: u.id, role: 'teacher', scope: 'school', scopeId: 's1', subrole: null }]);
      });

      it('sessions: lookup, atomic rotation, family/user revocation, active list', async () => {
        const u = await user();
        const s1 = session(u.id);
        await repo.createSession(s1);
        expect((await repo.getSessionByRefreshHash(s1.refreshHash))?.id).toBe(s1.id);
        const s2 = session(u.id, { family: s1.family });
        expect(await repo.rotateSession(s1.id, s2, at(1))).toBe(true);
        expect(await repo.getSession(s1.id)).toMatchObject({ revokedAt: at(1), replacedById: s2.id });
        // a second rotation of the same old token loses
        expect(await repo.rotateSession(s1.id, session(u.id, { family: s1.family }), at(2))).toBe(false);
        expect(await repo.getSessionByRefreshHash('nope')).toBeNull();
        const other = session(u.id, { expiresAt: at(-1) });
        await repo.createSession(other);
        expect((await repo.listActiveSessions(u.id, T0)).map((s) => s.id)).toEqual([s2.id]);
        expect(await repo.revokeFamily(s1.family, at(3))).toBe(1);
        expect((await repo.getSession(s2.id))?.revokedAt).toEqual(at(3));
        const s3 = session(u.id);
        await repo.createSession(s3);
        await repo.revokeSession(s3.id, at(4));
        expect((await repo.getSession(s3.id))?.revokedAt).toEqual(at(4));
        const s4 = session(u.id);
        await repo.createSession(s4);
        expect(await repo.revokeUserSessions(u.id, at(5))).toBe(2); // s4 + expired `other`
        expect(await repo.listActiveSessions(u.id, T0)).toEqual([]);
      });

      it('auth tokens are single-use and expire', async () => {
        const u = await user();
        await repo.createAuthToken({ id: newId(), userId: u.id, purpose: 'password_reset', tokenHash: 't1', expiresAt: at(30), usedAt: null });
        expect(await repo.consumeAuthToken('t1', 'email_verify', T0)).toBeNull();
        expect(await repo.consumeAuthToken('t1', 'password_reset', T0)).toMatchObject({ userId: u.id, usedAt: T0 });
        expect(await repo.consumeAuthToken('t1', 'password_reset', T0)).toBeNull();
        await repo.createAuthToken({ id: newId(), userId: u.id, purpose: 'password_reset', tokenHash: 't2', expiresAt: at(30), usedAt: null });
        expect(await repo.consumeAuthToken('t2', 'password_reset', at(31))).toBeNull();
      });

      it('invites: create, accept once, list by scope', async () => {
        const i = { id: newId(), email: 'x@example.kg', role: 'teacher' as const, scope: 'school' as const, scopeId: 's1', subrole: null, tokenHash: 'ih', invitedBy: newId(), createdAt: T0, expiresAt: at(100), acceptedAt: null };
        await repo.createInvite(i);
        await repo.createInvite({ ...i, id: newId(), tokenHash: 'ih2', scopeId: 's2' });
        expect(await repo.getInviteByHash('ih')).toEqual({ ...i, permissions: [], revokedAt: null });
        expect(await repo.getInvite(i.id)).toEqual({ ...i, permissions: [], revokedAt: null });
        expect(await repo.getInvite(newId())).toBeNull();
        expect(await repo.markInviteAccepted(i.id, at(1))).toBe(true);
        expect(await repo.markInviteAccepted(i.id, at(2))).toBe(false);
        expect((await repo.listInvites({ scope: 'school', scopeIds: ['s1'] }, { limit: 10 })).items.map((x) => x.id)).toEqual([i.id]);
        const all = await repo.listInvites({}, { limit: 1 });
        expect(all.items).toHaveLength(1);
        expect(all.nextCursor).not.toBeNull();
      });

      it('invites: revoke blocks acceptance, update re-issues the token (v0.3.0)', async () => {
        const i = { id: newId(), email: 'y@example.kg', role: 'teacher' as const, scope: 'school' as const, scopeId: 's1', subrole: null, tokenHash: 'r1', invitedBy: newId(), createdAt: T0, expiresAt: at(100), acceptedAt: null };
        await repo.createInvite(i);
        expect(await repo.updateInvite(i.id, { revokedAt: at(1) })).toMatchObject({ revokedAt: at(1) });
        expect(await repo.markInviteAccepted(i.id, at(2))).toBe(false);
        const re = await repo.updateInvite(i.id, { revokedAt: null, tokenHash: 'r2', expiresAt: at(200) });
        expect(re).toMatchObject({ revokedAt: null, tokenHash: 'r2', expiresAt: at(200) });
        expect(await repo.getInviteByHash('r1')).toBeNull();
        expect(await repo.markInviteAccepted(i.id, at(3))).toBe(true);
        expect(await repo.updateInvite(newId(), { revokedAt: T0 })).toBeNull();
      });

      it('auth tokens: find does not consume (v0.3.0)', async () => {
        const u = await user();
        await repo.createAuthToken({ id: newId(), userId: u.id, purpose: 'totp_enroll', tokenHash: 'e1', expiresAt: at(10), usedAt: null });
        expect(await repo.findAuthToken('e1', 'totp_enroll', T0)).toMatchObject({ userId: u.id, usedAt: null });
        expect(await repo.findAuthToken('e1', 'password_reset', T0)).toBeNull();
        expect(await repo.findAuthToken('e1', 'totp_enroll', at(11))).toBeNull();
        expect(await repo.consumeAuthToken('e1', 'totp_enroll', T0)).not.toBeNull();
        expect(await repo.findAuthToken('e1', 'totp_enroll', T0)).toBeNull();
      });
    });

    describe('v0.6.0 self-registration', () => {
      it('user signup details: stored, cleared; null by default', async () => {
        const plain = await user();
        expect((await repo.getUser(plain.id))?.signup ?? null).toBeNull();
        const signup = { teaching: { subjects: ['bio'], grades: [7, 8] }, schoolName: 'Мектеп', region: 'Ош' };
        const u = await user({ status: 'pending', signup });
        expect((await repo.getUser(u.id))?.signup).toEqual(signup);
        expect((await repo.updateUser(u.id, { signup: { region: 'Нарын' } }))?.signup).toEqual({ region: 'Нарын' });
        expect((await repo.updateUser(u.id, { displayName: 'Z' }))?.signup).toEqual({ region: 'Нарын' });
        expect((await repo.updateUser(u.id, { status: 'active', signup: null }))?.signup ?? null).toBeNull();
      });

      it('e-mail codes: latest, revoke, attempts burn at max', async () => {
        const u = await user();
        expect(await repo.latestAuthToken(u.id, 'email_code')).toBeNull();
        const a = newId();
        await repo.createAuthToken({ id: a, userId: u.id, purpose: 'email_code', tokenHash: 'c1', expiresAt: at(15), usedAt: null });
        const b = newId();
        await repo.createAuthToken({ id: b, userId: u.id, purpose: 'email_code', tokenHash: 'c2', expiresAt: at(16), usedAt: null });
        await repo.createAuthToken({ id: newId(), userId: u.id, purpose: 'email_verify', tokenHash: 'v1', expiresAt: at(60), usedAt: null });
        expect(await repo.latestAuthToken(u.id, 'email_code')).toMatchObject({ id: b, attempts: 0, usedAt: null });
        expect(await repo.revokeAuthTokens(u.id, 'email_code', at(1))).toBe(2);
        expect(await repo.revokeAuthTokens(u.id, 'email_code', at(1))).toBe(0);
        expect(await repo.findAuthToken('v1', 'email_verify', T0)).not.toBeNull(); // other purposes untouched
        expect(await repo.latestAuthToken(u.id, 'email_code')).toMatchObject({ id: b, usedAt: at(1) });
        expect(await repo.failAuthTokenAttempt(b, 3, at(2))).toBe(0); // used → not counted

        const c = newId();
        await repo.createAuthToken({ id: c, userId: u.id, purpose: 'email_code', tokenHash: 'c3', expiresAt: at(30), usedAt: null, attempts: 0 });
        expect(await repo.failAuthTokenAttempt(c, 3, at(2))).toBe(1);
        expect(await repo.failAuthTokenAttempt(c, 3, at(3))).toBe(2);
        expect(await repo.findAuthToken('c3', 'email_code', at(3))).toMatchObject({ attempts: 2 });
        expect(await repo.failAuthTokenAttempt(c, 3, at(4))).toBe(3);
        expect(await repo.latestAuthToken(u.id, 'email_code')).toMatchObject({ id: c, attempts: 3, usedAt: at(4) });
        expect(await repo.consumeAuthToken('c3', 'email_code', at(4))).toBeNull();
        expect(await repo.failAuthTokenAttempt(newId(), 3, at(5))).toBe(0);
      });

      it('v0.7.0 phone: unique, lookup, update, null by default', async () => {
        const plain = await user();
        expect(plain).toMatchObject({ phone: null, phoneVerifiedAt: null });
        expect(await repo.getUserByPhone('+996555123456')).toBeNull();
        const p = await user({ email: null, phone: '+996555123456', phoneVerifiedAt: T0 });
        expect(p).toMatchObject({ phone: '+996555123456', phoneVerifiedAt: T0, email: null });
        expect((await repo.getUserByPhone('+996555123456'))?.id).toBe(p.id);
        expect(await repo.createUser({ id: newId(), kind: 'adult', email: null, phone: '+996555123456', emailVerifiedAt: null, displayName: 'x', locale: 'ky', status: 'active' })).toBe('conflict');
        // several users without a number (NULLs do not collide)
        await user({ email: null });
        await user({ email: null });
        expect((await repo.updateUser(plain.id, { phone: '+996700000001', phoneVerifiedAt: at(1) }))).toMatchObject({ phone: '+996700000001', phoneVerifiedAt: at(1) });
        expect((await repo.getUserByPhone('+996700000001'))?.id).toBe(plain.id);
        await expect(repo.updateUser(plain.id, { phone: '+996555123456' })).rejects.toThrow();
        expect((await repo.updateUser(plain.id, { displayName: 'Y' }))?.phone).toBe('+996700000001');
      });

      it('v0.7.0 phone codes: latest, revoke, attempts burn at max, consume by hash and kind', async () => {
        const phone = '+996555123456';
        const row = (patch: Partial<PhoneOtpRec>): PhoneOtpRec => ({
          id: newId(), phone, purpose: 'register', kind: 'code', hash: `h-${newId()}`, locale: 'ru', attempts: 0, createdAt: T0, expiresAt: at(10), usedAt: null, ...patch,
        });
        expect(await repo.latestPhoneOtp(phone, 'register', 'code')).toBeNull();
        const a = row({ hash: 'pa' });
        const b = row({ hash: 'pb', createdAt: at(1), expiresAt: at(11) });
        await repo.createPhoneOtp(a);
        await repo.createPhoneOtp(b);
        await repo.createPhoneOtp(row({ hash: 'reset1', purpose: 'reset' }));
        await repo.createPhoneOtp(row({ hash: 'tok1', kind: 'token', expiresAt: at(15) }));
        await repo.createPhoneOtp(row({ hash: 'other', phone: '+996700000000' }));
        expect(await repo.latestPhoneOtp(phone, 'register', 'code')).toMatchObject({ id: b.id, attempts: 0, usedAt: null, locale: 'ru' });
        expect(await repo.revokePhoneOtps(phone, 'register', 'code', at(2))).toBe(2);
        expect(await repo.revokePhoneOtps(phone, 'register', 'code', at(2))).toBe(0);
        expect(await repo.latestPhoneOtp(phone, 'register', 'code')).toMatchObject({ id: b.id, usedAt: at(2) });
        expect(await repo.latestPhoneOtp(phone, 'reset', 'code')).toMatchObject({ usedAt: null }); // other purpose untouched
        expect(await repo.latestPhoneOtp('+996700000000', 'register', 'code')).toMatchObject({ usedAt: null }); // other number untouched
        expect(await repo.failPhoneOtpAttempt(b.id, 3, at(3))).toBe(0); // used → not counted

        const c = row({ hash: 'pc', createdAt: at(3), expiresAt: at(13) });
        await repo.createPhoneOtp(c);
        expect(await repo.failPhoneOtpAttempt(c.id, 3, at(4))).toBe(1);
        expect(await repo.failPhoneOtpAttempt(c.id, 3, at(4))).toBe(2);
        expect(await repo.failPhoneOtpAttempt(c.id, 3, at(5))).toBe(3);
        expect(await repo.latestPhoneOtp(phone, 'register', 'code')).toMatchObject({ id: c.id, attempts: 3, usedAt: at(5) });
        expect(await repo.consumePhoneOtp('pc', 'code', at(5))).toBeNull();
        expect(await repo.failPhoneOtpAttempt(newId(), 3, at(5))).toBe(0);

        // tokens: single use, by kind, not after expiry
        expect(await repo.findPhoneOtp('tok1', 'code', T0)).toBeNull();
        expect(await repo.findPhoneOtp('tok1', 'token', at(15))).toBeNull();
        expect(await repo.findPhoneOtp('tok1', 'token', at(14))).toMatchObject({ phone, kind: 'token', usedAt: null });
        expect(await repo.consumePhoneOtp('tok1', 'code', T0)).toBeNull();
        expect(await repo.consumePhoneOtp('tok1', 'token', at(15))).toBeNull();
        expect(await repo.consumePhoneOtp('tok1', 'token', at(14))).toMatchObject({ phone, purpose: 'register', kind: 'token', usedAt: at(14) });
        expect(await repo.consumePhoneOtp('tok1', 'token', at(14))).toBeNull();
        expect(await repo.findPhoneOtp('tok1', 'token', at(14))).toBeNull();
        expect(await repo.consumePhoneOtp('nosuch', 'token', T0)).toBeNull();
        await expect(repo.createPhoneOtp(row({ hash: 'pa' }))).rejects.toThrow(); // hashes are unique
      });

      it('school origin and class subjectKey', async () => {
        const id = newId();
        await repo.createSchool({ id, name: 'Айгүл — жеке мектеп', region: '', type: 'private', language: 'ky', status: 'active', origin: 'self', createdAt: T0 });
        expect(await repo.getSchool(id)).toMatchObject({ origin: 'self', version: 1 });
        expect((await repo.updateSchool(id, { name: 'Х' }))).toMatchObject({ origin: 'self' });
        const c = await klass(id);
        expect(c.subjectKey).toBeNull();
        expect(await repo.updateClass(c.id, { subjectKey: 'bio' })).toMatchObject({ subjectKey: 'bio' });
        expect(await repo.getClass(c.id)).toMatchObject({ subjectKey: 'bio' });
        const c2 = await repo.createClass({ id: newId(), schoolId: id, name: '8Б', grade: 8, joinCode: 'QWE234', joinCodeEnabled: true, subjectKey: 'chem', createdBy: newId(), createdAt: T0, deletedAt: null });
        expect(c2).toMatchObject({ subjectKey: 'chem' });
        expect(await repo.updateClass(c.id, { subjectKey: null })).toMatchObject({ subjectKey: null });
      });
    });

    describe('schools & classes', () => {
      it('schools and licenses', async () => {
        const s = await school();
        expect(await repo.getSchool(s.id)).toEqual({ ...s, origin: 'admin', version: 1 });
        expect(await repo.updateSchool(s.id, { name: 'Лицей' })).toMatchObject({ name: 'Лицей', id: s.id, version: 2 });
        expect(await repo.updateSchool(s.id, { name: 'x' }, 1)).toBe('version_mismatch');
        expect(await repo.updateSchool(s.id, { region: 'Бишкек' }, 2)).toMatchObject({ region: 'Бишкек', name: 'Лицей', version: 3 });
        expect(await repo.updateSchool(newId(), { name: 'x' })).toBeNull();
        const s2 = await school();
        expect((await repo.listSchools({ ids: [s2.id] }, { limit: 10 })).items.map((x) => x.id)).toEqual([s2.id]);
        const l = { id: newId(), schoolId: s.id, subjects: ['bio', 'chem'], grades: [7, 8], seats: 30, startsAt: T0, endsAt: at(1000) };
        expect(await repo.createLicense(l)).toEqual({ ...l, version: 1 });
        expect(await repo.createLicense(l)).toBe('conflict');
        expect(await repo.updateLicense(l.id, { seats: 40 })).toMatchObject({ seats: 40, schoolId: s.id, version: 2 });
        expect(await repo.updateLicense(l.id, { seats: 50 }, 1)).toBe('version_mismatch');
        expect(await repo.updateLicense(newId(), { seats: 50 }, 1)).toBeNull();
        expect(await repo.deleteLicense(l.id, 1)).toBe('version_mismatch');
        expect(await repo.deleteLicense(newId(), 1)).toBe(false);
        expect((await repo.listLicenses({ schoolIds: [s.id] }, { limit: 10 })).items).toHaveLength(1);
        expect((await repo.listLicenses({ schoolIds: [s2.id] }, { limit: 10 })).items).toHaveLength(0);
        expect(await repo.deleteLicense(l.id)).toBe(true);
        expect(await repo.deleteLicense(l.id)).toBe(false);
        expect(await repo.getLicense(l.id)).toBeNull();
      });

      it('classes: join code unique, update, soft delete hides, list filters', async () => {
        const s = await school();
        const c = await klass(s.id, 'ABC234');
        expect(await repo.createClass({ ...c, id: newId() })).toBe('conflict');
        const c2 = await klass(s.id, 'XYZ789');
        expect((await repo.getClassByJoinCode('ABC234'))?.id).toBe(c.id);
        expect(await repo.updateClass(c2.id, { joinCode: 'ABC234' })).toBe('conflict');
        expect(await repo.updateClass(c2.id, { name: '7Б', joinCodeEnabled: false })).toMatchObject({ name: '7Б', joinCodeEnabled: false });
        expect(await repo.updateClass(newId(), { name: 'x' })).toBeNull();
        expect((await repo.listClasses({ schoolIds: [s.id] }, { limit: 10 })).items.map((x) => x.id)).toEqual([c.id, c2.id]);
        expect((await repo.listClasses({ ids: [c2.id] }, { limit: 10 })).items.map((x) => x.id)).toEqual([c2.id]);
        await repo.updateClass(c.id, { deletedAt: T0 });
        expect(await repo.getClass(c.id)).toBeNull();
        expect(await repo.getClassByJoinCode('ABC234')).toBeNull();
        expect((await repo.listClasses({}, { limit: 10 })).items.map((x) => x.id)).toEqual([c2.id]);
      });

      it('enrollments and consent', async () => {
        const s = await school();
        const c = await klass(s.id);
        const t = await user();
        const st = await user({ kind: 'student', email: null });
        await repo.addEnrollment({ classId: c.id, userId: t.id, role: 'teacher' });
        await repo.addEnrollment({ classId: c.id, userId: st.id, role: 'student' });
        await repo.addEnrollment({ classId: c.id, userId: st.id, role: 'student' }); // idempotent
        expect(await repo.listEnrollments({ classId: c.id })).toHaveLength(2);
        expect((await repo.listEnrollments({ classIds: [c.id], role: 'student' })).map((e) => e.userId)).toEqual([st.id]);
        expect((await repo.listEnrollments({ userId: t.id })).map((e) => e.role)).toEqual(['teacher']);
        await repo.removeEnrollment(c.id, t.id);
        expect(await repo.listEnrollments({ classId: c.id })).toHaveLength(1);
        await repo.setConsent({ studentId: st.id, schoolId: s.id, confirmedBy: t.id, confirmedAt: T0 });
        expect(await repo.listConsents([st.id, t.id])).toEqual([{ studentId: st.id, schoolId: s.id, confirmedBy: t.id, confirmedAt: T0 }]);
        await repo.setConsent({ studentId: st.id, remove: true });
        expect(await repo.listConsents([st.id])).toEqual([]);
      });

      it('purgeDeleted erases soft-deleted users and classes older than the cutoff', async () => {
        const s = await school();
        const c = await klass(s.id);
        const old = await user({ kind: 'student', email: null });
        const recent = await user({ kind: 'student', email: null });
        await repo.setCredential(old.id, 'pin', 'h');
        await repo.addEnrollment({ classId: c.id, userId: old.id, role: 'student' });
        await repo.addGrant({ userId: old.id, role: 'student', scope: 'class', scopeId: c.id, subrole: null });
        await repo.updateUser(old.id, { deletedAt: at(-60 * 24 * 31) });
        await repo.updateUser(recent.id, { deletedAt: at(-60) });
        await repo.updateClass(c.id, { deletedAt: at(-60 * 24 * 31) });
        expect(await repo.purgeDeleted(at(-60 * 24 * 30))).toEqual({ users: 1, classes: 1 });
        expect(await repo.getUser(old.id)).toBeNull();
        expect(await repo.getCredential(old.id, 'pin')).toBeNull();
        expect(await repo.listGrants(old.id)).toEqual([]);
        expect(await repo.getUser(recent.id)).not.toBeNull();
      });
    });

    describe('content', () => {
      const subject = animalCellPackage.subject;
      const w = <T>(data: T, searchText = '') => ({ data, subjectKey: 'bio', searchText });

      it('stores: create/conflict, get/getMany order, optimistic update/delete, list q/subject/paginate', async () => {
        const store = repo.content('subject');
        const r = await store.create('bio', w(subject, 'биология biology'), null);
        expect(r).toMatchObject({ key: 'bio', version: 1, subjectKey: 'bio', data: subject });
        expect(await store.create('bio', w(subject), null)).toBe('conflict');
        const chem = { ...subject, key: 'chem' };
        await store.create('chem', { data: chem, subjectKey: 'chem', searchText: 'химия' }, null);
        await store.create('math', { data: { ...subject, key: 'math' }, subjectKey: 'math', searchText: 'математика' }, null);
        expect((await store.getMany(['math', 'nope', 'bio'])).map((x) => x.key)).toEqual(['math', 'bio']);
        const actor = newId();
        const up = await store.update('bio', w({ ...subject, hue: 10 }), 1, actor);
        expect(up).toMatchObject({ version: 2, updatedBy: actor, data: { hue: 10 } });
        expect(await store.update('bio', w(subject), 1, actor)).toBe('version_mismatch');
        expect(await store.update('nope', w(subject), 1, actor)).toBe('not_found');
        expect(await store.update('bio', w(subject), null, null)).toMatchObject({ version: 3 });
        expect((await store.list({ q: 'хими' }, { limit: 10 })).items.map((x) => x.key)).toEqual(['chem']);
        expect((await store.list({ q: 'mat' }, { limit: 10 })).items.map((x) => x.key)).toEqual(['math']);
        expect((await store.list({ subjectKey: 'bio' }, { limit: 10 })).items.map((x) => x.key)).toEqual(['bio']);
        const p1 = await store.list({}, { limit: 2 });
        const p2 = await store.list({}, { limit: 2, cursor: p1.nextCursor! });
        expect([...p1.items, ...p2.items].map((x) => x.key)).toEqual(['bio', 'chem', 'math']);
        expect(p2.nextCursor).toBeNull();
        expect(await store.count()).toBe(3);
        expect((await store.getById((r as { id: string }).id))?.key).toBe('bio');
        expect(await store.getById(newId())).toBeNull();
        expect(await store.delete('chem', 7)).toBe('version_mismatch');
        expect(await store.delete('chem', 1)).toBe('ok');
        expect(await store.delete('chem', null)).toBe('not_found');
        expect(await store.get('chem')).toBeNull();
        // kinds are isolated
        expect(await repo.content('concept').get('bio')).toBeNull();
        for (const c of animalCellPackage.concepts) await repo.content('concept').create(c.key, w(c), null);
        for (const i of animalCellPackage.items) await repo.content('item').create(i.key, w(i), null);
        expect(await repo.content('concept').count()).toBe(animalCellPackage.concepts.length);
        expect((await repo.content('item').get(animalCellPackage.items[0].key))?.data).toEqual(animalCellPackage.items[0]);
      });

      it('textbook store (v0.5.0): shared rows, doc round-trip, optimistic update/delete', async () => {
        const L = (s: string) => ({ ky: s, ru: s, en: s });
        const tb = {
          key: 'nat-8-1',
          title: L('Табигый илимдер'),
          grade: 8,
          lang: 'ky' as const,
          order: 1,
          chapters: [
            {
              key: 'ch1',
              number: '1',
              title: L('Тамактануу'),
              subjectKey: 'bio',
              pages: { from: 8, to: 29 },
              lessons: [{ key: 'ch1.l1', number: '1.1', kind: 'lesson' as const, title: L('Азык'), topicKeys: ['animal-cell'] }],
            },
          ],
        };
        const store = repo.content('textbook');
        const r = await store.create(tb.key, { data: tb, subjectKey: null, searchText: 'табигый' }, null);
        expect(r).toMatchObject({ key: 'nat-8-1', version: 1, subjectKey: null, data: tb });
        expect(await store.create(tb.key, { data: tb, subjectKey: null, searchText: '' }, null)).toBe('conflict');
        expect((await store.list({ q: 'табиг' }, { limit: 10 })).items.map((x) => x.key)).toEqual(['nat-8-1']);
        const up = await store.update(tb.key, { data: { ...tb, grade: 9, order: 2 }, subjectKey: null, searchText: '' }, 1, null);
        expect(up).toMatchObject({ version: 2, data: { grade: 9, order: 2 } });
        expect(await store.update(tb.key, { data: tb, subjectKey: null, searchText: '' }, 1, null)).toBe('version_mismatch');
        expect(await store.delete(tb.key, 1)).toBe('version_mismatch');
        expect(await store.delete(tb.key, 2)).toBe('ok');
        expect(await store.count()).toBe(0);
      });

      const topicRow = async (key = 'animal-cell') => {
        const t = await repo.createTopic({ id: newId(), key, unitKey: 'bio.g7.cells', subjectKey: 'bio', status: 'draft', demo: false, publishedVersionId: null, latestVersionId: null, scheduledAt: null, scheduledVersionId: null });
        if (t === 'conflict') throw new Error('conflict');
        return t;
      };
      const versionRow = (topicId: string, version: string, topicKey = 'animal-cell'): TopicVersionRec => ({
        id: newId(),
        topicId,
        topicKey,
        version,
        doc: { ...animalCellPackage.topic, key: topicKey },
        authorId: newId(),
        createdAt: T0,
        reviewState: 'draft',
        message: null,
      });
      const buildRow = (v: TopicVersionRec, status: BuildRec['status'], pkg: ContentPackage | null = animalCellPackage): BuildRec => ({
        id: newId(),
        topicId: v.topicId,
        topicKey: v.topicKey,
        topicVersionId: v.id,
        version: v.version,
        status,
        manifest: pkg?.manifest ?? null,
        pkg,
        packageUrl: pkg ? `/p/${pkg.manifest.hash}` : null,
        hash: pkg?.manifest.hash ?? null,
        log: ['x'],
        createdAt: T0,
      });

      it('topics: conflict, optimistic update, filters, soft delete', async () => {
        const t = await topicRow();
        expect(t.version).toBe(1);
        expect(t.updatedBy).toBeNull();
        expect(await repo.createTopic({ ...t })).toBe('conflict');
        const by = newId();
        expect(await repo.updateTopic(t.id, { updatedBy: by }, null)).toMatchObject({ updatedBy: by });
        await repo.updateTopic(t.id, {}, null);
        const up = await repo.updateTopic(t.id, { status: 'review', scheduledAt: at(10) }, 3);
        expect(up).toMatchObject({ status: 'review', version: 4, scheduledAt: at(10), updatedBy: by });
        expect(await repo.updateTopic(t.id, { status: 'draft' }, 1)).toBe('version_mismatch');
        expect(await repo.updateTopic(newId(), { status: 'draft' }, null)).toBe('not_found');
        const t2 = await topicRow('plant-cell');
        expect((await repo.listTopics({ status: 'review' }, { limit: 10 })).items.map((x) => x.key)).toEqual(['animal-cell']);
        expect((await repo.listTopics({ scheduledBefore: at(10) }, { limit: 10 })).items.map((x) => x.key)).toEqual(['animal-cell']);
        expect((await repo.listTopics({ scheduledBefore: at(9) }, { limit: 10 })).items).toEqual([]);
        expect((await repo.listTopics({ q: 'plant' }, { limit: 10 })).items.map((x) => x.key)).toEqual(['plant-cell']);
        const p1 = await repo.listTopics({}, { limit: 1 });
        expect((await repo.listTopics({}, { limit: 1, cursor: p1.nextCursor! })).items.map((x) => x.key)).toEqual(['plant-cell']);
        expect((await repo.getTopicByKey('plant-cell'))?.id).toBe(t2.id);
        await repo.updateTopic(t2.id, { deletedAt: T0 }, null);
        expect(await repo.getTopic(t2.id)).toBeNull();
        expect(await repo.getTopicByKey('plant-cell')).toBeNull();
        expect(await repo.updateTopic(t2.id, { status: 'draft' }, null)).toBe('not_found');
      });

      it('versions, builds, listPublished, topicsUsingConcept', async () => {
        const t = await topicRow();
        const v1 = versionRow(t.id, '1.0.0');
        expect(await repo.createTopicVersion(v1)).toEqual(v1);
        expect(await repo.createTopicVersion({ ...v1, id: newId() })).toBe('conflict');
        const v2 = versionRow(t.id, '1.0.1');
        await repo.createTopicVersion(v2);
        expect((await repo.getTopicVersionBySemver(t.id, '1.0.1'))?.id).toBe(v2.id);
        expect((await repo.listTopicVersions(t.id)).map((v) => v.version)).toEqual(['1.0.0', '1.0.1']);
        expect(await repo.updateTopicVersion(v2.id, { reviewState: 'review' })).toMatchObject({ reviewState: 'review', version: '1.0.1' });
        expect(await repo.updateTopicVersion(newId(), { reviewState: 'review' })).toBeNull();

        const failed = buildRow(v1, 'failed', null);
        await repo.createBuild(failed);
        expect(await repo.readyBuildForVersion(v1.id)).toBeNull();
        const b1 = buildRow(v1, 'ready');
        await repo.createBuild(b1);
        const b1b = buildRow(v1, 'ready');
        await repo.createBuild(b1b);
        expect((await repo.readyBuildForVersion(v1.id))?.id).toBe(b1b.id);
        expect(await repo.getBuild(b1.id)).toEqual(b1);
        expect(await repo.updateBuild(failed.id, { log: ['a', 'b'] })).toMatchObject({ log: ['a', 'b'], pkg: null });
        expect((await repo.listBuilds({ topicKey: 'animal-cell' }, { limit: 10 })).items.map((b) => b.id)).toEqual([failed.id, b1.id, b1b.id]);
        expect((await repo.listBuilds({ topicKey: 'other' }, { limit: 10 })).items).toEqual([]);
        expect((await repo.listBuilds({ status: 'failed' }, { limit: 10 })).items.map((b) => b.id)).toEqual([failed.id]);
        const d1 = await repo.listBuilds({}, { limit: 2 }, 'desc');
        const d2 = await repo.listBuilds({}, { limit: 2, cursor: d1.nextCursor! }, 'desc');
        expect([...d1.items, ...d2.items].map((b) => b.id)).toEqual([b1b.id, b1.id, failed.id]);
        expect(d2.nextCursor).toBeNull();

        expect(await repo.listPublished()).toEqual([]);
        await repo.updateTopic(t.id, { publishedVersionId: v1.id, status: 'published' }, null);
        const pub = await repo.listPublished();
        expect(pub).toHaveLength(1);
        expect(pub[0].topic.key).toBe('animal-cell');
        expect(pub[0].build.id).toBe(b1b.id);
        expect(pub[0].build.pkg).toEqual(animalCellPackage);

        const doc = animalCellPackage.topic;
        expect(await repo.topicsUsingConcept(doc.conceptKeys[0])).toEqual(['animal-cell']);
        expect(await repo.topicsUsingConcept('no.such.concept')).toEqual([]);
        const focus = doc.activities.tour?.steps.find((s) => s.focus)?.focus;
        if (focus) expect(await repo.topicsUsingConcept(focus)).toEqual(['animal-cell']);
      });

      it('assets', async () => {
        const a = { id: newId(), key: 'cell-glb', kind: 'glb' as const, filename: 'cell.glb', contentType: 'model/gltf-binary', license: 'CC-BY', author: 'A', source: 'S', status: 'uploaded' as const, sizeBytes: 100, sizeAfter: null, triangles: null, nodes: [], violations: [], originalUrl: null, optimizedUrl: null, thumbUrl: null, uploadId: 'u1', createdBy: newId(), createdAt: T0 };
        await repo.createAsset(a);
        expect(await repo.getAsset(a.id)).toEqual({ ...a, version: 1 });
        expect(await repo.updateAsset(a.id, { status: 'ready', nodes: ['Nucleus', 'Mito_1'], triangles: 1200 })).toMatchObject({ status: 'ready', nodes: ['Nucleus', 'Mito_1'], triangles: 1200 });
        expect(await repo.updateAsset(newId(), { status: 'ready' })).toBeNull();
        expect((await repo.listAssets({ limit: 10 })).items).toHaveLength(1);
        // v0.3.0: versions
        const v = { assetId: a.id, version: 1, filename: 'cell.glb', contentType: 'model/gltf-binary', status: 'uploaded' as const, sizeBytes: 100, sizeAfter: null, triangles: null, nodes: [], violations: [], originalUrl: null, optimizedUrl: null, thumbUrl: null, uploadId: 'u1', message: null, createdBy: a.createdBy, createdAt: T0, completedAt: null };
        expect(await repo.createAssetVersion(v)).toEqual(v);
        expect(await repo.createAssetVersion(v)).toBe('conflict');
        await repo.createAssetVersion({ ...v, version: 2, filename: 'cell2.glb', message: 'retopo' });
        expect((await repo.listAssetVersions(a.id)).map((x) => x.version)).toEqual([1, 2]);
        expect(await repo.updateAssetVersion(a.id, 2, { completedAt: at(5), nodes: ['A'] })).toMatchObject({ completedAt: at(5), nodes: ['A'], filename: 'cell2.glb' });
        expect(await repo.updateAssetVersion(a.id, 9, { completedAt: at(5) })).toBeNull();
        expect(await repo.updateAsset(a.id, { version: 2 })).toMatchObject({ version: 2 });
        expect(await repo.deleteAsset(a.id)).toBe(true);
        expect(await repo.deleteAsset(a.id)).toBe(false);
        expect(await repo.getAsset(a.id)).toBeNull();
        expect(await repo.listAssetVersions(a.id)).toEqual([]);
      });

      it('review comments: create, get, filters, resolve (v0.3.0)', async () => {
        const target = newId();
        const author = newId();
        await repo.createReviewComment({ id: newId(), targetType: 'topic', targetId: target, path: '', body: 'legacy', authorId: author, createdAt: T0, resolvedAt: null });
        const c = { id: newId(), targetType: 'topic' as const, targetId: target, path: 'title', body: 'fix', authorId: author, createdAt: T0, resolvedAt: null, anchor3d: [1, 2, 3] as [number, number, number], resolvedBy: null, topicVersion: '1.0.0' };
        await repo.createReviewComment(c);
        await repo.createReviewComment({ ...c, id: newId(), targetType: 'concept', targetId: newId() });
        expect(await repo.getReviewComment(c.id)).toEqual(c);
        expect(await repo.getReviewComment(newId())).toBeNull();
        const list = await repo.listReviewComments({ targetType: 'topic', targetId: target }, { limit: 10 });
        expect(list.items.map((x) => x.body)).toEqual(['legacy', 'fix']);
        expect(list.items[0]).toMatchObject({ anchor3d: null, resolvedBy: null, topicVersion: null });
        const r = newId();
        expect(await repo.updateReviewComment(c.id, { resolvedAt: at(1), resolvedBy: r })).toMatchObject({ resolvedAt: at(1), resolvedBy: r, body: 'fix' });
        expect((await repo.listReviewComments({ resolved: true }, { limit: 10 })).items.map((x) => x.id)).toEqual([c.id]);
        expect((await repo.listReviewComments({ resolved: false }, { limit: 10 })).items).toHaveLength(2);
        expect((await repo.listReviewComments({ authorId: newId() }, { limit: 10 })).items).toHaveLength(0);
        const p1 = await repo.listReviewComments({}, { limit: 2 });
        const p2 = await repo.listReviewComments({}, { limit: 2, cursor: p1.nextCursor! });
        expect(p1.items.length + p2.items.length).toBe(3);
        expect(await repo.updateReviewComment(newId(), { body: 'x' })).toBeNull();
      });

      it('locale strings: upsert, filters, getStrings, paginate', async () => {
        const row = (key: string, locale: 'ky' | 'ru' | 'en', status: 'machine' | 'draft' | 'reviewed' = 'draft') => ({ key, locale, value: `${key}:${locale}`, status, sourceHash: 'abc', updatedAt: T0 });
        await repo.upsertStrings([row('concept/bio.a/title', 'ky'), row('concept/bio.a/title', 'ru', 'reviewed'), row('topic/x/title', 'ky')]);
        await repo.upsertStrings([{ ...row('concept/bio.a/title', 'ky'), value: 'new', status: 'reviewed' }]);
        expect((await repo.getStrings(['concept/bio.a/title'])).find((s) => s.locale === 'ky')).toMatchObject({ value: 'new', status: 'reviewed', version: 2 });
        expect((await repo.getStrings(['concept/bio.a/title'])).find((s) => s.locale === 'ru')).toMatchObject({ version: 1 });
        expect((await repo.listStrings({ locale: 'ky' }, { limit: 10 })).items.map((s) => s.key)).toEqual(['concept/bio.a/title', 'topic/x/title']);
        expect((await repo.listStrings({ status: 'draft' }, { limit: 10 })).items.map((s) => s.key)).toEqual(['topic/x/title']);
        expect((await repo.listStrings({ keyPrefix: 'topic/' }, { limit: 10 })).items).toHaveLength(1);
        const p1 = await repo.listStrings({}, { limit: 2 });
        const p2 = await repo.listStrings({}, { limit: 2, cursor: p1.nextCursor! });
        expect([...p1.items, ...p2.items].map((s) => `${s.key}|${s.locale}`)).toEqual(['concept/bio.a/title|ky', 'concept/bio.a/title|ru', 'topic/x/title|ky']);
        expect(p2.nextCursor).toBeNull();
        await repo.createReviewComment({ id: newId(), targetType: 'topic', targetId: newId(), path: '', body: 'fix', authorId: newId(), createdAt: T0, resolvedAt: null });
      });
    });

    describe('learning', () => {
      it('progress upsert', async () => {
        const u = newId();
        expect(await repo.getProgress(u, 't')).toBeNull();
        await repo.putProgress({ userId: u, topicKey: 't', visitedConcepts: ['a'], completedActivities: [], updatedAt: T0 });
        await repo.putProgress({ userId: u, topicKey: 't', visitedConcepts: ['a', 'b'], completedActivities: ['tour'], updatedAt: at(1) });
        expect(await repo.getProgress(u, 't')).toEqual({ userId: u, topicKey: 't', visitedConcepts: ['a', 'b'], completedActivities: ['tour'], updatedAt: at(1) });
      });

      it('assignments, attempts (clientId conflict), answers (conflict), filters', async () => {
        const classId = newId();
        const a = { id: newId(), classId, topicKey: 't', activities: ['quiz'], dueAt: at(100), createdBy: newId(), createdAt: T0 };
        await repo.createAssignment(a);
        expect(await repo.getAssignment(a.id)).toEqual(a);
        expect((await repo.listAssignments({ classIds: [classId] }, { limit: 10 })).items).toEqual([a]);
        expect((await repo.listAssignments({ classIds: [newId()] }, { limit: 10 })).items).toEqual([]);
        const uid = newId();
        const att = { id: newId(), userId: uid, clientId: newId(), assignmentId: a.id, topicKey: 't', topicVersion: '1.0.0', topicVersionId: newId(), seed: 's', itemKeys: ['i1', 'i2'], startedAt: T0, finishedAt: null, score: null, source: 'online' as const };
        expect(await repo.createAttempt(att)).toEqual(att);
        expect(await repo.createAttempt({ ...att, id: newId() })).toBe('conflict');
        expect((await repo.getAttemptByClientId(uid, att.clientId))?.id).toBe(att.id);
        expect(await repo.updateAttempt(att.id, { finishedAt: at(5), score: 0.5 })).toMatchObject({ finishedAt: at(5), score: 0.5 });
        expect(await repo.updateAttempt(newId(), { score: 1 })).toBeNull();
        const att2 = { ...att, id: newId(), clientId: newId(), userId: newId(), assignmentId: null, startedAt: at(60) };
        await repo.createAttempt(att2);
        expect((await repo.listAttempts({ assignmentId: a.id })).map((x) => x.id)).toEqual([att.id]);
        expect((await repo.listAttempts({ userIds: [att2.userId] })).map((x) => x.id)).toEqual([att2.id]);
        expect((await repo.listAttempts({ from: at(30), to: at(90) })).map((x) => x.id)).toEqual([att2.id]);
        expect((await repo.listAttempts({ userId: uid })).map((x) => x.id)).toEqual([att.id]);
        const ans = { id: newId(), attemptId: att.id, itemKey: 'i1', response: { type: 'single' as const, value: 'b' }, correct: true, score: 1, timeMs: 1000, answeredAt: T0 };
        expect(await repo.createAnswer(ans)).toEqual(ans);
        expect(await repo.createAnswer({ ...ans, id: newId() })).toBe('conflict');
        await repo.createAnswer({ ...ans, id: newId(), itemKey: 'i2', correct: false, score: 0 });
        expect((await repo.listAnswers({ attemptIds: [att.id] })).map((x) => x.itemKey)).toEqual(['i1', 'i2']);
        expect((await repo.listAnswers({ itemKey: 'i2' })).map((x) => x.correct)).toEqual([false]);
      });

      it('events dedupe by id (also within one batch) and filter by ts', async () => {
        const ev = (id: string, ts: Date) => ({ id, actor: 'p1', verb: 'selected', objectType: 'concept', objectKey: 'bio.nucleus', topicKey: 'animal-cell', result: null, context: { a: 1 }, ts, receivedAt: T0 });
        const e1 = newId();
        const e2 = newId();
        expect(await repo.insertEvents([ev(e1, T0), ev(e2, at(10)), ev(e1, T0)])).toEqual({ accepted: 2, duplicates: 1 });
        expect(await repo.insertEvents([ev(e1, T0)])).toEqual({ accepted: 0, duplicates: 1 });
        expect(await repo.insertEvents([])).toEqual({ accepted: 0, duplicates: 0 });
        expect((await repo.listEvents({ from: at(5) })).map((e) => e.id)).toEqual([e2]);
        expect((await repo.listEvents({})).find((e) => e.id === e1)).toMatchObject({ context: { a: 1 }, result: null });
      });

      it('idempotency records', async () => {
        const u = newId();
        const r = { userId: u, key: newId(), requestHash: 'h', response: { ok: true }, createdAt: T0 };
        expect(await repo.getIdempotency(u, r.key)).toBeNull();
        expect(await repo.putIdempotency(r)).toBe(true);
        expect(await repo.putIdempotency({ ...r, requestHash: 'other' })).toBe(false);
        expect(await repo.getIdempotency(u, r.key)).toEqual(r);
      });
    });

    describe('decks, tutor, audit, settings', () => {
      it('presentations: optimistic update, list per owner, delete; snapshots', async () => {
        const owner = newId();
        const p = { id: newId(), ownerId: owner, topicKey: 't', title: 'Клетка', lang: 'ky' as const, slides: [{ id: 's1', kind: 'title', title: 'Клетка' }], version: 1, createdAt: T0, updatedAt: T0 };
        await repo.createPresentation(p);
        expect(await repo.getPresentation(p.id)).toEqual(p);
        expect(await repo.updatePresentation(p.id, { title: 'Жаңы' }, 1)).toMatchObject({ title: 'Жаңы', version: 2, slides: p.slides });
        expect(await repo.updatePresentation(p.id, { title: 'x' }, 1)).toBe('version_mismatch');
        expect(await repo.updatePresentation(newId(), { title: 'x' }, 1)).toBe('not_found');
        await repo.createPresentation({ ...p, id: newId(), ownerId: newId() });
        expect((await repo.listPresentations(owner, { limit: 10 })).items.map((x) => x.id)).toEqual([p.id]);
        expect(await repo.deletePresentation(p.id)).toBe(true);
        expect(await repo.deletePresentation(p.id)).toBe(false);
        const s = { id: newId(), ownerId: owner, topicKey: 't', topicVersion: '1.0.0', imageKey: 'snapshots/x.webp', imageUrl: '/files/snapshots/x.webp', sceneState: { lang: 'ky', subjectKey: 'bio', topicKey: 't' }, createdAt: T0 };
        await repo.createSnapshot(s);
        const s2 = { ...s, id: newId() };
        await repo.createSnapshot(s2);
        expect(await repo.getSnapshot(s.id)).toEqual(s);
        expect((await repo.getSnapshots([s2.id, newId(), s.id])).map((x) => x.id)).toEqual([s2.id, s.id]);
      });

      it('teaching plans (КТП): JSON doc round-trip, optimistic update and delete, list per owner', async () => {
        const owner = newId();
        const doc = { subjectName: 'алгебра', classes: ['8б', '8в'], rows: [{ index: 1, number: 1, title: 'Сандар', dates: { '8б': '2026-09-15', '8в': null } }], issues: [] };
        const p = { id: newId(), ownerId: owner, title: 'КТП 8', doc, version: 1, createdAt: T0, updatedAt: T0 };
        await repo.createTeachingPlan(p);
        expect(await repo.getTeachingPlan(p.id)).toEqual(p);
        expect(await repo.getTeachingPlan(newId())).toBeNull();
        const doc2 = { ...doc, subjectName: 'геометрия' };
        expect(await repo.updateTeachingPlan(p.id, { doc: doc2, title: 'Жаңы' }, 1)).toMatchObject({ title: 'Жаңы', version: 2, doc: doc2, ownerId: owner });
        expect(await repo.updateTeachingPlan(p.id, { title: 'x' }, 1)).toBe('version_mismatch');
        expect(await repo.updateTeachingPlan(newId(), { title: 'x' }, 1)).toBe('not_found');
        const other = { ...p, id: newId(), ownerId: newId() };
        await repo.createTeachingPlan(other);
        const mine2 = { ...p, id: newId() };
        await repo.createTeachingPlan(mine2);
        const page1 = await repo.listTeachingPlans(owner, { limit: 1 });
        expect(page1.items).toHaveLength(1);
        const page2 = await repo.listTeachingPlans(owner, { limit: 10, cursor: page1.nextCursor ?? undefined });
        expect([...page1.items, ...page2.items].map((x) => x.id).sort()).toEqual([p.id, mine2.id].sort());
        expect(await repo.deleteTeachingPlan(p.id, 1)).toBe('version_mismatch');
        expect(await repo.deleteTeachingPlan(p.id, 2)).toBe('ok');
        expect(await repo.deleteTeachingPlan(p.id, 2)).toBe('not_found');
        expect(await repo.getTeachingPlan(other.id)).toEqual(other);
      });

      it('tutor threads and messages (limit keeps the latest)', async () => {
        const th = { id: newId(), userId: null, topicKey: 't', createdAt: T0 };
        await repo.createThread(th);
        expect(await repo.getThread(th.id)).toEqual(th);
        const msg = (role: 'user' | 'assistant', text: string, createdAt: Date) => ({ id: newId(), threadId: th.id, role, text, citations: role === 'assistant' ? ['bio.nucleus'] : [], inputTokens: 10, outputTokens: 5, flagged: false, topicKey: 't', schoolId: null, createdAt });
        for (const [i, m] of [msg('user', 'q1', T0), msg('assistant', 'a1', at(1)), msg('user', 'q2', at(2))].entries()) {
          void i;
          await repo.addTutorMessage(m);
        }
        expect((await repo.listTutorMessages({ threadId: th.id })).map((m) => m.text)).toEqual(['q1', 'a1', 'q2']);
        expect((await repo.listTutorMessages({ threadId: th.id, limit: 2 })).map((m) => m.text)).toEqual(['a1', 'q2']);
        expect((await repo.listTutorMessages({ from: at(1), to: at(2) })).map((m) => m.text)).toEqual(['a1']);
        expect((await repo.listTutorMessages({ threadId: th.id }))[1].citations).toEqual(['bio.nucleus']);
      });

      it('generated content: pool filters, review patch, atomic counters (v0.4.0)', async () => {
        const g = (patch: Partial<GeneratedRec> = {}): GeneratedRec => ({
          id: newId(), kind: 'quiz', topicKey: 'methane', conceptKey: 'chem.bond', lang: 'ru',
          payload: { prompt: 'p', options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], answer: 'a', explanation: 'e' },
          signature: 'p', status: 'new', good: 0, bad: 0, reasons: {}, served: 0, createdAt: T0, reviewedAt: null, reviewedBy: null, promotedTo: null, ...patch,
        });
        const a = g();
        const b = g({ conceptKey: null, kind: 'simple', payload: { title: 't', text: 'x' } });
        const c = g({ lang: 'ky' });
        await repo.addGenerated([a, b, c]);
        await repo.addGenerated([]);
        expect(await repo.getGenerated(a.id)).toEqual(a);
        expect(await repo.getGenerated(newId())).toBeNull();
        expect((await repo.listGenerated({ topicKey: 'methane', conceptKey: 'chem.bond', kind: 'quiz', lang: 'ru' }, { limit: 10 })).items.map((x) => x.id)).toEqual([a.id]);
        expect((await repo.listGenerated({ conceptKey: null }, { limit: 10 })).items.map((x) => x.id)).toEqual([b.id]);
        const p1 = await repo.listGenerated({}, { limit: 2 });
        expect(p1.items).toHaveLength(2);
        expect((await repo.listGenerated({}, { limit: 2, cursor: p1.nextCursor! })).items).toHaveLength(1);

        const reviewer = newId();
        const up = await repo.updateGenerated(a.id, { status: 'promoted', reviewedAt: at(5), reviewedBy: reviewer, promotedTo: 'item:chem.q1' });
        expect(up).toMatchObject({ status: 'promoted', reviewedBy: reviewer, promotedTo: 'item:chem.q1' });
        expect(await repo.updateGenerated(newId(), { status: 'dismissed' })).toBeNull();
        expect((await repo.listGenerated({ status: 'promoted' }, { limit: 10 })).items.map((x) => x.id)).toEqual([a.id]);

        await repo.countGenerated([a.id, b.id], { served: 1 });
        await Promise.all([repo.countGenerated([a.id], { bad: 1, reason: 'wrong' }), repo.countGenerated([a.id], { bad: 1, reason: 'wrong' }), repo.countGenerated([a.id], { good: 1 })]);
        await repo.countGenerated([a.id], { bad: 1, reason: 'unclear' });
        expect(await repo.getGenerated(a.id)).toMatchObject({ served: 1, good: 1, bad: 3, reasons: { wrong: 2, unclear: 1 } });
        expect(await repo.getGenerated(b.id)).toMatchObject({ served: 1, bad: 0, reasons: {} });
      });

      it('generated content seen by a user: first time kept, filters, order (v0.9.1)', async () => {
        const g = (patch: Partial<GeneratedRec> = {}): GeneratedRec => ({
          id: newId(), kind: 'simple', topicKey: 'speed', conceptKey: null, lang: 'ky', payload: { title: 't', text: 'x' },
          signature: newId(), status: 'new', good: 0, bad: 0, reasons: {}, served: 0, createdAt: T0, reviewedAt: null, reviewedBy: null, promotedTo: null, ...patch,
        });
        const [a, b, c] = [g(), g(), g({ lang: 'ru' })];
        await repo.addGenerated([a, b, c]);
        const me = newId();
        const other = newId();
        await repo.markGeneratedSeen(me, [b.id], at(1));
        await repo.markGeneratedSeen(me, [a.id, b.id, c.id], at(2));
        await repo.markGeneratedSeen(me, [], at(3));
        await repo.markGeneratedSeen(other, [a.id], at(1));
        expect((await repo.listSeenGenerated(me, { topicKey: 'speed', conceptKey: null, kind: 'simple', lang: 'ky' }, 10)).map((x) => x.id)).toEqual([b.id, a.id]);
        expect((await repo.listSeenGenerated(me, { lang: 'ru' }, 10)).map((x) => x.id)).toEqual([c.id]);
        expect(await repo.listSeenGenerated(me, {}, 1)).toHaveLength(1);
        expect((await repo.listSeenGenerated(other, {}, 10)).map((x) => x.id)).toEqual([a.id]);
        expect(await repo.listSeenGenerated(newId(), {}, 10)).toEqual([]);
      });

      it('shared tutor answers: first write wins, hits are counted (v0.9.1)', async () => {
        const a = { key: 'k1', topicKey: 'speed', lang: 'ky' as const, raw: 'Ылдамдык [[phys.speed]]', hits: 0, createdAt: T0 };
        expect(await repo.getTutorAnswer('k1')).toBeNull();
        await repo.putTutorAnswer(a);
        await repo.putTutorAnswer({ ...a, raw: 'other' });
        await Promise.all([repo.hitTutorAnswer('k1'), repo.hitTutorAnswer('k1')]);
        await repo.hitTutorAnswer('missing');
        expect(await repo.getTutorAnswer('k1')).toEqual({ ...a, hits: 2 });
      });

      it('audit append + filters + pagination', async () => {
        const actor = newId();
        for (const action of ['auth.login', 'content.publish', 'auth.login']) {
          await repo.appendAudit({ id: newId(), actorId: action === 'content.publish' ? null : actor, action, targetType: action.split('.')[0], targetId: 'x', diff: { a: 1 }, ip: '1.2.3.4', ts: T0 });
        }
        expect((await repo.listAudit({ action: 'auth.login' }, { limit: 10 })).items).toHaveLength(2);
        expect((await repo.listAudit({ actorId: actor }, { limit: 10 })).items).toHaveLength(2);
        expect((await repo.listAudit({ targetType: 'content' }, { limit: 10 })).items[0]).toMatchObject({ actorId: null, diff: { a: 1 } });
        const p1 = await repo.listAudit({}, { limit: 2 });
        const p2 = await repo.listAudit({}, { limit: 2, cursor: p1.nextCursor! });
        expect(p1.items.length + p2.items.length).toBe(3);
        expect(p2.nextCursor).toBeNull();
      });

      it('settings: upsert without check, optimistic writes', async () => {
        expect(await repo.getSetting('k')).toBeNull();
        expect(await repo.putSetting('k', { a: 1 }, 5)).toBe('not_found');
        expect(await repo.putSetting('k', { a: 1 }, 0)).toMatchObject({ value: { a: 1 }, version: 1 });
        expect(await repo.putSetting('k', { a: 2 }, 0)).toBe('version_mismatch');
        expect(await repo.putSetting('k', { a: 2 }, 1)).toMatchObject({ value: { a: 2 }, version: 2 });
        expect(await repo.putSetting('k', { a: 3 }, null)).toMatchObject({ value: { a: 3 }, version: 3 });
        expect(await repo.putSetting('k2', [1, 2], null)).toMatchObject({ value: [1, 2], version: 1 });
        expect(await repo.getSetting('k')).toMatchObject({ value: { a: 3 }, version: 3 });
      });
    });

    describe('v0.8.0: journal, staff, support sessions, deletion requests', () => {
      const ev = (patch: Partial<AuditEventInput> = {}): AuditEventInput => ({
        id: newId(),
        at: T0,
        actorId: null,
        actorRole: null,
        onBehalfOfId: null,
        group: 'auth',
        action: 'auth.login',
        targetType: 'user',
        targetId: 'u1',
        targetLabel: null,
        before: null,
        after: null,
        details: null,
        reason: null,
        result: 'ok',
        ip: null,
        userAgent: null,
        requestId: null,
        supportSessionId: null,
        ...patch,
      });

      it('journal: a linear hash chain, filters, newest-first cursor, verify', async () => {
        const a = newId();
        const b = newId();
        const e1 = await repo.appendJournal(ev({ actorId: a, actorRole: 'manager', after: { x: 1, nested: { 'ключ': 'ü' } }, details: { list: [1, 'два', null] } }));
        const e2 = await repo.appendJournal(ev({ actorId: b, group: 'content', action: 'content.deleted', targetType: 'concept', targetId: 'bio.x', at: at(5), onBehalfOfId: a, supportSessionId: newId(), result: 'denied', reason: 'причина', ip: '1.2.3.4', userAgent: 'UA', requestId: 'req-1', before: [1, 2] }));
        const e3 = await repo.appendJournal(ev({ actorId: a, action: 'asset.deleted', group: 'content', at: at(10) }));
        expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
        expect(e1.prevHash).toBe('');
        expect(e2.prevHash).toBe(e1.hash);
        expect(e3.prevHash).toBe(e2.hash);
        expect(e1.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(e2).toMatchObject({ onBehalfOfId: a, result: 'denied', reason: 'причина', ip: '1.2.3.4', userAgent: 'UA', requestId: 'req-1', before: [1, 2], after: null });
        const all = await repo.listJournal({}, { limit: 10 });
        expect(all.items.map((e) => e.seq)).toEqual([3, 2, 1]);
        expect(all.items[2]).toMatchObject({ after: { x: 1, nested: { 'ключ': 'ü' } }, details: { list: [1, 'два', null] } });
        expect((await repo.listJournal({}, { limit: 10 }, 'asc')).items.map((e) => e.seq)).toEqual([1, 2, 3]);
        const p1 = await repo.listJournal({}, { limit: 2 });
        expect(p1.items.map((e) => e.seq)).toEqual([3, 2]);
        const p2 = await repo.listJournal({}, { limit: 2, cursor: p1.nextCursor! });
        expect(p2.items.map((e) => e.seq)).toEqual([1]);
        expect(p2.nextCursor).toBeNull();
        expect((await repo.listJournal({ actorId: a }, { limit: 10 })).items.map((e) => e.seq)).toEqual([3, 1]);
        expect((await repo.listJournal({ onBehalfOfId: a }, { limit: 10 })).items.map((e) => e.seq)).toEqual([2]);
        expect((await repo.listJournal({ group: 'content', actionSuffix: '.deleted' }, { limit: 10 })).items.map((e) => e.seq)).toEqual([3, 2]);
        expect((await repo.listJournal({ action: 'content.deleted', targetType: 'concept', targetId: 'bio.x', result: 'denied' }, { limit: 10 })).items.map((e) => e.seq)).toEqual([2]);
        expect((await repo.listJournal({ from: at(5), to: at(10) }, { limit: 10 })).items.map((e) => e.seq)).toEqual([2]);
        expect(await repo.verifyJournal()).toEqual({ ok: true, checked: 3, brokenAt: null });
        // the legacy projection (GET /admin/audit) and appendAudit go through the same chain
        await repo.appendAudit({ id: newId(), actorId: a, action: 'auth.login_failed', targetType: 'user', targetId: 'u2', diff: { before: 1, after: 2, why: 'x' }, ip: null, ts: at(11) });
        const legacy = (await repo.listAudit({ action: 'auth.login_failed' }, { limit: 5 })).items[0];
        expect(legacy).toMatchObject({ actorId: a, targetId: 'u2', diff: { before: 1, after: 2, why: 'x' }, ts: at(11) });
        expect((await repo.listJournal({ action: 'auth.login_failed' }, { limit: 5 })).items[0]).toMatchObject({ seq: 4, group: 'auth', result: 'failed', before: 1, after: 2 });
        expect(await repo.verifyJournal()).toEqual({ ok: true, checked: 4, brokenAt: null });
      });

      it('journal: concurrent appends stay linear', async () => {
        await Promise.all(Array.from({ length: 20 }, (_, i) => repo.appendJournal(ev({ targetId: `t${i}` }))));
        const rows = (await repo.listJournal({}, { limit: 50 }, 'asc')).items;
        expect(rows.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        expect(await repo.verifyJournal()).toEqual({ ok: true, checked: 20, brokenAt: null });
      });

      it('alerts: one per key, newest first, seen once', async () => {
        const a1 = { id: newId(), key: 'k1', at: T0, kind: 'mass_deletion' as const, actorId: newId(), summary: 's1', seenAt: null };
        expect(await repo.createAlert(a1)).toMatchObject({ key: 'k1' });
        expect(await repo.createAlert({ ...a1, id: newId() })).toBe('conflict');
        await repo.createAlert({ ...a1, id: newId(), key: 'k2', at: at(1), kind: 'chain_broken', actorId: null });
        expect((await repo.listAlerts(10)).map((x) => x.key)).toEqual(['k2', 'k1']);
        expect(await repo.markAlertSeen(a1.id, at(2))).toBe(true);
        expect(await repo.markAlertSeen(a1.id, at(3))).toBe(true);
        expect((await repo.listAlerts(10)).find((x) => x.id === a1.id)!.seenAt).toEqual(at(2));
        expect(await repo.markAlertSeen(newId(), at(3))).toBe(false);
      });

      it('staff profiles, users by role, teachingLang / lastLoginAt, class subjects, invite permissions', async () => {
        const u = await user();
        expect(await repo.getStaffProfile(u.id)).toBeNull();
        const p = { userId: u.id, permissions: ['teacher.view' as const], scope: null, createdBy: null, createdAt: T0, blockedAt: null, deletedAt: null };
        await repo.putStaffProfile(p);
        await repo.putStaffProfile({ ...p, permissions: ['teacher.view', 'audit.read'], blockedAt: at(1) });
        expect(await repo.getStaffProfile(u.id)).toEqual({ ...p, permissions: ['teacher.view', 'audit.read'], blockedAt: at(1) });
        expect((await repo.listStaffProfiles()).map((x) => x.userId)).toEqual([u.id]);
        const v = await user();
        await repo.addGrant({ userId: u.id, role: 'manager', scope: 'platform', scopeId: null, subrole: null });
        await repo.addGrant({ userId: v.id, role: 'manager', scope: 'platform', scopeId: null, subrole: null });
        await repo.addGrant({ userId: v.id, role: 'teacher', scope: 'school', scopeId: 's1', subrole: null });
        expect(await repo.listUserIdsByRole('manager')).toEqual([u.id, v.id].sort());
        expect(await repo.listUserIdsByRole('teacher')).toEqual([v.id]);
        expect(await repo.updateUser(u.id, { teachingLang: 'uz', lastLoginAt: at(3) })).toMatchObject({ teachingLang: 'uz', lastLoginAt: at(3) });
        expect(await repo.getUser(v.id)).toMatchObject({ teachingLang: null, lastLoginAt: null });

        const s = await school();
        const c = await klass(s.id);
        expect(c).toMatchObject({ subjectKey: null, subjectKeys: [] });
        expect(await repo.updateClass(c.id, { subjectKeys: ['math', 'bio', 'math'] })).toMatchObject({ subjectKey: 'math', subjectKeys: ['math', 'bio'] });
        expect(await repo.updateClass(c.id, { subjectKey: 'bio' })).toMatchObject({ subjectKey: 'bio', subjectKeys: ['bio', 'math'] });
        expect(await repo.updateClass(c.id, { name: '7Б' })).toMatchObject({ subjectKey: 'bio', subjectKeys: ['bio', 'math'] });
        expect(await repo.updateClass(c.id, { subjectKey: null })).toMatchObject({ subjectKey: null, subjectKeys: [] });
        const c2 = await repo.createClass({ id: newId(), schoolId: s.id, name: '8А', grade: 12, joinCode: 'XYZ234', joinCodeEnabled: true, subjectKey: 'chem', createdBy: newId(), createdAt: T0, deletedAt: null });
        expect(c2).toMatchObject({ grade: 12, subjectKey: 'chem', subjectKeys: ['chem'] });

        const i = { id: newId(), email: 'm@example.kg', role: 'manager' as const, scope: 'platform' as const, scopeId: null, subrole: null, permissions: ['teacher.view' as const], tokenHash: 'mh', invitedBy: newId(), createdAt: T0, expiresAt: at(100), acceptedAt: null };
        await repo.createInvite(i);
        expect(await repo.getInvite(i.id)).toEqual({ ...i, revokedAt: null });
      });

      it('support sessions: end once; expired open sessions', async () => {
        const s = { id: newId(), actorId: newId(), teacherId: newId(), mode: 'view' as const, reason: null, ip: '1.1.1.1', startedAt: T0, expiresAt: at(15), endedAt: null, endedBy: null, endReason: null };
        await repo.createSupportSession(s);
        await repo.createSupportSession({ ...s, id: newId(), mode: 'edit', reason: 'долгая причина', expiresAt: at(30) });
        expect(await repo.getSupportSession(s.id)).toEqual(s);
        expect((await repo.listExpiredSupportSessions(at(14))).length).toBe(0);
        expect((await repo.listExpiredSupportSessions(at(15))).map((x) => x.id)).toEqual([s.id]);
        expect(await repo.endSupportSession(s.id, at(16), null, 'expired')).toMatchObject({ endedAt: at(16), endReason: 'expired', endedBy: null });
        expect(await repo.endSupportSession(s.id, at(17), s.actorId, 'ended')).toBeNull();
        expect(await repo.listExpiredSupportSessions(at(20))).toEqual([]);
        expect(await repo.endSupportSession(newId(), at(17), null, 'ended')).toBeNull();
      });

      it('deletion requests: list newest first, decide once', async () => {
        const by = newId();
        const r = { id: newId(), kind: 'teacher' as const, targetId: newId(), targetLabel: 'Учитель', reason: 'уволился из школы', status: 'pending' as const, requestedBy: by, requestedAt: T0, decidedBy: null, decidedAt: null, decisionNote: null };
        await repo.createDeletionRequest(r);
        const r2 = { ...r, id: newId(), kind: 'concept' as const, targetId: 'bio.x', requestedBy: newId() };
        await repo.createDeletionRequest(r2);
        expect(await repo.getDeletionRequest(r.id)).toEqual(r);
        expect((await repo.listDeletionRequests({}, { limit: 10 })).items.map((x) => x.id)).toEqual([r2.id, r.id]);
        expect((await repo.listDeletionRequests({ requestedBy: by }, { limit: 10 })).items.map((x) => x.id)).toEqual([r.id]);
        const p1 = await repo.listDeletionRequests({}, { limit: 1 });
        expect((await repo.listDeletionRequests({}, { limit: 1, cursor: p1.nextCursor! })).items.map((x) => x.id)).toEqual([r.id]);
        const d = await repo.decideDeletionRequest(r.id, { status: 'approved', decidedBy: by, decidedAt: at(1), decisionNote: 'ok' });
        expect(d).toMatchObject({ status: 'approved', decidedBy: by, decidedAt: at(1), decisionNote: 'ok' });
        expect(await repo.decideDeletionRequest(r.id, { status: 'rejected', decidedBy: by, decidedAt: at(2), decisionNote: null })).toBeNull();
        expect((await repo.listDeletionRequests({ status: 'pending' }, { limit: 10 })).items.map((x) => x.id)).toEqual([r2.id]);
      });
    });
  });
}
