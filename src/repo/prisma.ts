/**
 * PrismaRepository — the PostgreSQL 16 implementation of Repository (TZ §8).
 * Semantics mirror MemoryRepository exactly; both pass src/repo/repo.contract.ts.
 * Atomic operations (refresh rotation, single-use tokens, optimistic versions)
 * are conditional `updateMany` calls whose affected-row count decides the outcome.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { decodeCursor, encodeCursor } from './paging.js';
import { newId } from '../ids.js';
import type {
  AnswerRec,
  AssetRec,
  AssignmentRec,
  AttemptRec,
  AuditRec,
  AuthTokenRec,
  BuildRec,
  ClassRec,
  ConsentRec,
  ContentFilter,
  ContentKind,
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
  PageReq,
  PageRes,
  PresentationRec,
  ProgressRec,
  PublishedRec,
  Repository,
  ReviewCommentRec,
  SchoolRec,
  SessionRec,
  SettingRec,
  SnapshotRec,
  TopicRec,
  TopicVersionRec,
  TutorMessageRec,
  TutorThreadRec,
  UserRec,
  WriteResult,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = any;

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const isNotFound = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;
const jsonOrNull = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

/** Page `take: limit + 1` rows already ordered ascending by `sortKey`. */
function page<T>(rows: T[], limit: number, sortKey: (t: T) => string): PageRes<T> {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: more && items.length ? encodeCursor(sortKey(items[items.length - 1])) : null };
}

/** Keep `wanted` order, skipping missing (matches MemoryRepository.getMany/getUsers). */
function inOrder<T>(wanted: readonly string[], rows: T[], key: (t: T) => string): T[] {
  const m = new Map(rows.map((r) => [key(r), r]));
  return wanted.flatMap((k) => (m.has(k) ? [m.get(k)!] : []));
}

/** Cursor filter on `id` (UUID v7 → creation order). */
function idWhere(p: PageReq, ids?: readonly string[]): Record<string, unknown> {
  const after = decodeCursor(p.cursor);
  const cond: Record<string, unknown> = {};
  if (after !== undefined) cond.gt = after;
  if (ids) cond.in = [...ids];
  return Object.keys(cond).length ? { id: cond } : {};
}

const range = (from?: Date, to?: Date) =>
  from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;

// ---------------------------------------------------------------------------
// Content stores
// ---------------------------------------------------------------------------

/** Per-kind delegate and the TZ relational columns derived from the doc. */
const CONTENT_TABLES: Record<ContentKind, { delegate: string; columns: (d: any) => Record<string, unknown> }> = {
  group: { delegate: 'subjectGroup', columns: (d) => ({ order: d.order ?? 0 }) },
  subject: { delegate: 'subject', columns: (d) => ({ groupKey: d.group ?? null, icon: d.icon ?? null, hue: d.hue ?? null, order: d.order ?? 0, status: d.status ?? null }) },
  course: { delegate: 'course', columns: (d) => ({ grade: d.grade ?? null, curriculum: d.curriculum ?? null }) },
  unit: { delegate: 'unit', columns: (d) => ({ courseKey: d.courseKey ?? null, order: d.order ?? 0 }) },
  objective: { delegate: 'objective', columns: (d) => ({ unitKey: d.unitKey ?? null, code: d.code ?? null }) },
  concept: { delegate: 'concept', columns: (d) => ({ kind: d.kind ?? null, hue: d.hue ?? null, isContainer: !!d.isContainer, related: d.related ?? [] }) },
  process: { delegate: 'process', columns: (d) => ({ engine: d.engine ?? null }) },
  item: { delegate: 'item', columns: (d) => ({ type: d.type ?? null, difficulty: d.difficulty ?? null, objectiveKeys: d.objectiveKeys ?? [] }) },
  glossary: { delegate: 'glossaryTerm', columns: () => ({}) },
};

class PrismaContentStore<T> implements ContentStore<T> {
  constructor(private db: PrismaClient, private kind: ContentKind) {}
  private get t(): any {
    return (this.db as any)[CONTENT_TABLES[this.kind].delegate];
  }
  private map = (r: Row): ContentRec<T> => ({
    id: r.id,
    key: r.key,
    data: r.doc as T,
    subjectKey: r.subjectKey,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  });
  private cols(w: ContentWrite<T>) {
    return { doc: json(w.data), subjectKey: w.subjectKey, searchText: w.searchText, ...CONTENT_TABLES[this.kind].columns(w.data) };
  }

  async list(filter: ContentFilter, p: PageReq): Promise<PageRes<ContentRec<T>>> {
    const after = decodeCursor(p.cursor);
    const q = filter.q?.toLocaleLowerCase();
    const rows = await this.t.findMany({
      where: {
        ...(filter.subjectKey ? { subjectKey: filter.subjectKey } : {}),
        ...(q ? { OR: [{ key: { contains: q } }, { searchText: { contains: q } }] } : {}),
        ...(after !== undefined ? { key: { gt: after } } : {}),
      },
      orderBy: { key: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows as Row[], p.limit, (r) => r.key);
    return { items: res.items.map(this.map), nextCursor: res.nextCursor };
  }
  async get(key: string) {
    const r = await this.t.findUnique({ where: { key } });
    return r ? this.map(r) : null;
  }
  async getMany(keys: readonly string[]) {
    if (!keys.length) return [];
    const rows: Row[] = await this.t.findMany({ where: { key: { in: [...new Set(keys)] } } });
    return inOrder(keys, rows, (r) => r.key).map(this.map);
  }
  async create(key: string, w: ContentWrite<T>, actor: Id | null) {
    const now = new Date();
    try {
      const r = await this.t.create({ data: { id: newId(), key, ...this.cols(w), version: 1, createdAt: now, updatedAt: now, updatedBy: actor } });
      return this.map(r);
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async update(key: string, w: ContentWrite<T>, expectedVersion: number | null, actor: Id | null): Promise<WriteResult<ContentRec<T>>> {
    const res = await this.t.updateMany({
      where: { key, ...(expectedVersion !== null ? { version: expectedVersion } : {}) },
      data: { ...this.cols(w), version: { increment: 1 }, updatedAt: new Date(), updatedBy: actor },
    });
    if (res.count === 0) return (await this.t.findUnique({ where: { key } })) ? 'version_mismatch' : 'not_found';
    return this.map(await this.t.findUnique({ where: { key } }));
  }
  async delete(key: string, expectedVersion: number | null): Promise<DeleteResult> {
    const res = await this.t.deleteMany({ where: { key, ...(expectedVersion !== null ? { version: expectedVersion } : {}) } });
    if (res.count) return 'ok';
    return (await this.t.findUnique({ where: { key } })) ? 'version_mismatch' : 'not_found';
  }
  async count(): Promise<number> {
    return this.t.count();
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const mapUser = (r: Row): UserRec => ({
  id: r.id,
  kind: r.kind,
  email: r.email,
  emailVerifiedAt: r.emailVerifiedAt,
  displayName: r.displayName,
  locale: r.locale,
  status: r.status,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt,
});
const mapCred = (r: Row): CredentialRec => ({ userId: r.userId, type: r.type, secretHash: r.secretHash, failedCount: r.failedCount, lockedUntil: r.lockedUntil, updatedAt: r.updatedAt });
const mapSession = (r: Row): SessionRec => ({
  id: r.id,
  userId: r.userId,
  refreshHash: r.refreshHash,
  family: r.family,
  audience: r.audience,
  device: r.device,
  ip: r.ip,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  replacedById: r.replacedById,
});
const mapGrant = (r: Row): GrantRec => ({ userId: r.userId, role: r.role, scope: r.scopeType, scopeId: r.scopeId === '' ? null : r.scopeId, subrole: r.subrole });
const mapAuthToken = (r: Row): AuthTokenRec => ({ id: r.id, userId: r.userId, purpose: r.purpose, tokenHash: r.tokenHash, expiresAt: r.expiresAt, usedAt: r.usedAt });
const mapInvite = (r: Row): InviteRec => ({
  id: r.id,
  email: r.email,
  role: r.role,
  scope: r.scopeType,
  scopeId: r.scopeId,
  subrole: r.subrole,
  tokenHash: r.tokenHash,
  invitedBy: r.invitedBy,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  acceptedAt: r.acceptedAt,
});
const mapSchool = (r: Row): SchoolRec => ({ id: r.id, name: r.name, region: r.region, type: r.type, language: r.language, status: r.status, createdAt: r.createdAt });
const mapLicense = (r: Row): LicenseRec => ({ id: r.id, schoolId: r.schoolId, subjects: r.subjects, grades: r.grades, seats: r.seats, startsAt: r.startsAt, endsAt: r.endsAt });
const mapClass = (r: Row): ClassRec => ({
  id: r.id,
  schoolId: r.schoolId,
  name: r.name,
  grade: r.grade,
  joinCode: r.joinCode,
  joinCodeEnabled: r.joinCodeEnabled,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  deletedAt: r.deletedAt,
});
const mapEnrollment = (r: Row): EnrollmentRec => ({ classId: r.classId, userId: r.userId, role: r.role, createdAt: r.createdAt });
const mapConsent = (r: Row): ConsentRec => ({ studentId: r.studentId, schoolId: r.schoolId, confirmedBy: r.confirmedBy, confirmedAt: r.confirmedAt });
const mapTopic = (r: Row): TopicRec => ({
  id: r.id,
  key: r.key,
  unitKey: r.unitKey,
  subjectKey: r.subjectKey,
  status: r.status,
  demo: r.demo,
  publishedVersionId: r.publishedVersionId,
  latestVersionId: r.latestVersionId,
  scheduledAt: r.scheduledAt,
  scheduledVersionId: r.scheduledVersionId,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt,
});
const mapVersion = (r: Row): TopicVersionRec => ({
  id: r.id,
  topicId: r.topicId,
  topicKey: r.topicKey,
  version: r.version,
  doc: r.doc,
  authorId: r.authorId,
  createdAt: r.createdAt,
  reviewState: r.reviewState,
  message: r.message,
});
const mapBuild = (r: Row): BuildRec => ({
  id: r.id,
  topicId: r.topicId,
  topicKey: r.topicKey,
  topicVersionId: r.topicVersionId,
  version: r.version,
  status: r.status,
  manifest: r.manifest ?? null,
  pkg: r.package ?? null,
  packageUrl: r.packageUrl,
  hash: r.hash,
  log: r.log,
  createdAt: r.createdAt,
});
function buildData(b: Partial<BuildRec>): Record<string, unknown> {
  const { pkg, manifest, ...rest } = b;
  return {
    ...rest,
    ...(manifest !== undefined ? { manifest: jsonOrNull(manifest) } : {}),
    ...(pkg !== undefined ? { package: jsonOrNull(pkg) } : {}),
  };
}
const mapAsset = (r: Row): AssetRec => ({
  id: r.id,
  key: r.key,
  kind: r.kind,
  filename: r.filename,
  contentType: r.contentType,
  license: r.license,
  author: r.author,
  source: r.source,
  status: r.status,
  sizeBytes: r.sizeBytes,
  sizeAfter: r.sizeAfter,
  triangles: r.triangles,
  nodes: r.nodes as string[],
  violations: r.violations as string[],
  originalUrl: r.originalUrl,
  optimizedUrl: r.optimizedUrl,
  thumbUrl: r.thumbUrl,
  uploadId: r.uploadId,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
});
function assetData(a: Partial<AssetRec>): Record<string, unknown> {
  return {
    ...a,
    ...(a.nodes !== undefined ? { nodes: json(a.nodes) } : {}),
    ...(a.violations !== undefined ? { violations: json(a.violations) } : {}),
  };
}
const mapString = (r: Row): LocaleStringRec => ({ key: r.key, locale: r.locale, value: r.value, status: r.status, sourceHash: r.sourceHash, updatedAt: r.updatedAt });
const mapProgress = (r: Row): ProgressRec => ({ userId: r.userId, topicKey: r.topicKey, visitedConcepts: r.visitedConcepts, completedActivities: r.completedActivities, updatedAt: r.updatedAt });
const mapAssignment = (r: Row): AssignmentRec => ({ id: r.id, classId: r.classId, topicKey: r.topicKey, activities: r.activities, dueAt: r.dueAt, createdBy: r.createdBy, createdAt: r.createdAt });
const mapAttempt = (r: Row): AttemptRec => ({
  id: r.id,
  userId: r.userId,
  clientId: r.clientId,
  assignmentId: r.assignmentId,
  topicKey: r.topicKey,
  topicVersion: r.topicVersion,
  topicVersionId: r.topicVersionId,
  seed: r.seed,
  itemKeys: r.itemKeys,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  score: r.score,
  source: r.source,
});
const mapAnswer = (r: Row): AnswerRec => ({ id: r.id, attemptId: r.attemptId, itemKey: r.itemKey, response: r.response, correct: r.correct, score: r.score, timeMs: r.timeMs, answeredAt: r.answeredAt });
const mapEvent = (r: Row): LearningEventRec => ({
  id: r.id,
  actor: r.actor,
  verb: r.verb,
  objectType: r.objectType,
  objectKey: r.objectKey,
  topicKey: r.topicKey,
  result: r.result ?? null,
  context: r.context ?? null,
  ts: r.ts,
  receivedAt: r.receivedAt,
});
const mapPresentation = (r: Row): PresentationRec => ({
  id: r.id,
  ownerId: r.ownerId,
  topicKey: r.topicKey,
  title: r.title,
  lang: r.lang,
  slides: r.slides as unknown[],
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const mapSnapshot = (r: Row): SnapshotRec => ({
  id: r.id,
  ownerId: r.ownerId,
  topicKey: r.topicKey,
  topicVersion: r.topicVersion,
  imageKey: r.imageKey,
  imageUrl: r.imageUrl,
  sceneState: r.sceneState,
  createdAt: r.createdAt,
});
const mapThread = (r: Row): TutorThreadRec => ({ id: r.id, userId: r.userId, topicKey: r.topicKey, createdAt: r.createdAt });
const mapMessage = (r: Row): TutorMessageRec => ({
  id: r.id,
  threadId: r.threadId,
  role: r.role,
  text: r.text,
  citations: r.citations,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  flagged: r.flagged,
  topicKey: r.topicKey,
  schoolId: r.schoolId,
  createdAt: r.createdAt,
});
const mapAudit = (r: Row): AuditRec => ({ id: r.id, actorId: r.actorId, action: r.action, targetType: r.targetType, targetId: r.targetId, diff: r.diff ?? null, ip: r.ip, ts: r.ts });
const mapSetting = (r: Row): SettingRec => ({ key: r.key, value: r.value, version: r.version, updatedAt: r.updatedAt });

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PrismaRepository implements Repository {
  readonly kind = 'prisma' as const;
  private stores = new Map<ContentKind, PrismaContentStore<unknown>>();

  constructor(readonly db: PrismaClient) {}

  async ping() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    await this.db.$disconnect();
  }

  // --- identity -------------------------------------------------------------
  async createUser(u: Omit<UserRec, 'createdAt' | 'updatedAt' | 'deletedAt'>) {
    const now = new Date();
    try {
      return mapUser(await this.db.user.create({ data: { ...u, createdAt: now, updatedAt: now, deletedAt: null } }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async getUser(id: Id) {
    const r = await this.db.user.findUnique({ where: { id } });
    return r ? mapUser(r) : null;
  }
  async getUserByEmail(email: string) {
    const r = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    return r ? mapUser(r) : null;
  }
  async updateUser(id: Id, patch: Partial<UserRec>) {
    const { id: _i, createdAt: _c, ...data } = patch;
    try {
      return mapUser(await this.db.user.update({ where: { id }, data: { ...data, updatedAt: new Date() } }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async listUsers(filter: { q?: string; ids?: Id[]; status?: UserRec['status'] }, p: PageReq) {
    const q = filter.q?.toLocaleLowerCase();
    const rows = await this.db.user.findMany({
      where: {
        deletedAt: null,
        ...idWhere(p, filter.ids),
        ...(filter.status ? { status: filter.status } : {}),
        ...(q ? { OR: [{ displayName: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q } }] } : {}),
      },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapUser), nextCursor: res.nextCursor };
  }
  async getUsers(ids: readonly Id[]) {
    if (!ids.length) return [];
    const rows = await this.db.user.findMany({ where: { id: { in: [...new Set(ids)] } } });
    return inOrder(ids, rows, (r) => r.id).map(mapUser);
  }

  async getCredential(userId: Id, type: CredentialType) {
    const r = await this.db.credential.findUnique({ where: { userId_type: { userId, type } } });
    return r ? mapCred(r) : null;
  }
  async setCredential(userId: Id, type: CredentialType, secretHash: string) {
    const data = { secretHash, failedCount: 0, lockedUntil: null, updatedAt: new Date() };
    await this.db.credential.upsert({ where: { userId_type: { userId, type } }, create: { userId, type, ...data }, update: data });
  }
  async updateCredential(userId: Id, type: CredentialType, patch: Partial<CredentialRec>) {
    const data = {
      ...(patch.failedCount !== undefined ? { failedCount: patch.failedCount } : {}),
      ...(patch.lockedUntil !== undefined ? { lockedUntil: patch.lockedUntil } : {}),
    };
    await this.db.credential.updateMany({ where: { userId, type }, data: { ...data, updatedAt: new Date() } });
  }
  async deleteCredential(userId: Id, type: CredentialType) {
    await this.db.credential.deleteMany({ where: { userId, type } });
  }

  async listGrants(userId: Id) {
    return (await this.db.roleAssignment.findMany({ where: { userId }, orderBy: { id: 'asc' } })).map(mapGrant);
  }
  async listGrantsByScope(scope: GrantRec['scope'], scopeId: string) {
    return (await this.db.roleAssignment.findMany({ where: { scopeType: scope, scopeId }, orderBy: { id: 'asc' } })).map(mapGrant);
  }
  async setGrants(userId: Id, grants: Omit<GrantRec, 'userId'>[]) {
    await this.db.$transaction(async (tx) => {
      await tx.roleAssignment.deleteMany({ where: { userId } });
      for (const g of grants) {
        await tx.roleAssignment.deleteMany({ where: { userId, role: g.role, scopeType: g.scope, scopeId: g.scopeId ?? '' } });
        await tx.roleAssignment.create({ data: { id: newId(), userId, role: g.role, scopeType: g.scope, scopeId: g.scopeId ?? '', subrole: g.subrole } });
      }
    });
  }
  async addGrant(g: GrantRec) {
    // Same identity replaces (and moves to the end, like the memory implementation).
    await this.db.$transaction([
      this.db.roleAssignment.deleteMany({ where: { userId: g.userId, role: g.role, scopeType: g.scope, scopeId: g.scopeId ?? '' } }),
      this.db.roleAssignment.create({ data: { id: newId(), userId: g.userId, role: g.role, scopeType: g.scope, scopeId: g.scopeId ?? '', subrole: g.subrole } }),
    ]);
  }

  async createSession(s: SessionRec) {
    await this.db.session.create({ data: s });
  }
  async getSession(id: Id) {
    const r = await this.db.session.findUnique({ where: { id } });
    return r ? mapSession(r) : null;
  }
  async getSessionByRefreshHash(hash: string) {
    const r = await this.db.session.findUnique({ where: { refreshHash: hash } });
    return r ? mapSession(r) : null;
  }
  async rotateSession(oldId: Id, next: SessionRec, at: Date) {
    return this.db.$transaction(async (tx) => {
      const res = await tx.session.updateMany({ where: { id: oldId, revokedAt: null, replacedById: null }, data: { revokedAt: at, replacedById: next.id } });
      if (res.count !== 1) return false;
      await tx.session.create({ data: next });
      return true;
    });
  }
  async revokeSession(id: Id, at: Date) {
    await this.db.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
  }
  async revokeFamily(family: Id, at: Date) {
    return (await this.db.session.updateMany({ where: { family, revokedAt: null }, data: { revokedAt: at } })).count;
  }
  async revokeUserSessions(userId: Id, at: Date) {
    return (await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } })).count;
  }
  async listActiveSessions(userId: Id, now: Date) {
    return (await this.db.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: now } }, orderBy: { id: 'asc' } })).map(mapSession);
  }

  async createAuthToken(t: AuthTokenRec) {
    await this.db.authToken.create({ data: t });
  }
  async consumeAuthToken(tokenHash: string, purpose: AuthTokenRec['purpose'], now: Date) {
    const res = await this.db.authToken.updateMany({ where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (res.count !== 1) return null;
    const r = await this.db.authToken.findUnique({ where: { tokenHash } });
    return r ? mapAuthToken(r) : null;
  }

  async createInvite(i: InviteRec) {
    const { scope, ...rest } = i;
    await this.db.invite.create({ data: { ...rest, scopeType: scope } });
  }
  async getInviteByHash(tokenHash: string) {
    const r = await this.db.invite.findUnique({ where: { tokenHash } });
    return r ? mapInvite(r) : null;
  }
  async markInviteAccepted(id: Id, at: Date) {
    return (await this.db.invite.updateMany({ where: { id, acceptedAt: null }, data: { acceptedAt: at } })).count === 1;
  }
  async listInvites(filter: { scope?: InviteRec['scope']; scopeIds?: string[] }, p: PageReq) {
    const rows = await this.db.invite.findMany({
      where: { ...idWhere(p), ...(filter.scope ? { scopeType: filter.scope } : {}), ...(filter.scopeIds ? { scopeId: { in: filter.scopeIds } } : {}) },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapInvite), nextCursor: res.nextCursor };
  }

  async createSchool(s: SchoolRec) {
    await this.db.school.create({ data: s });
  }
  async getSchool(id: Id) {
    const r = await this.db.school.findUnique({ where: { id } });
    return r ? mapSchool(r) : null;
  }
  async updateSchool(id: Id, patch: Partial<SchoolRec>) {
    const { id: _i, createdAt: _c, ...data } = patch;
    try {
      return mapSchool(await this.db.school.update({ where: { id }, data }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async listSchools(filter: { ids?: Id[] }, p: PageReq) {
    const rows = await this.db.school.findMany({ where: idWhere(p, filter.ids), orderBy: { id: 'asc' }, take: p.limit + 1 });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapSchool), nextCursor: res.nextCursor };
  }

  async createLicense(l: LicenseRec) {
    try {
      return mapLicense(await this.db.license.create({ data: l }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async getLicense(id: Id) {
    const r = await this.db.license.findUnique({ where: { id } });
    return r ? mapLicense(r) : null;
  }
  async updateLicense(id: Id, patch: Partial<LicenseRec>) {
    const { id: _i, schoolId: _s, ...data } = patch;
    try {
      return mapLicense(await this.db.license.update({ where: { id }, data }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async deleteLicense(id: Id) {
    return (await this.db.license.deleteMany({ where: { id } })).count > 0;
  }
  async listLicenses(filter: { schoolIds?: Id[] }, p: PageReq) {
    const rows = await this.db.license.findMany({
      where: { ...idWhere(p), ...(filter.schoolIds ? { schoolId: { in: filter.schoolIds } } : {}) },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapLicense), nextCursor: res.nextCursor };
  }

  async createClass(c: ClassRec) {
    try {
      return mapClass(await this.db.class.create({ data: c }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async getClass(id: Id) {
    const r = await this.db.class.findFirst({ where: { id, deletedAt: null } });
    return r ? mapClass(r) : null;
  }
  async getClassByJoinCode(code: string) {
    const r = await this.db.class.findFirst({ where: { joinCode: code, deletedAt: null } });
    return r ? mapClass(r) : null;
  }
  async updateClass(id: Id, patch: Partial<ClassRec>) {
    const { id: _i, ...data } = patch;
    try {
      return mapClass(await this.db.class.update({ where: { id }, data }));
    } catch (e) {
      if (isNotFound(e)) return null;
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async listClasses(filter: { ids?: Id[]; schoolIds?: Id[] }, p: PageReq) {
    const rows = await this.db.class.findMany({
      where: { deletedAt: null, ...idWhere(p, filter.ids), ...(filter.schoolIds ? { schoolId: { in: filter.schoolIds } } : {}) },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapClass), nextCursor: res.nextCursor };
  }

  async addEnrollment(e: Omit<EnrollmentRec, 'createdAt'>) {
    await this.db.enrollment.createMany({ data: [{ ...e, createdAt: new Date() }], skipDuplicates: true });
  }
  async removeEnrollment(classId: Id, userId: Id) {
    await this.db.enrollment.deleteMany({ where: { classId, userId } });
  }
  async listEnrollments(filter: { classId?: Id; classIds?: Id[]; userId?: Id; role?: 'student' | 'teacher' }) {
    const and: Record<string, unknown>[] = [];
    if (filter.classId) and.push({ classId: filter.classId });
    if (filter.classIds) and.push({ classId: { in: filter.classIds } });
    if (filter.userId) and.push({ userId: filter.userId });
    if (filter.role) and.push({ role: filter.role });
    const rows = await this.db.enrollment.findMany({ where: and.length ? { AND: and } : {}, orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }] });
    return rows.map(mapEnrollment);
  }

  async setConsent(c: ConsentRec | { studentId: Id; remove: true }) {
    if ('remove' in c) await this.db.consentRecord.deleteMany({ where: { studentId: c.studentId } });
    else await this.db.consentRecord.upsert({ where: { studentId: c.studentId }, create: c, update: c });
  }
  async listConsents(studentIds: readonly Id[]) {
    if (!studentIds.length) return [];
    const rows = await this.db.consentRecord.findMany({ where: { studentId: { in: [...new Set(studentIds)] } } });
    return inOrder(studentIds, rows, (r) => r.studentId).map(mapConsent);
  }

  // --- content --------------------------------------------------------------
  content<K extends ContentKind>(kind: K): ContentStore<ContentKinds[K]> {
    let s = this.stores.get(kind);
    if (!s) {
      s = new PrismaContentStore<unknown>(this.db, kind);
      this.stores.set(kind, s);
    }
    return s as unknown as ContentStore<ContentKinds[K]>;
  }

  async createTopic(t: Omit<TopicRec, 'createdAt' | 'updatedAt' | 'deletedAt' | 'version'>) {
    const now = new Date();
    try {
      return mapTopic(await this.db.topic.create({ data: { ...t, version: 1, createdAt: now, updatedAt: now, deletedAt: null } }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async getTopic(id: Id) {
    const r = await this.db.topic.findFirst({ where: { id, deletedAt: null } });
    return r ? mapTopic(r) : null;
  }
  async getTopicByKey(key: string) {
    const r = await this.db.topic.findFirst({ where: { key, deletedAt: null } });
    return r ? mapTopic(r) : null;
  }
  async updateTopic(id: Id, patch: Partial<TopicRec>, expectedVersion: number | null): Promise<WriteResult<TopicRec>> {
    const { id: _i, version: _v, createdAt: _c, updatedAt: _u, key: _k, ...data } = patch;
    const res = await this.db.topic.updateMany({
      where: { id, deletedAt: null, ...(expectedVersion !== null ? { version: expectedVersion } : {}) },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (res.count === 0) return (await this.db.topic.findFirst({ where: { id, deletedAt: null } })) ? 'version_mismatch' : 'not_found';
    return mapTopic(await this.db.topic.findUniqueOrThrow({ where: { id } }));
  }
  async listTopics(filter: { q?: string; subjectKey?: string; status?: TopicRec['status']; scheduledBefore?: Date }, p: PageReq) {
    const after = decodeCursor(p.cursor);
    const q = filter.q?.toLocaleLowerCase();
    const keyCond = { ...(q ? { contains: q } : {}), ...(after !== undefined ? { gt: after } : {}) };
    const rows = await this.db.topic.findMany({
      where: {
        deletedAt: null,
        ...(filter.subjectKey ? { subjectKey: filter.subjectKey } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.scheduledBefore ? { scheduledAt: { lte: filter.scheduledBefore } } : {}),
        ...(Object.keys(keyCond).length ? { key: keyCond } : {}),
      },
      orderBy: { key: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.key);
    return { items: res.items.map(mapTopic), nextCursor: res.nextCursor };
  }

  async createTopicVersion(v: TopicVersionRec) {
    try {
      return mapVersion(await this.db.topicVersion.create({ data: { ...v, doc: json(v.doc) } }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async getTopicVersion(id: Id) {
    const r = await this.db.topicVersion.findUnique({ where: { id } });
    return r ? mapVersion(r) : null;
  }
  async getTopicVersionBySemver(topicId: Id, version: string) {
    const r = await this.db.topicVersion.findUnique({ where: { topicId_version: { topicId, version } } });
    return r ? mapVersion(r) : null;
  }
  async listTopicVersions(topicId: Id) {
    return (await this.db.topicVersion.findMany({ where: { topicId }, orderBy: { id: 'asc' } })).map(mapVersion);
  }
  async updateTopicVersion(id: Id, patch: Partial<TopicVersionRec>) {
    const data = {
      ...(patch.reviewState !== undefined ? { reviewState: patch.reviewState } : {}),
      ...(patch.doc !== undefined ? { doc: json(patch.doc) } : {}),
    };
    try {
      return mapVersion(await this.db.topicVersion.update({ where: { id }, data }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async topicsUsingConcept(conceptKey: string) {
    const rows = await this.db.$queryRaw<{ topicKey: string }[]>`
      SELECT DISTINCT v."topicKey" AS "topicKey"
      FROM "TopicVersion" v JOIN "Topic" t ON t.id = v."topicId"
      WHERE t."deletedAt" IS NULL AND (
        (v.doc->'conceptKeys') ? ${conceptKey}
        OR (v.doc->'overrides') ? ${conceptKey}
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(v.doc->'activities'->'comparison'->'columns', '[]'::jsonb)) c
          WHERE c->>'kind' = 'concept' AND c->>'key' = ${conceptKey})
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(v.doc->'activities'->'tour'->'steps', '[]'::jsonb)) s
          WHERE s->>'focus' = ${conceptKey}
             OR COALESCE(s->'visibility'->'isolate', '[]'::jsonb) ? ${conceptKey}
             OR COALESCE(s->'visibility'->'hide', '[]'::jsonb) ? ${conceptKey})
      )`;
    return rows.map((r) => r.topicKey).sort();
  }

  async createBuild(b: BuildRec) {
    await this.db.build.create({ data: buildData(b) as Prisma.BuildUncheckedCreateInput });
  }
  async updateBuild(id: Id, patch: Partial<BuildRec>) {
    const { id: _i, ...rest } = patch;
    try {
      return mapBuild(await this.db.build.update({ where: { id }, data: buildData(rest) as Prisma.BuildUncheckedUpdateInput }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async getBuild(id: Id) {
    const r = await this.db.build.findUnique({ where: { id } });
    return r ? mapBuild(r) : null;
  }
  async readyBuildForVersion(topicVersionId: Id) {
    const r = await this.db.build.findFirst({ where: { topicVersionId, status: 'ready' }, orderBy: { id: 'desc' } });
    return r ? mapBuild(r) : null;
  }
  async listBuilds(filter: { topicKey?: string }, p: PageReq) {
    const rows = await this.db.build.findMany({
      where: { ...idWhere(p), ...(filter.topicKey ? { topicKey: filter.topicKey } : {}) },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapBuild), nextCursor: res.nextCursor };
  }
  async listPublished(): Promise<PublishedRec[]> {
    const topics = (await this.db.topic.findMany({ where: { deletedAt: null, publishedVersionId: { not: null } }, orderBy: { key: 'asc' } })).map(mapTopic);
    if (!topics.length) return [];
    const builds = await this.db.build.findMany({
      where: { status: 'ready', topicVersionId: { in: topics.map((t) => t.publishedVersionId!) } },
      orderBy: { id: 'asc' },
    });
    const latest = new Map<string, BuildRec>();
    for (const b of builds) latest.set(b.topicVersionId, mapBuild(b));
    const out: PublishedRec[] = [];
    for (const t of topics) {
      const b = latest.get(t.publishedVersionId!);
      if (b?.manifest && b.pkg) out.push({ topic: t, build: b as PublishedRec['build'] });
    }
    return out;
  }

  async createAsset(a: AssetRec) {
    await this.db.asset.create({ data: assetData(a) as Prisma.AssetUncheckedCreateInput });
  }
  async getAsset(id: Id) {
    const r = await this.db.asset.findUnique({ where: { id } });
    return r ? mapAsset(r) : null;
  }
  async updateAsset(id: Id, patch: Partial<AssetRec>) {
    const { id: _i, ...rest } = patch;
    try {
      return mapAsset(await this.db.asset.update({ where: { id }, data: assetData(rest) as Prisma.AssetUncheckedUpdateInput }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async listAssets(p: PageReq) {
    const rows = await this.db.asset.findMany({ where: idWhere(p), orderBy: { id: 'asc' }, take: p.limit + 1 });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapAsset), nextCursor: res.nextCursor };
  }

  // Strings: ordered by (key, locale); the cursor is key + U+0000 + locale (as in memory).
  async listStrings(filter: { locale?: LocaleStringRec['locale']; status?: LocaleStringRec['status']; keyPrefix?: string }, p: PageReq) {
    const after = decodeCursor(p.cursor);
    const and: Record<string, unknown>[] = [];
    if (filter.locale) and.push({ locale: filter.locale });
    if (filter.status) and.push({ status: filter.status });
    if (filter.keyPrefix) and.push({ key: { startsWith: filter.keyPrefix } });
    if (after !== undefined) {
      const [k, l = ''] = after.split('\u0000');
      and.push({ OR: [{ key: { gt: k } }, { key: k, locale: { gt: l } }] });
    }
    const rows = await this.db.localeString.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: [{ key: 'asc' }, { locale: 'asc' }],
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => `${r.key}\u0000${r.locale}`);
    return { items: res.items.map(mapString), nextCursor: res.nextCursor };
  }
  async getStrings(keys: readonly string[]) {
    if (!keys.length) return [];
    return (await this.db.localeString.findMany({ where: { key: { in: [...new Set(keys)] } }, orderBy: [{ key: 'asc' }, { locale: 'asc' }] })).map(mapString);
  }
  async upsertStrings(rows: readonly LocaleStringRec[]) {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await this.db.$transaction(
        chunk.map((r) =>
          this.db.localeString.upsert({
            where: { key_locale: { key: r.key, locale: r.locale } },
            create: r,
            update: { value: r.value, status: r.status, sourceHash: r.sourceHash, updatedAt: r.updatedAt },
          }),
        ),
      );
    }
  }

  async createReviewComment(c: ReviewCommentRec) {
    await this.db.reviewComment.create({ data: c });
  }

  // --- learning ---------------------------------------------------------------
  async getProgress(userId: Id, topicKey: string) {
    const r = await this.db.progress.findUnique({ where: { userId_topicKey: { userId, topicKey } } });
    return r ? mapProgress(r) : null;
  }
  async putProgress(p: ProgressRec) {
    await this.db.progress.upsert({ where: { userId_topicKey: { userId: p.userId, topicKey: p.topicKey } }, create: p, update: p });
  }

  async createAssignment(a: AssignmentRec) {
    await this.db.assignment.create({ data: a });
  }
  async getAssignment(id: Id) {
    const r = await this.db.assignment.findUnique({ where: { id } });
    return r ? mapAssignment(r) : null;
  }
  async listAssignments(filter: { classIds: Id[] }, p: PageReq) {
    const rows = await this.db.assignment.findMany({ where: { ...idWhere(p), classId: { in: filter.classIds } }, orderBy: { id: 'asc' }, take: p.limit + 1 });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapAssignment), nextCursor: res.nextCursor };
  }

  async createAttempt(a: AttemptRec) {
    try {
      return mapAttempt(await this.db.attempt.create({ data: a }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async getAttempt(id: Id) {
    const r = await this.db.attempt.findUnique({ where: { id } });
    return r ? mapAttempt(r) : null;
  }
  async getAttemptByClientId(userId: Id, clientId: Id) {
    const r = await this.db.attempt.findUnique({ where: { userId_clientId: { userId, clientId } } });
    return r ? mapAttempt(r) : null;
  }
  async updateAttempt(id: Id, patch: Partial<AttemptRec>) {
    const data = {
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.score !== undefined ? { score: patch.score } : {}),
    };
    try {
      return mapAttempt(await this.db.attempt.update({ where: { id }, data }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async listAttempts(filter: { userId?: Id; userIds?: Id[]; assignmentId?: Id; from?: Date; to?: Date }) {
    const and: Record<string, unknown>[] = [];
    if (filter.userId) and.push({ userId: filter.userId });
    if (filter.userIds) and.push({ userId: { in: filter.userIds } });
    if (filter.assignmentId) and.push({ assignmentId: filter.assignmentId });
    const r = range(filter.from, filter.to);
    if (r) and.push({ startedAt: r });
    return (await this.db.attempt.findMany({ where: and.length ? { AND: and } : {}, orderBy: { id: 'asc' } })).map(mapAttempt);
  }

  async createAnswer(a: AnswerRec) {
    try {
      return mapAnswer(await this.db.answer.create({ data: { ...a, response: json(a.response) } }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async listAnswers(filter: { attemptIds?: Id[]; itemKey?: string }) {
    const rows = await this.db.answer.findMany({
      where: { ...(filter.attemptIds ? { attemptId: { in: filter.attemptIds } } : {}), ...(filter.itemKey ? { itemKey: filter.itemKey } : {}) },
      orderBy: { id: 'asc' },
    });
    return rows.map(mapAnswer);
  }

  async insertEvents(events: readonly LearningEventRec[]) {
    if (!events.length) return { accepted: 0, duplicates: 0 };
    const res = await this.db.learningEvent.createMany({
      data: events.map((e) => ({ ...e, result: jsonOrNull(e.result), context: jsonOrNull(e.context) })),
      skipDuplicates: true,
    });
    return { accepted: res.count, duplicates: events.length - res.count };
  }
  async listEvents(filter: { from?: Date; to?: Date }) {
    const r = range(filter.from, filter.to);
    const rows = await this.db.learningEvent.findMany({ where: r ? { ts: r } : {}, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] });
    return rows.map(mapEvent);
  }

  async getIdempotency(userId: Id, key: string) {
    const r = await this.db.idempotencyRecord.findUnique({ where: { userId_key: { userId, key } } });
    return r ? { userId: r.userId, key: r.key, requestHash: r.requestHash, response: r.response as unknown, createdAt: r.createdAt } : null;
  }
  async putIdempotency(r: IdempotencyRec) {
    try {
      await this.db.idempotencyRecord.create({ data: { ...r, response: json(r.response) } });
      return true;
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
  }

  // --- decks ------------------------------------------------------------------
  async createPresentation(p: PresentationRec) {
    await this.db.presentation.create({ data: { ...p, slides: json(p.slides) } });
  }
  async getPresentation(id: Id) {
    const r = await this.db.presentation.findUnique({ where: { id } });
    return r ? mapPresentation(r) : null;
  }
  async updatePresentation(id: Id, patch: Partial<PresentationRec>, expectedVersion: number): Promise<WriteResult<PresentationRec>> {
    const data = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.slides !== undefined ? { slides: json(patch.slides) } : {}),
    };
    const res = await this.db.presentation.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 }, updatedAt: new Date() } });
    if (res.count === 0) return (await this.db.presentation.findUnique({ where: { id } })) ? 'version_mismatch' : 'not_found';
    return mapPresentation(await this.db.presentation.findUniqueOrThrow({ where: { id } }));
  }
  async deletePresentation(id: Id) {
    return (await this.db.presentation.deleteMany({ where: { id } })).count > 0;
  }
  async listPresentations(ownerId: Id, p: PageReq) {
    const rows = await this.db.presentation.findMany({ where: { ...idWhere(p), ownerId }, orderBy: { id: 'asc' }, take: p.limit + 1 });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapPresentation), nextCursor: res.nextCursor };
  }
  async createSnapshot(s: SnapshotRec) {
    await this.db.snapshot.create({ data: { ...s, sceneState: json(s.sceneState) } });
  }
  async getSnapshot(id: Id) {
    const r = await this.db.snapshot.findUnique({ where: { id } });
    return r ? mapSnapshot(r) : null;
  }
  async getSnapshots(ids: readonly Id[]) {
    if (!ids.length) return [];
    const rows = await this.db.snapshot.findMany({ where: { id: { in: [...new Set(ids)] } } });
    return inOrder(ids, rows, (r) => r.id).map(mapSnapshot);
  }

  // --- tutor --------------------------------------------------------------------
  async createThread(t: TutorThreadRec) {
    await this.db.tutorThread.create({ data: t });
  }
  async getThread(id: Id) {
    const r = await this.db.tutorThread.findUnique({ where: { id } });
    return r ? mapThread(r) : null;
  }
  async addTutorMessage(m: TutorMessageRec) {
    await this.db.tutorMessage.create({ data: m });
  }
  async listTutorMessages(filter: { threadId?: Id; from?: Date; to?: Date; limit?: number }) {
    const r = range(filter.from, filter.to);
    const where = { ...(filter.threadId ? { threadId: filter.threadId } : {}), ...(r ? { createdAt: r } : {}) };
    if (filter.limit) {
      const rows = await this.db.tutorMessage.findMany({ where, orderBy: { id: 'desc' }, take: filter.limit });
      return rows.reverse().map(mapMessage);
    }
    return (await this.db.tutorMessage.findMany({ where, orderBy: { id: 'asc' } })).map(mapMessage);
  }

  // --- audit & settings -----------------------------------------------------------
  async appendAudit(a: AuditRec) {
    await this.db.auditLog.create({ data: { ...a, diff: jsonOrNull(a.diff) } });
  }
  async listAudit(filter: { actorId?: Id; action?: string; targetType?: string }, p: PageReq) {
    const rows = await this.db.auditLog.findMany({
      where: {
        ...idWhere(p),
        ...(filter.actorId ? { actorId: filter.actorId } : {}),
        ...(filter.action ? { action: filter.action } : {}),
        ...(filter.targetType ? { targetType: filter.targetType } : {}),
      },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapAudit), nextCursor: res.nextCursor };
  }
  async getSetting(key: string) {
    const r = await this.db.setting.findUnique({ where: { key } });
    return r ? mapSetting(r) : null;
  }
  async putSetting(key: string, value: unknown, expectedVersion: number | null): Promise<WriteResult<SettingRec>> {
    const now = new Date();
    if (expectedVersion === null) {
      return mapSetting(
        await this.db.setting.upsert({
          where: { key },
          create: { key, value: json(value), version: 1, updatedAt: now },
          update: { value: json(value), version: { increment: 1 }, updatedAt: now },
        }),
      );
    }
    if (expectedVersion === 0) {
      // Memory semantics: version 0 means "no row yet".
      try {
        return mapSetting(await this.db.setting.create({ data: { key, value: json(value), version: 1, updatedAt: now } }));
      } catch (e) {
        if (isUnique(e)) return 'version_mismatch';
        throw e;
      }
    }
    const res = await this.db.setting.updateMany({ where: { key, version: expectedVersion }, data: { value: json(value), version: { increment: 1 }, updatedAt: now } });
    if (res.count === 0) return (await this.db.setting.findUnique({ where: { key } })) ? 'version_mismatch' : 'not_found';
    return mapSetting(await this.db.setting.findUniqueOrThrow({ where: { key } }));
  }

  async purgeDeleted(before: Date) {
    // FK cascades remove credentials, sessions, grants, auth tokens, enrollments and consent.
    const users = await this.db.user.deleteMany({ where: { deletedAt: { lt: before } } });
    const classes = await this.db.class.deleteMany({ where: { deletedAt: { lt: before } } });
    return { users: users.count, classes: classes.count };
  }
}

export async function createPrismaRepository(url: string): Promise<Repository> {
  const db = new PrismaClient({ datasources: { db: { url } } });
  await db.$connect();
  return new PrismaRepository(db);
}
