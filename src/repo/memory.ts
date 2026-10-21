/**
 * In-memory Repository: used by unit tests (fast, hermetic) and by
 * `STORAGE=memory` dev mode. Semantics match PrismaRepository; both run the
 * same contract suite. Every read returns a structured clone so callers can
 * never mutate stored state by accident.
 */
import { decodeCursor, encodeCursor, pageArray } from './paging.js';
import type {
  AnswerRec,
  AssetRec,
  AssetVersionRec,
  AssignmentRec,
  AttemptRec,
  AuditRec,
  AuditAlertRec,
  AuditEventInput,
  AuditEventRec,
  DeletionRequestRec,
  JournalFilter,
  StaffProfileRec,
  SupportSessionRec,
  AuthTokenRec,
  PhoneOtpRec,
  PhoneOtpPurpose,
  BuildRec,
  ClassRec,
  ConsentRec,
  ContentFilter,
  ContentKind,
  GeneratedFilter,
  GeneratedRec,
  ContentKinds,
  ContentRec,
  ContentStore,
  ContentWrite,
  CredentialRec,
  CredentialType,
  DeleteResult,
  EnrollmentRec,
  GrantRec,
  Id,
  IdempotencyRec,
  InviteRec,
  LearningEventRec,
  LicenseRec,
  LocaleStringRec,
  LocaleStringWrite,
  PageReq,
  PageRes,
  PresentationRec,
  TeachingPlanRec,
  ProgressRec,
  PublishedRec,
  Repository,
  ReviewCommentFilter,
  ReviewCommentRec,
  ReviewCommentWrite,
  SchoolRec,
  SessionRec,
  SettingRec,
  SnapshotRec,
  TopicRec,
  TopicVersionRec,
  TutorAnswerRec,
  BookRec,
  BookPageRec,
  BookSectionRec,
  TutorMessageRec,
  TutorThreadRec,
  UserRec,
  WriteResult,
} from './types.js';
import { newId } from '../ids.js';
import { eventToLegacy, legacyToEvent, memoryEventHash } from '../domain/journal.js';
import { classSubjects } from './class-subjects.js';

const clone = <T>(v: T): T => structuredClone(v);
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

class MemoryContentStore<T> implements ContentStore<T> {
  private rows = new Map<string, ContentRec<T> & { searchText: string }>();

  async list(filter: ContentFilter, page: PageReq): Promise<PageRes<ContentRec<T>>> {
    const q = filter.q?.toLocaleLowerCase();
    const rows = [...this.rows.values()]
      .filter((r) => (filter.subjectKey ? r.subjectKey === filter.subjectKey : true))
      .filter((r) => (q ? r.key.includes(q) || r.searchText.includes(q) : true))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const res = pageArray(rows, page, (r) => r.key);
    return { items: res.items.map(strip), nextCursor: res.nextCursor };
  }
  async get(key: string) {
    const r = this.rows.get(key);
    return r ? strip(r) : null;
  }
  async getById(id: Id) {
    const r = [...this.rows.values()].find((x) => x.id === id);
    return r ? strip(r) : null;
  }
  async getMany(keys: readonly string[]) {
    return keys.flatMap((k) => (this.rows.has(k) ? [strip(this.rows.get(k)!)] : []));
  }
  async create(key: string, w: ContentWrite<T>, actor: Id | null) {
    if (this.rows.has(key)) return 'conflict' as const;
    const now = new Date();
    const rec = { id: newId(), key, data: clone(w.data), subjectKey: w.subjectKey, searchText: w.searchText, version: 1, createdAt: now, updatedAt: now, updatedBy: actor };
    this.rows.set(key, rec);
    return strip(rec);
  }
  async update(key: string, w: ContentWrite<T>, expectedVersion: number | null, actor: Id | null): Promise<WriteResult<ContentRec<T>>> {
    const r = this.rows.get(key);
    if (!r) return 'not_found';
    if (expectedVersion !== null && r.version !== expectedVersion) return 'version_mismatch';
    const next = { ...r, data: clone(w.data), subjectKey: w.subjectKey, searchText: w.searchText, version: r.version + 1, updatedAt: new Date(), updatedBy: actor };
    this.rows.set(key, next);
    return strip(next);
  }
  async delete(key: string, expectedVersion: number | null): Promise<DeleteResult> {
    const r = this.rows.get(key);
    if (!r) return 'not_found';
    if (expectedVersion !== null && r.version !== expectedVersion) return 'version_mismatch';
    this.rows.delete(key);
    return 'ok';
  }
  async count() {
    return this.rows.size;
  }
}
function strip<T>(r: ContentRec<T> & { searchText: string }): ContentRec<T> {
  const { searchText: _s, ...rest } = r;
  return clone(rest);
}

export class MemoryRepository implements Repository {
  readonly kind = 'memory' as const;

  private users = new Map<Id, UserRec>();
  private credentials = new Map<string, CredentialRec>();
  private grants: GrantRec[] = [];
  private sessions = new Map<Id, SessionRec>();
  private authTokens = new Map<string, AuthTokenRec>();
  private phoneOtps = new Map<Id, PhoneOtpRec>();
  private invites = new Map<Id, InviteRec>();
  private schools = new Map<Id, SchoolRec>();
  private licenses = new Map<Id, LicenseRec>();
  private classes = new Map<Id, ClassRec>();
  private enrollments: EnrollmentRec[] = [];
  private consents = new Map<Id, ConsentRec>();
  private stores = new Map<ContentKind, MemoryContentStore<unknown>>();
  private topics = new Map<Id, TopicRec>();
  private versions = new Map<Id, TopicVersionRec>();
  private builds = new Map<Id, BuildRec>();
  private assets = new Map<Id, AssetRec>();
  private assetVersions: AssetVersionRec[] = [];
  private strings = new Map<string, LocaleStringRec>();
  private comments: ReviewCommentRec[] = [];
  private progress = new Map<string, ProgressRec>();
  private assignments = new Map<Id, AssignmentRec>();
  private attempts = new Map<Id, AttemptRec>();
  private answers = new Map<Id, AnswerRec>();
  private events = new Map<Id, LearningEventRec>();
  private idem = new Map<string, IdempotencyRec>();
  private presentations = new Map<Id, PresentationRec>();
  private teachingPlans = new Map<Id, TeachingPlanRec>();
  private snapshots = new Map<Id, SnapshotRec>();
  private threads = new Map<Id, TutorThreadRec>();
  private messages: TutorMessageRec[] = [];
  private generated = new Map<Id, GeneratedRec>();
  private generatedSeen = new Map<string, { userId: Id; generatedId: Id; seenAt: Date; n: number }>();
  private tutorAnswers = new Map<string, TutorAnswerRec>();
  private books = new Map<string, BookRec>();
  private bookPages = new Map<string, BookPageRec>();
  private bookSections = new Map<string, BookSectionRec[]>();
  private journal: AuditEventRec[] = [];
  private alerts = new Map<Id, AuditAlertRec>();
  private staff = new Map<Id, StaffProfileRec>();
  private support = new Map<Id, SupportSessionRec>();
  private deletions = new Map<Id, DeletionRequestRec>();
  private settings = new Map<string, SettingRec>();

  async ping() {
    return true;
  }
  async close() {}

  // --- identity -------------------------------------------------------------
  async createUser(u: Omit<UserRec, 'createdAt' | 'updatedAt' | 'deletedAt'>) {
    if (u.email && [...this.users.values()].some((x) => x.email === u.email)) return 'conflict' as const;
    if (u.phone && [...this.users.values()].some((x) => x.phone === u.phone)) return 'conflict' as const;
    const now = new Date();
    const rec: UserRec = { signup: null, phone: null, phoneVerifiedAt: null, teachingLang: null, lastLoginAt: null, ...u, createdAt: now, updatedAt: now, deletedAt: null };
    this.users.set(u.id, clone(rec));
    return clone(rec);
  }
  async getUser(id: Id) {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }
  async getUserByEmail(email: string) {
    const u = [...this.users.values()].find((x) => x.email === email.toLowerCase());
    return u ? clone(u) : null;
  }
  async getUserByPhone(phone: string) {
    const u = [...this.users.values()].find((x) => !!x.phone && x.phone === phone);
    return u ? clone(u) : null;
  }
  async updateUser(id: Id, patch: Partial<UserRec>) {
    const u = this.users.get(id);
    if (!u) return null;
    if (patch.phone && [...this.users.values()].some((x) => x.id !== id && x.phone === patch.phone)) throw new Error('Unique constraint failed: User.phone');
    const next = { ...u, ...patch, updatedAt: new Date() };
    this.users.set(id, next);
    return clone(next);
  }
  async listUsers(filter: { q?: string; ids?: Id[]; status?: UserRec['status'] }, page: PageReq) {
    const q = filter.q?.toLocaleLowerCase();
    const rows = [...this.users.values()]
      .filter((u) => !u.deletedAt)
      .filter((u) => (filter.ids ? filter.ids.includes(u.id) : true))
      .filter((u) => (filter.status ? u.status === filter.status : true))
      .filter((u) => (q ? u.displayName.toLocaleLowerCase().includes(q) || (u.email ?? '').includes(q) : true))
      .sort(byId);
    const res = pageArray(rows, page, (u) => u.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  async getUsers(ids: readonly Id[]) {
    return ids.flatMap((id) => (this.users.has(id) ? [clone(this.users.get(id)!)] : []));
  }

  private ck = (userId: Id, type: CredentialType) => `${userId}:${type}`;
  async getCredential(userId: Id, type: CredentialType) {
    const c = this.credentials.get(this.ck(userId, type));
    return c ? clone(c) : null;
  }
  async setCredential(userId: Id, type: CredentialType, secretHash: string) {
    this.credentials.set(this.ck(userId, type), { userId, type, secretHash, failedCount: 0, lockedUntil: null, updatedAt: new Date() });
  }
  async updateCredential(userId: Id, type: CredentialType, patch: Partial<CredentialRec>) {
    const c = this.credentials.get(this.ck(userId, type));
    if (c) this.credentials.set(this.ck(userId, type), { ...c, ...patch, updatedAt: new Date() });
  }
  async deleteCredential(userId: Id, type: CredentialType) {
    this.credentials.delete(this.ck(userId, type));
  }

  async listGrants(userId: Id) {
    return this.grants.filter((g) => g.userId === userId).map(clone);
  }
  async listGrantsByScope(scope: GrantRec['scope'], scopeId: string) {
    return this.grants.filter((g) => g.scope === scope && g.scopeId === scopeId).map(clone);
  }
  async setGrants(userId: Id, grants: Omit<GrantRec, 'userId'>[]) {
    this.grants = this.grants.filter((g) => g.userId !== userId);
    for (const g of grants) await this.addGrant({ ...g, userId });
  }
  async addGrant(g: GrantRec) {
    const same = (x: GrantRec) => x.userId === g.userId && x.role === g.role && x.scope === g.scope && x.scopeId === g.scopeId;
    this.grants = this.grants.filter((x) => !same(x));
    this.grants.push(clone(g));
  }

  async createSession(s: SessionRec) {
    this.sessions.set(s.id, clone(s));
  }
  async getSession(id: Id) {
    const s = this.sessions.get(id);
    return s ? clone(s) : null;
  }
  async getSessionByRefreshHash(hash: string) {
    const s = [...this.sessions.values()].find((x) => x.refreshHash === hash);
    return s ? clone(s) : null;
  }
  async rotateSession(oldId: Id, next: SessionRec, at: Date) {
    const old = this.sessions.get(oldId);
    if (!old || old.revokedAt || old.replacedById) return false;
    this.sessions.set(oldId, { ...old, revokedAt: at, replacedById: next.id });
    this.sessions.set(next.id, clone(next));
    return true;
  }
  async revokeSession(id: Id, at: Date) {
    const s = this.sessions.get(id);
    if (s && !s.revokedAt) this.sessions.set(id, { ...s, revokedAt: at });
  }
  async revokeFamily(family: Id, at: Date) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.family === family && !s.revokedAt) {
        s.revokedAt = at;
        n++;
      }
    }
    return n;
  }
  async revokeUserSessions(userId: Id, at: Date) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.userId === userId && !s.revokedAt) {
        s.revokedAt = at;
        n++;
      }
    }
    return n;
  }
  async listActiveSessions(userId: Id, now: Date) {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId && !s.revokedAt && s.expiresAt > now)
      .sort(byId)
      .map(clone);
  }

  async createAuthToken(t: AuthTokenRec) {
    this.authTokens.set(t.tokenHash, clone({ ...t, attempts: t.attempts ?? 0 }));
  }
  async latestAuthToken(userId: Id, purpose: AuthTokenRec['purpose']) {
    const rows = [...this.authTokens.values()].filter((t) => t.userId === userId && t.purpose === purpose);
    rows.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime() || (a.id < b.id ? 1 : -1));
    return rows[0] ? clone(rows[0]) : null;
  }
  async revokeAuthTokens(userId: Id, purpose: AuthTokenRec['purpose'], now: Date) {
    let n = 0;
    for (const t of this.authTokens.values()) {
      if (t.userId === userId && t.purpose === purpose && !t.usedAt) {
        t.usedAt = now;
        n++;
      }
    }
    return n;
  }
  async failAuthTokenAttempt(id: Id, max: number, now: Date) {
    const t = [...this.authTokens.values()].find((x) => x.id === id);
    if (!t || t.usedAt) return 0;
    t.attempts = (t.attempts ?? 0) + 1;
    if (t.attempts >= max) t.usedAt = now;
    return t.attempts;
  }
  async consumeAuthToken(tokenHash: string, purpose: AuthTokenRec['purpose'], now: Date) {
    const t = this.authTokens.get(tokenHash);
    if (!t || t.purpose !== purpose || t.usedAt || t.expiresAt <= now) return null;
    t.usedAt = now;
    return clone(t);
  }
  async findAuthToken(tokenHash: string, purpose: AuthTokenRec['purpose'], now: Date) {
    const t = this.authTokens.get(tokenHash);
    if (!t || t.purpose !== purpose || t.usedAt || t.expiresAt <= now) return null;
    return clone(t);
  }

  async createPhoneOtp(o: PhoneOtpRec) {
    if ([...this.phoneOtps.values()].some((x) => x.hash === o.hash)) throw new Error('Unique constraint failed: PhoneOtp.hash');
    this.phoneOtps.set(o.id, clone(o));
  }
  async latestPhoneOtp(phone: string, purpose: PhoneOtpPurpose, kind: PhoneOtpRec['kind']) {
    const rows = [...this.phoneOtps.values()].filter((o) => o.phone === phone && o.purpose === purpose && o.kind === kind);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    return rows[0] ? clone(rows[0]) : null;
  }
  async revokePhoneOtps(phone: string, purpose: PhoneOtpPurpose, kind: PhoneOtpRec['kind'], now: Date) {
    let n = 0;
    for (const o of this.phoneOtps.values()) {
      if (o.phone === phone && o.purpose === purpose && o.kind === kind && !o.usedAt) {
        o.usedAt = now;
        n++;
      }
    }
    return n;
  }
  async failPhoneOtpAttempt(id: Id, max: number, now: Date) {
    const o = this.phoneOtps.get(id);
    if (!o || o.usedAt) return 0;
    o.attempts += 1;
    if (o.attempts >= max) o.usedAt = now;
    return o.attempts;
  }
  async findPhoneOtp(hash: string, kind: PhoneOtpRec['kind'], now: Date) {
    const o = [...this.phoneOtps.values()].find((x) => x.hash === hash);
    return o && o.kind === kind && !o.usedAt && o.expiresAt > now ? clone(o) : null;
  }
  async consumePhoneOtp(hash: string, kind: PhoneOtpRec['kind'], now: Date) {
    const o = [...this.phoneOtps.values()].find((x) => x.hash === hash);
    if (!o || o.kind !== kind || o.usedAt || o.expiresAt <= now) return null;
    o.usedAt = now;
    return clone(o);
  }

  async createInvite(i: Omit<InviteRec, 'revokedAt'> & { revokedAt?: Date | null }) {
    this.invites.set(i.id, clone({ ...i, permissions: i.permissions ?? [], revokedAt: i.revokedAt ?? null }));
  }
  async getInvite(id: Id) {
    const i = this.invites.get(id);
    return i ? clone(i) : null;
  }
  async updateInvite(id: Id, patch: Partial<Pick<InviteRec, 'tokenHash' | 'expiresAt' | 'revokedAt'>>) {
    const i = this.invites.get(id);
    if (!i) return null;
    const next = { ...i, ...clone(patch), id };
    this.invites.set(id, next);
    return clone(next);
  }
  async getInviteByHash(tokenHash: string) {
    const i = [...this.invites.values()].find((x) => x.tokenHash === tokenHash);
    return i ? clone(i) : null;
  }
  async markInviteAccepted(id: Id, at: Date) {
    const i = this.invites.get(id);
    if (!i || i.acceptedAt || i.revokedAt) return false;
    i.acceptedAt = at;
    return true;
  }
  async listInvites(filter: { scope?: InviteRec['scope']; scopeIds?: string[] }, page: PageReq) {
    const rows = [...this.invites.values()]
      .filter((i) => (filter.scope ? i.scope === filter.scope : true))
      .filter((i) => (filter.scopeIds ? i.scopeId !== null && filter.scopeIds.includes(i.scopeId) : true))
      .sort(byId);
    const res = pageArray(rows, page, (i) => i.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }

  async createSchool(s: Omit<SchoolRec, 'version'> & { version?: number }) {
    this.schools.set(s.id, clone({ ...s, origin: s.origin ?? 'admin', version: s.version ?? 1 }));
  }
  async getSchool(id: Id) {
    const s = this.schools.get(id);
    return s ? clone(s) : null;
  }
  async updateSchool(id: Id, patch: Partial<SchoolRec>, expectedVersion: number | null = null) {
    const s = this.schools.get(id);
    if (!s) return null;
    if (expectedVersion !== null && s.version !== expectedVersion) return 'version_mismatch' as const;
    const next = { ...s, ...patch, id, createdAt: s.createdAt, version: s.version + 1 };
    this.schools.set(id, next);
    return clone(next);
  }
  async listSchools(filter: { ids?: Id[] }, page: PageReq) {
    const rows = [...this.schools.values()].filter((s) => (filter.ids ? filter.ids.includes(s.id) : true)).sort(byId);
    const res = pageArray(rows, page, (s) => s.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }

  async createLicense(l: Omit<LicenseRec, 'version'> & { version?: number }) {
    if (this.licenses.has(l.id)) return 'conflict' as const;
    const rec: LicenseRec = { ...clone(l), version: l.version ?? 1 };
    this.licenses.set(l.id, rec);
    return clone(rec);
  }
  async getLicense(id: Id) {
    const l = this.licenses.get(id);
    return l ? clone(l) : null;
  }
  async updateLicense(id: Id, patch: Partial<LicenseRec>, expectedVersion: number | null = null) {
    const l = this.licenses.get(id);
    if (!l) return null;
    if (expectedVersion !== null && l.version !== expectedVersion) return 'version_mismatch' as const;
    const next = { ...l, ...patch, id, schoolId: l.schoolId, version: l.version + 1 };
    this.licenses.set(id, next);
    return clone(next);
  }
  async deleteLicense(id: Id, expectedVersion: number | null = null) {
    const l = this.licenses.get(id);
    if (!l) return false;
    if (expectedVersion !== null && l.version !== expectedVersion) return 'version_mismatch' as const;
    return this.licenses.delete(id);
  }
  async listLicenses(filter: { schoolIds?: Id[] }, page: PageReq) {
    const rows = [...this.licenses.values()].filter((l) => (filter.schoolIds ? filter.schoolIds.includes(l.schoolId) : true)).sort(byId);
    const res = pageArray(rows, page, (l) => l.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }

  async createClass(c: ClassRec) {
    if ([...this.classes.values()].some((x) => x.joinCode === c.joinCode)) return 'conflict' as const;
    const rec = { ...c, ...classSubjects({ subjectKey: c.subjectKey ?? null, subjectKeys: c.subjectKeys }) };
    this.classes.set(c.id, clone(rec));
    return clone(rec);
  }
  async getClass(id: Id) {
    const c = this.classes.get(id);
    return c && !c.deletedAt ? clone(c) : null;
  }
  async getClassByJoinCode(code: string) {
    const c = [...this.classes.values()].find((x) => x.joinCode === code && !x.deletedAt);
    return c ? clone(c) : null;
  }
  async updateClass(id: Id, patch: Partial<ClassRec>) {
    const c = this.classes.get(id);
    if (!c) return null;
    if (patch.joinCode && [...this.classes.values()].some((x) => x.id !== id && x.joinCode === patch.joinCode)) return 'conflict' as const;
    const next = { ...c, ...patch, id, ...classSubjects(patch, c) };
    this.classes.set(id, next);
    return clone(next);
  }
  async listClasses(filter: { ids?: Id[]; schoolIds?: Id[] }, page: PageReq) {
    const rows = [...this.classes.values()]
      .filter((c) => !c.deletedAt)
      .filter((c) => (filter.ids ? filter.ids.includes(c.id) : true))
      .filter((c) => (filter.schoolIds ? filter.schoolIds.includes(c.schoolId) : true))
      .sort(byId);
    const res = pageArray(rows, page, (c) => c.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }

  async addEnrollment(e: Omit<EnrollmentRec, 'createdAt'>) {
    if (this.enrollments.some((x) => x.classId === e.classId && x.userId === e.userId)) return;
    this.enrollments.push({ ...e, createdAt: new Date() });
  }
  async removeEnrollment(classId: Id, userId: Id) {
    this.enrollments = this.enrollments.filter((x) => !(x.classId === classId && x.userId === userId));
  }
  async listEnrollments(filter: { classId?: Id; classIds?: Id[]; userId?: Id; role?: 'student' | 'teacher' }) {
    return this.enrollments
      .filter((e) => (filter.classId ? e.classId === filter.classId : true))
      .filter((e) => (filter.classIds ? filter.classIds.includes(e.classId) : true))
      .filter((e) => (filter.userId ? e.userId === filter.userId : true))
      .filter((e) => (filter.role ? e.role === filter.role : true))
      .map(clone);
  }

  async setConsent(c: ConsentRec | { studentId: Id; remove: true }) {
    if ('remove' in c) this.consents.delete(c.studentId);
    else this.consents.set(c.studentId, clone(c));
  }
  async listConsents(studentIds: readonly Id[]) {
    return studentIds.flatMap((id) => (this.consents.has(id) ? [clone(this.consents.get(id)!)] : []));
  }

  // --- content --------------------------------------------------------------
  content<K extends ContentKind>(kind: K): ContentStore<ContentKinds[K]> {
    let s = this.stores.get(kind);
    if (!s) {
      s = new MemoryContentStore<unknown>();
      this.stores.set(kind, s);
    }
    return s as unknown as ContentStore<ContentKinds[K]>;
  }

  async createTopic(t: Omit<TopicRec, 'createdAt' | 'updatedAt' | 'deletedAt' | 'version' | 'updatedBy'> & { updatedBy?: Id | null }) {
    if ([...this.topics.values()].some((x) => x.key === t.key)) return 'conflict' as const;
    const now = new Date();
    const rec: TopicRec = { ...t, updatedBy: t.updatedBy ?? null, version: 1, createdAt: now, updatedAt: now, deletedAt: null };
    this.topics.set(t.id, rec);
    return clone(rec);
  }
  async getTopic(id: Id) {
    const t = this.topics.get(id);
    return t && !t.deletedAt ? clone(t) : null;
  }
  async getTopicByKey(key: string) {
    const t = [...this.topics.values()].find((x) => x.key === key && !x.deletedAt);
    return t ? clone(t) : null;
  }
  async updateTopic(id: Id, patch: Partial<TopicRec>, expectedVersion: number | null): Promise<WriteResult<TopicRec>> {
    const t = this.topics.get(id);
    if (!t || t.deletedAt) return 'not_found';
    if (expectedVersion !== null && t.version !== expectedVersion) return 'version_mismatch';
    const next = { ...t, ...patch, id, version: t.version + 1, updatedAt: new Date() };
    this.topics.set(id, next);
    return clone(next);
  }
  async listTopics(filter: { q?: string; subjectKey?: string; status?: TopicRec['status']; scheduledBefore?: Date }, page: PageReq) {
    const q = filter.q?.toLocaleLowerCase();
    const rows = [...this.topics.values()]
      .filter((t) => !t.deletedAt)
      .filter((t) => (filter.subjectKey ? t.subjectKey === filter.subjectKey : true))
      .filter((t) => (filter.status ? t.status === filter.status : true))
      .filter((t) => (filter.scheduledBefore ? !!t.scheduledAt && t.scheduledAt <= filter.scheduledBefore : true))
      .filter((t) => (q ? t.key.includes(q) : true))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const res = pageArray(rows, page, (t) => t.key);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }

  async createTopicVersion(v: TopicVersionRec) {
    if ([...this.versions.values()].some((x) => x.topicId === v.topicId && x.version === v.version)) return 'conflict' as const;
    this.versions.set(v.id, clone(v));
    return clone(v);
  }
  async getTopicVersion(id: Id) {
    const v = this.versions.get(id);
    return v ? clone(v) : null;
  }
  async getTopicVersionBySemver(topicId: Id, version: string) {
    const v = [...this.versions.values()].find((x) => x.topicId === topicId && x.version === version);
    return v ? clone(v) : null;
  }
  async listTopicVersions(topicId: Id) {
    return [...this.versions.values()].filter((v) => v.topicId === topicId).sort(byId).map(clone);
  }
  async updateTopicVersion(id: Id, patch: Partial<TopicVersionRec>) {
    const v = this.versions.get(id);
    if (!v) return null;
    const next = { ...v, ...clone(patch), id };
    this.versions.set(id, next);
    return clone(next);
  }
  async topicsUsingConcept(conceptKey: string) {
    const keys = new Set<string>();
    for (const v of this.versions.values()) {
      const t = this.topics.get(v.topicId);
      if (!t || t.deletedAt) continue;
      if (docUsesConcept(v.doc, conceptKey)) keys.add(v.topicKey);
    }
    return [...keys].sort();
  }

  async createBuild(b: BuildRec) {
    this.builds.set(b.id, clone(b));
  }
  async updateBuild(id: Id, patch: Partial<BuildRec>) {
    const b = this.builds.get(id);
    if (!b) return null;
    const next = { ...b, ...clone(patch), id };
    this.builds.set(id, next);
    return clone(next);
  }
  async getBuild(id: Id) {
    const b = this.builds.get(id);
    return b ? clone(b) : null;
  }
  async readyBuildForVersion(topicVersionId: Id) {
    const b = [...this.builds.values()]
      .filter((x) => x.topicVersionId === topicVersionId && x.status === 'ready')
      .sort(byId)
      .pop();
    return b ? clone(b) : null;
  }
  async listBuilds(filter: { topicKey?: string; status?: BuildRec['status'] }, page: PageReq, order: 'asc' | 'desc' = 'asc') {
    const rows = [...this.builds.values()]
      .filter((b) => (filter.topicKey ? b.topicKey === filter.topicKey : true))
      .filter((b) => (filter.status ? b.status === filter.status : true))
      .sort(byId);
    if (order === 'desc') {
      rows.reverse();
      const after = decodeCursor(page.cursor);
      const from = after === undefined ? 0 : rows.findIndex((b) => b.id < after);
      const start = from < 0 ? rows.length : from;
      const slice = rows.slice(start, start + page.limit);
      const more = start + page.limit < rows.length;
      return { items: slice.map(clone), nextCursor: more && slice.length ? encodeCursor(slice[slice.length - 1].id) : null };
    }
    const res = pageArray(rows, page, (b) => b.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  async listPublished(): Promise<PublishedRec[]> {
    const out: PublishedRec[] = [];
    for (const t of [...this.topics.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (t.deletedAt || !t.publishedVersionId) continue;
      const b = await this.readyBuildForVersion(t.publishedVersionId);
      if (b?.manifest && b.pkg) out.push({ topic: clone(t), build: b as PublishedRec['build'] });
    }
    return out;
  }

  async createAsset(a: Omit<AssetRec, 'version'> & { version?: number }) {
    this.assets.set(a.id, clone({ ...a, version: a.version ?? 1 }));
  }
  async getAsset(id: Id) {
    const a = this.assets.get(id);
    return a ? clone(a) : null;
  }
  async updateAsset(id: Id, patch: Partial<AssetRec>) {
    const a = this.assets.get(id);
    if (!a) return null;
    const next = { ...a, ...clone(patch), id };
    this.assets.set(id, next);
    return clone(next);
  }
  async listAssets(page: PageReq) {
    const res = pageArray([...this.assets.values()].sort(byId), page, (a) => a.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  async deleteAsset(id: Id) {
    this.assetVersions = this.assetVersions.filter((v) => v.assetId !== id);
    return this.assets.delete(id);
  }
  async createAssetVersion(v: AssetVersionRec) {
    if (this.assetVersions.some((x) => x.assetId === v.assetId && x.version === v.version)) return 'conflict' as const;
    this.assetVersions.push(clone(v));
    return clone(v);
  }
  async listAssetVersions(assetId: Id) {
    return this.assetVersions.filter((v) => v.assetId === assetId).sort((a, b) => a.version - b.version).map(clone);
  }
  async updateAssetVersion(assetId: Id, version: number, patch: Partial<AssetVersionRec>) {
    const i = this.assetVersions.findIndex((v) => v.assetId === assetId && v.version === version);
    if (i < 0) return null;
    this.assetVersions[i] = { ...this.assetVersions[i], ...clone(patch), assetId, version };
    return clone(this.assetVersions[i]);
  }

  private sk = (key: string, locale: string) => `${key}\u0000${locale}`;
  async listStrings(filter: { locale?: LocaleStringRec['locale']; status?: LocaleStringRec['status']; keyPrefix?: string }, page: PageReq) {
    const rows = [...this.strings.values()]
      .filter((s) => (filter.locale ? s.locale === filter.locale : true))
      .filter((s) => (filter.status ? s.status === filter.status : true))
      .filter((s) => (filter.keyPrefix ? s.key.startsWith(filter.keyPrefix) : true))
      .sort((a, b) => (this.sk(a.key, a.locale) < this.sk(b.key, b.locale) ? -1 : 1));
    const res = pageArray(rows, page, (s) => this.sk(s.key, s.locale));
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  async getStrings(keys: readonly string[]) {
    const set = new Set(keys);
    return [...this.strings.values()].filter((s) => set.has(s.key)).map(clone);
  }
  async upsertStrings(rows: readonly LocaleStringWrite[]) {
    for (const r of rows) {
      const k = this.sk(r.key, r.locale);
      this.strings.set(k, { ...clone(r), version: (this.strings.get(k)?.version ?? 0) + 1 });
    }
  }

  async createReviewComment(c: ReviewCommentWrite) {
    this.comments.push(clone({ ...c, anchor3d: c.anchor3d ?? null, resolvedBy: c.resolvedBy ?? null, topicVersion: c.topicVersion ?? null }));
  }
  async getReviewComment(id: Id) {
    const c = this.comments.find((x) => x.id === id);
    return c ? clone(c) : null;
  }
  async listReviewComments(filter: ReviewCommentFilter, page: PageReq) {
    const rows = this.comments
      .filter((c) => (filter.targetType ? c.targetType === filter.targetType : true))
      .filter((c) => (filter.targetId ? c.targetId === filter.targetId : true))
      .filter((c) => (filter.authorId ? c.authorId === filter.authorId : true))
      .filter((c) => (filter.resolved === undefined ? true : filter.resolved === (c.resolvedAt !== null)))
      .sort(byId);
    const res = pageArray(rows, page, (c) => c.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  async updateReviewComment(id: Id, patch: Partial<Pick<ReviewCommentRec, 'body' | 'resolvedAt' | 'resolvedBy'>>) {
    const i = this.comments.findIndex((x) => x.id === id);
    if (i < 0) return null;
    this.comments[i] = { ...this.comments[i], ...clone(patch), id };
    return clone(this.comments[i]);
  }

  // --- learning ---------------------------------------------------------------
  async getProgress(userId: Id, topicKey: string) {
    const p = this.progress.get(`${userId}:${topicKey}`);
    return p ? clone(p) : null;
  }
  async putProgress(p: ProgressRec) {
    this.progress.set(`${p.userId}:${p.topicKey}`, clone(p));
  }

  async createAssignment(a: AssignmentRec) {
    this.assignments.set(a.id, clone(a));
  }
  async getAssignment(id: Id) {
    const a = this.assignments.get(id);
    return a ? clone(a) : null;
  }
  async listAssignments(filter: { classIds: Id[] }, page: PageReq) {
    const rows = [...this.assignments.values()].filter((a) => filter.classIds.includes(a.classId)).sort(byId);
    const res = pageArray(rows, page, (a) => a.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }

  async createAttempt(a: AttemptRec) {
    if ([...this.attempts.values()].some((x) => x.userId === a.userId && x.clientId === a.clientId)) return 'conflict' as const;
    this.attempts.set(a.id, clone(a));
    return clone(a);
  }
  async getAttempt(id: Id) {
    const a = this.attempts.get(id);
    return a ? clone(a) : null;
  }
  async getAttemptByClientId(userId: Id, clientId: Id) {
    const a = [...this.attempts.values()].find((x) => x.userId === userId && x.clientId === clientId);
    return a ? clone(a) : null;
  }
  async updateAttempt(id: Id, patch: Partial<AttemptRec>) {
    const a = this.attempts.get(id);
    if (!a) return null;
    const next = { ...a, ...patch, id };
    this.attempts.set(id, next);
    return clone(next);
  }
  async listAttempts(filter: { userId?: Id; userIds?: Id[]; assignmentId?: Id; from?: Date; to?: Date }) {
    return [...this.attempts.values()]
      .filter((a) => (filter.userId ? a.userId === filter.userId : true))
      .filter((a) => (filter.userIds ? filter.userIds.includes(a.userId) : true))
      .filter((a) => (filter.assignmentId ? a.assignmentId === filter.assignmentId : true))
      .filter((a) => (filter.from ? a.startedAt >= filter.from : true))
      .filter((a) => (filter.to ? a.startedAt < filter.to : true))
      .sort(byId)
      .map(clone);
  }

  async createAnswer(a: AnswerRec) {
    if ([...this.answers.values()].some((x) => x.attemptId === a.attemptId && x.itemKey === a.itemKey)) return 'conflict' as const;
    this.answers.set(a.id, clone(a));
    return clone(a);
  }
  async listAnswers(filter: { attemptIds?: Id[]; itemKey?: string }) {
    return [...this.answers.values()]
      .filter((a) => (filter.attemptIds ? filter.attemptIds.includes(a.attemptId) : true))
      .filter((a) => (filter.itemKey ? a.itemKey === filter.itemKey : true))
      .sort(byId)
      .map(clone);
  }

  async insertEvents(events: readonly LearningEventRec[]) {
    let accepted = 0;
    let duplicates = 0;
    for (const e of events) {
      if (this.events.has(e.id)) duplicates++;
      else {
        this.events.set(e.id, clone(e));
        accepted++;
      }
    }
    return { accepted, duplicates };
  }
  async listEvents(filter: { from?: Date; to?: Date }) {
    return [...this.events.values()]
      .filter((e) => (filter.from ? e.ts >= filter.from : true))
      .filter((e) => (filter.to ? e.ts < filter.to : true))
      .map(clone);
  }

  async getIdempotency(userId: Id, key: string) {
    const r = this.idem.get(`${userId}:${key}`);
    return r ? clone(r) : null;
  }
  async putIdempotency(r: IdempotencyRec) {
    const k = `${r.userId}:${r.key}`;
    if (this.idem.has(k)) return false;
    this.idem.set(k, clone(r));
    return true;
  }

  // --- decks ------------------------------------------------------------------
  async createPresentation(p: PresentationRec) {
    this.presentations.set(p.id, clone(p));
  }
  async getPresentation(id: Id) {
    const p = this.presentations.get(id);
    return p ? clone(p) : null;
  }
  async updatePresentation(id: Id, patch: Partial<PresentationRec>, expectedVersion: number): Promise<WriteResult<PresentationRec>> {
    const p = this.presentations.get(id);
    if (!p) return 'not_found';
    if (p.version !== expectedVersion) return 'version_mismatch';
    const next = { ...p, ...clone(patch), id, version: p.version + 1, updatedAt: new Date() };
    this.presentations.set(id, next);
    return clone(next);
  }
  async deletePresentation(id: Id) {
    return this.presentations.delete(id);
  }
  async listPresentations(ownerId: Id, page: PageReq) {
    const rows = [...this.presentations.values()].filter((p) => p.ownerId === ownerId).sort(byId);
    const res = pageArray(rows, page, (p) => p.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  // --- КТП ----------------------------------------------------------------------
  async createTeachingPlan(p: TeachingPlanRec) {
    this.teachingPlans.set(p.id, clone(p));
  }
  async getTeachingPlan(id: Id) {
    const p = this.teachingPlans.get(id);
    return p ? clone(p) : null;
  }
  async updateTeachingPlan(id: Id, patch: Partial<Pick<TeachingPlanRec, 'title' | 'doc'>>, expectedVersion: number): Promise<WriteResult<TeachingPlanRec>> {
    const p = this.teachingPlans.get(id);
    if (!p) return 'not_found';
    if (p.version !== expectedVersion) return 'version_mismatch';
    const next: TeachingPlanRec = { ...p, ...clone(patch), id, version: p.version + 1, updatedAt: new Date() };
    this.teachingPlans.set(id, next);
    return clone(next);
  }
  async deleteTeachingPlan(id: Id, expectedVersion: number) {
    const p = this.teachingPlans.get(id);
    if (!p) return 'not_found' as const;
    if (p.version !== expectedVersion) return 'version_mismatch' as const;
    this.teachingPlans.delete(id);
    return 'ok' as const;
  }
  async listTeachingPlans(ownerId: Id, page: PageReq) {
    const rows = [...this.teachingPlans.values()].filter((p) => p.ownerId === ownerId).sort(byId);
    const res = pageArray(rows, page, (p) => p.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }

  async createSnapshot(s: SnapshotRec) {
    this.snapshots.set(s.id, clone(s));
  }
  async getSnapshot(id: Id) {
    const s = this.snapshots.get(id);
    return s ? clone(s) : null;
  }
  async getSnapshots(ids: readonly Id[]) {
    return ids.flatMap((id) => (this.snapshots.has(id) ? [clone(this.snapshots.get(id)!)] : []));
  }

  // --- tutor --------------------------------------------------------------------
  async createThread(t: TutorThreadRec) {
    this.threads.set(t.id, clone(t));
  }
  async getThread(id: Id) {
    const t = this.threads.get(id);
    return t ? clone(t) : null;
  }
  async addTutorMessage(m: TutorMessageRec) {
    this.messages.push(clone(m));
  }
  async createBook(b: BookRec) {
    this.books.set(b.id, clone(b));
  }
  async getBook(id: Id) {
    const b = this.books.get(id);
    return b ? clone(b) : null;
  }
  async listBooks(f: { grade?: number; subjectKey?: string; lang?: string; statuses?: BookRec['status'][] }) {
    return [...this.books.values()]
      .filter((b) => (f.grade === undefined || b.grade === f.grade) && (!f.subjectKey || b.subjectKey === f.subjectKey) && (!f.lang || b.lang === f.lang) && (!f.statuses || f.statuses.includes(b.status)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map(clone);
  }
  async updateBook(id: Id, patch: Partial<Omit<BookRec, 'id' | 'createdBy' | 'createdAt'>>) {
    const b = this.books.get(id);
    if (!b) return null;
    const next = { ...b, ...clone(patch) };
    this.books.set(id, next);
    return clone(next);
  }
  async claimBook(now: Date, until: Date) {
    const b = [...this.books.values()]
      .filter((x) => (x.status === 'queued' || x.status === 'processing') && (!x.leaseUntil || x.leaseUntil <= now))
      .sort((a, c) => a.updatedAt.getTime() - c.updatedAt.getTime())[0];
    if (!b) return null;
    b.leaseUntil = new Date(until);
    return clone(b);
  }
  async putBookPages(pages: BookPageRec[]) {
    for (const p of pages) this.bookPages.set(`${p.bookId}|${p.n}`, clone(p));
  }
  async listBookPages(bookId: Id) {
    return [...this.bookPages.values()].filter((p) => p.bookId === bookId).sort((a, b) => a.n - b.n).map(clone);
  }
  async setBookPageRead(bookId: Id, n: number, read: unknown) {
    const p = this.bookPages.get(`${bookId}|${n}`);
    if (p) p.read = clone(read);
  }
  async replaceBookSections(bookId: Id, rows: BookSectionRec[]) {
    this.bookSections.set(bookId, rows.map(clone));
  }
  async listBookSections(bookId: Id) {
    return (this.bookSections.get(bookId) ?? []).slice().sort((a, b) => a.order - b.order).map(clone);
  }
  async updateBookSection(bookId: Id, id: Id, patch: Partial<Omit<BookSectionRec, 'id' | 'bookId'>>) {
    const list = this.bookSections.get(bookId) ?? [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...clone(patch) };
    return clone(list[i]);
  }
  async getTutorAnswer(key: string) {
    const a = this.tutorAnswers.get(key);
    return a ? clone(a) : null;
  }
  async putTutorAnswer(a: TutorAnswerRec) {
    if (!this.tutorAnswers.has(a.key)) this.tutorAnswers.set(a.key, clone(a));
  }
  async hitTutorAnswer(key: string) {
    const a = this.tutorAnswers.get(key);
    if (a) a.hits++;
  }
  async addGenerated(rows: GeneratedRec[]) {
    for (const r of rows) this.generated.set(r.id, clone(r));
  }
  async getGenerated(id: Id) {
    const r = this.generated.get(id);
    return r ? clone(r) : null;
  }
  async listGenerated(filter: GeneratedFilter, page: PageReq) {
    const rows = [...this.generated.values()]
      .filter((g) => (filter.topicKey ? g.topicKey === filter.topicKey : true))
      .filter((g) => (filter.conceptKey !== undefined ? g.conceptKey === filter.conceptKey : true))
      .filter((g) => (filter.kind ? g.kind === filter.kind : true))
      .filter((g) => (filter.lang ? g.lang === filter.lang : true))
      .filter((g) => (filter.status ? g.status === filter.status : true))
      .sort(byId);
    const res = pageArray(rows, page, (g) => g.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  async updateGenerated(id: Id, patch: Partial<Pick<GeneratedRec, 'status' | 'reviewedAt' | 'reviewedBy' | 'promotedTo'>>) {
    const g = this.generated.get(id);
    if (!g) return null;
    const next = { ...g, ...patch };
    this.generated.set(id, next);
    return clone(next);
  }
  async markGeneratedSeen(userId: Id, ids: Id[], at: Date) {
    for (const id of ids) {
      const k = `${userId}|${id}`;
      if (this.generatedSeen.has(k) || !this.generated.has(id)) continue;
      this.generatedSeen.set(k, { userId, generatedId: id, seenAt: new Date(at), n: this.generatedSeen.size });
    }
  }
  async listSeenGenerated(userId: Id, filter: GeneratedFilter, limit: number) {
    const match = (g: GeneratedRec) =>
      (!filter.topicKey || g.topicKey === filter.topicKey) &&
      (filter.conceptKey === undefined || g.conceptKey === filter.conceptKey) &&
      (!filter.kind || g.kind === filter.kind) &&
      (!filter.lang || g.lang === filter.lang) &&
      (!filter.status || g.status === filter.status);
    return [...this.generatedSeen.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => a.seenAt.getTime() - b.seenAt.getTime() || a.n - b.n)
      .map((s) => this.generated.get(s.generatedId))
      .filter((g): g is GeneratedRec => !!g && match(g))
      .slice(0, limit)
      .map(clone);
  }
  async countGenerated(ids: Id[], delta: { served?: number; good?: number; bad?: number; reason?: string }) {
    for (const id of ids) {
      const g = this.generated.get(id);
      if (!g) continue;
      g.served += delta.served ?? 0;
      g.good += delta.good ?? 0;
      g.bad += delta.bad ?? 0;
      if (delta.reason) g.reasons = { ...g.reasons, [delta.reason]: (g.reasons[delta.reason] ?? 0) + 1 };
    }
  }

  async listTutorMessages(filter: { threadId?: Id; from?: Date; to?: Date; limit?: number }) {
    let rows = this.messages
      .filter((m) => (filter.threadId ? m.threadId === filter.threadId : true))
      .filter((m) => (filter.from ? m.createdAt >= filter.from : true))
      .filter((m) => (filter.to ? m.createdAt < filter.to : true))
      .sort(byId);
    if (filter.limit) rows = rows.slice(-filter.limit);
    return rows.map(clone);
  }

  // --- audit & settings -----------------------------------------------------------
  async appendAudit(a: AuditRec) {
    await this.appendJournal(legacyToEvent(a));
  }
  async listAudit(filter: { actorId?: Id; action?: string; targetType?: string }, page: PageReq) {
    const rows = this.journal
      .map(eventToLegacy)
      .filter((a) => (filter.actorId ? a.actorId === filter.actorId : true))
      .filter((a) => (filter.action ? a.action === filter.action : true))
      .filter((a) => (filter.targetType ? a.targetType === filter.targetType : true))
      .sort(byId);
    const res = pageArray(rows, page, (a) => a.id);
    return { items: res.items.map(clone), nextCursor: res.nextCursor };
  }
  async getSetting(key: string) {
    const s = this.settings.get(key);
    return s ? clone(s) : null;
  }
  async putSetting(key: string, value: unknown, expectedVersion: number | null): Promise<WriteResult<SettingRec>> {
    const s = this.settings.get(key);
    if (expectedVersion !== null && (s?.version ?? 0) !== expectedVersion) return s ? 'version_mismatch' : 'not_found';
    const next: SettingRec = { key, value: clone(value), version: (s?.version ?? 0) + 1, updatedAt: new Date() };
    this.settings.set(key, next);
    return clone(next);
  }

  // --- v0.8.0: the action journal ------------------------------------------------------
  async appendJournal(e: AuditEventInput) {
    const last = this.journal[this.journal.length - 1];
    const body = { ...clone(e), before: e.before ?? null, after: e.after ?? null, details: e.details ?? null, seq: (last?.seq ?? 0) + 1, prevHash: last?.hash ?? '' };
    const rec: AuditEventRec = { ...body, hash: memoryEventHash(body) };
    this.journal.push(rec);
    return clone(rec);
  }
  async listJournal(f: JournalFilter, page: PageReq, order: 'asc' | 'desc' = 'desc') {
    const after = decodeCursor(page.cursor);
    const cur = after !== undefined && /^\d+$/.test(after) ? Number(after) : null;
    let rows = this.journal.filter(
      (e) =>
        (!f.actorId || e.actorId === f.actorId) &&
        (!f.onBehalfOfId || e.onBehalfOfId === f.onBehalfOfId) &&
        (!f.group || e.group === f.group) &&
        (!f.action || e.action === f.action) &&
        (!f.actionSuffix || e.action.endsWith(f.actionSuffix)) &&
        (!f.targetType || e.targetType === f.targetType) &&
        (!f.targetId || e.targetId === f.targetId) &&
        (!f.from || e.at >= f.from) &&
        (!f.to || e.at < f.to) &&
        (!f.result || e.result === f.result) &&
        (cur === null || (order === 'desc' ? e.seq < cur : e.seq > cur)),
    );
    if (order === 'desc') rows = [...rows].reverse();
    const items = rows.slice(0, page.limit);
    return { items: items.map(clone), nextCursor: rows.length > page.limit && items.length ? encodeCursor(String(items[items.length - 1].seq)) : null };
  }
  async verifyJournal() {
    let prev: AuditEventRec | null = null;
    let n = 0;
    for (const e of this.journal) {
      n++;
      const broken =
        (prev && (e.seq !== prev.seq + 1 || e.prevHash !== prev.hash)) || (!prev && e.seq === 1 && e.prevHash !== '') || e.hash !== memoryEventHash(e);
      if (broken) return { ok: false, checked: n, brokenAt: e.seq };
      prev = e;
    }
    return { ok: true, checked: n, brokenAt: null };
  }
  async maintainJournal(now: Date, _ahead: number, retainMonths: number) {
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retainMonths, 1));
    const before = this.journal.length;
    this.journal = this.journal.filter((e) => e.at >= cutoff);
    return { created: 0, dropped: before - this.journal.length };
  }
  /** Test hook: rewrite a stored event in place (the PostgreSQL table refuses this). */
  tamperJournal(seq: number, patch: Partial<AuditEventRec>) {
    const i = this.journal.findIndex((e) => e.seq === seq);
    if (i >= 0) this.journal[i] = { ...this.journal[i], ...patch };
  }
  async createAlert(a: AuditAlertRec) {
    if ([...this.alerts.values()].some((x) => x.key === a.key)) return 'conflict' as const;
    this.alerts.set(a.id, clone(a));
    return clone(a);
  }
  async listAlerts(limit: number) {
    return [...this.alerts.values()].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1)).slice(0, limit).map(clone);
  }
  async markAlertSeen(id: Id, at: Date) {
    const a = this.alerts.get(id);
    if (!a) return false;
    if (!a.seenAt) a.seenAt = at;
    return true;
  }

  // --- v0.8.0: staff, support sessions, deletion requests ---------------------------------
  async getStaffProfile(userId: Id) {
    const p = this.staff.get(userId);
    return p ? clone(p) : null;
  }
  async putStaffProfile(p: StaffProfileRec) {
    this.staff.set(p.userId, clone(p));
  }
  async listStaffProfiles() {
    return [...this.staff.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1)).map(clone);
  }
  async listUserIdsByRole(role: GrantRec['role']) {
    return [...new Set(this.grants.filter((g) => g.role === role).map((g) => g.userId))].sort();
  }
  async createSupportSession(s: SupportSessionRec) {
    this.support.set(s.id, clone(s));
  }
  async getSupportSession(id: Id) {
    const s = this.support.get(id);
    return s ? clone(s) : null;
  }
  async endSupportSession(id: Id, at: Date, by: Id | null, reason: 'ended' | 'expired') {
    const s = this.support.get(id);
    if (!s || s.endedAt) return null;
    Object.assign(s, { endedAt: at, endedBy: by, endReason: reason });
    return clone(s);
  }
  async listExpiredSupportSessions(now: Date) {
    return [...this.support.values()].filter((s) => !s.endedAt && s.expiresAt <= now).sort(byId).map(clone);
  }
  async createDeletionRequest(r: DeletionRequestRec) {
    this.deletions.set(r.id, clone(r));
  }
  async getDeletionRequest(id: Id) {
    const r = this.deletions.get(id);
    return r ? clone(r) : null;
  }
  async listDeletionRequests(f: { status?: DeletionRequestRec['status']; requestedBy?: Id }, page: PageReq) {
    const after = decodeCursor(page.cursor);
    const rows = [...this.deletions.values()]
      .filter((r) => (!f.status || r.status === f.status) && (!f.requestedBy || r.requestedBy === f.requestedBy) && (after === undefined || r.id < after))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const items = rows.slice(0, page.limit);
    return { items: items.map(clone), nextCursor: rows.length > page.limit && items.length ? encodeCursor(items[items.length - 1].id) : null };
  }
  async decideDeletionRequest(id: Id, d: Pick<DeletionRequestRec, 'status' | 'decidedBy' | 'decidedAt' | 'decisionNote'>) {
    const r = this.deletions.get(id);
    if (!r || r.status !== 'pending') return null;
    Object.assign(r, clone(d));
    return clone(r);
  }

  async purgeDeleted(before: Date) {
    let users = 0;
    let classes = 0;
    for (const [id, u] of this.users) {
      if (u.deletedAt && u.deletedAt < before) {
        this.users.delete(id);
        this.grants = this.grants.filter((g) => g.userId !== id);
        this.enrollments = this.enrollments.filter((e) => e.userId !== id);
        for (const k of [...this.credentials.keys()]) if (k.startsWith(`${id}:`)) this.credentials.delete(k);
        this.consents.delete(id);
        users++;
      }
    }
    for (const [id, c] of this.classes) {
      if (c.deletedAt && c.deletedAt < before) {
        this.classes.delete(id);
        this.enrollments = this.enrollments.filter((e) => e.classId !== id);
        classes++;
      }
    }
    return { users, classes };
  }
}

/** Does a topic document reference a concept (topic concepts, overrides, tour, comparison, items targets)? */
export function docUsesConcept(doc: TopicVersionRec['doc'], key: string): boolean {
  if (doc.conceptKeys.includes(key) || key in doc.overrides) return true;
  const acts = doc.activities;
  if (acts.comparison?.columns.some((c) => c.kind === 'concept' && c.key === key)) return true;
  return !!acts.tour?.steps.some(
    (s) => s.focus === key || s.visibility?.isolate?.includes(key) || s.visibility?.hide?.includes(key),
  );
}
