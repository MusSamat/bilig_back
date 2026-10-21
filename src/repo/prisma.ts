/**
 * PrismaRepository — the PostgreSQL 16 implementation of Repository (TZ §8).
 * Semantics mirror MemoryRepository exactly; both pass src/repo/repo.contract.ts.
 * Atomic operations (refresh rotation, single-use tokens, optimistic versions)
 * are conditional `updateMany` calls whose affected-row count decides the outcome.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { decodeCursor, encodeCursor } from './paging.js';
import { newId } from '../ids.js';
import { eventToLegacy, legacyToEvent } from '../domain/journal.js';
import { classSubjects } from './class-subjects.js';
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
  SignupRec,
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
  GeneratedFilter,
  GeneratedRec,
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
  textbook: { delegate: 'textbook', columns: (d) => ({ grade: d.grade ?? null, order: d.order ?? 0 }) },
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
  async getById(id: Id) {
    const r = await this.t.findUnique({ where: { id } });
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
  signup: (r.signup as SignupRec | null) ?? null,
  phone: r.phone ?? null,
  phoneVerifiedAt: r.phoneVerifiedAt ?? null,
  teachingLang: r.teachingLang ?? null,
  lastLoginAt: r.lastLoginAt ?? null,
});
const mapPhoneOtp = (r: Row): PhoneOtpRec => ({
  id: r.id,
  phone: r.phone,
  purpose: r.purpose,
  kind: r.kind,
  hash: r.hash,
  locale: r.locale,
  attempts: r.attempts,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  usedAt: r.usedAt,
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
const mapAuthToken = (r: Row): AuthTokenRec => ({ id: r.id, userId: r.userId, purpose: r.purpose, tokenHash: r.tokenHash, expiresAt: r.expiresAt, usedAt: r.usedAt, attempts: r.attempts });
const mapInvite = (r: Row): InviteRec => ({
  id: r.id,
  email: r.email,
  role: r.role,
  scope: r.scopeType,
  scopeId: r.scopeId,
  subrole: r.subrole,
  permissions: r.permissions ?? [],
  tokenHash: r.tokenHash,
  invitedBy: r.invitedBy,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  acceptedAt: r.acceptedAt,
  revokedAt: r.revokedAt,
});
const mapSchool = (r: Row): SchoolRec => ({ id: r.id, name: r.name, region: r.region, type: r.type, language: r.language, status: r.status, origin: r.origin, createdAt: r.createdAt, version: r.version });
const mapLicense = (r: Row): LicenseRec => ({ id: r.id, schoolId: r.schoolId, subjects: r.subjects, grades: r.grades, seats: r.seats, startsAt: r.startsAt, endsAt: r.endsAt, version: r.version });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapBook = (r: any): BookRec => ({
  id: r.id,
  title: r.title,
  subjectKey: r.subjectKey,
  grade: r.grade,
  lang: r.lang,
  part: r.part ?? null,
  authors: r.authors ?? [],
  publisher: r.publisher ?? '',
  year: r.year ?? null,
  summary: r.summary ?? '',
  status: r.status,
  stage: r.stage,
  progressDone: r.progressDone,
  progressTotal: r.progressTotal,
  error: r.error ?? null,
  pageCount: r.pageCount,
  fileName: r.fileName,
  coverKey: r.coverKey ?? null,
  contents: r.contents ?? null,
  usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, ...((r.usage ?? {}) as object) },
  leaseUntil: r.leaseUntil ?? null,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  publishedAt: r.publishedAt ?? null,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapSection = (r: any): BookSectionRec => ({
  id: r.id,
  bookId: r.bookId,
  order: r.order,
  chapterNumber: r.chapterNumber,
  chapterTitle: r.chapterTitle,
  number: r.number,
  kind: r.kind,
  title: r.title,
  pageFrom: r.pageFrom ?? null,
  pageTo: r.pageTo ?? null,
  info: (r.info ?? null) as Record<string, unknown> | null,
  topicKey: r.topicKey ?? null,
  reviewed: r.reviewed,
});

const mapClass = (r: Row): ClassRec => ({
  id: r.id,
  schoolId: r.schoolId,
  name: r.name,
  grade: r.grade,
  joinCode: r.joinCode,
  joinCodeEnabled: r.joinCodeEnabled,
  subjectKey: r.subjectKey ?? null,
  subjectKeys: r.subjectKeys ?? [],
  books: (r.books ?? {}) as Record<string, string>,
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
  updatedBy: r.updatedBy ?? null,
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
  version: r.version,
});
const mapAssetVersion = (r: Row): AssetVersionRec => ({
  assetId: r.assetId,
  version: r.version,
  filename: r.filename,
  contentType: r.contentType,
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
  message: r.message,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  completedAt: r.completedAt,
});
const mapComment = (r: Row): ReviewCommentRec => ({
  id: r.id,
  targetType: r.targetType,
  targetId: r.targetId,
  path: r.path,
  body: r.body,
  authorId: r.authorId,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
  anchor3d: (r.anchor3d as [number, number, number] | null) ?? null,
  resolvedBy: r.resolvedBy,
  topicVersion: r.topicVersion,
});
function assetData(a: Partial<AssetRec>): Record<string, unknown> {
  return {
    ...a,
    ...(a.nodes !== undefined ? { nodes: json(a.nodes) } : {}),
    ...(a.violations !== undefined ? { violations: json(a.violations) } : {}),
  };
}
const mapString = (r: Row): LocaleStringRec => ({ key: r.key, locale: r.locale, value: r.value, status: r.status, sourceHash: r.sourceHash, updatedAt: r.updatedAt, version: r.version });
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
const mapTeachingPlan = (r: Row): TeachingPlanRec => ({
  id: r.id,
  ownerId: r.ownerId,
  title: r.title,
  doc: r.doc,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
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
const mapGenerated = (r: Row): GeneratedRec => ({
  id: r.id,
  kind: r.kind,
  topicKey: r.topicKey,
  conceptKey: r.conceptKey,
  lang: r.lang,
  payload: r.payload,
  signature: r.signature,
  status: r.status,
  good: r.good,
  bad: r.bad,
  reasons: (r.reasons ?? {}) as Record<string, number>,
  served: r.served,
  createdAt: r.createdAt,
  reviewedAt: r.reviewedAt,
  reviewedBy: r.reviewedBy,
  promotedTo: r.promotedTo,
});
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
const mapJournalEvent = (r: Row): AuditEventRec => ({
  seq: Number(r.seq),
  id: r.id,
  at: r.at,
  actorId: r.actorId ?? null,
  actorRole: r.actorRole ?? null,
  onBehalfOfId: r.onBehalfOfId ?? null,
  group: r.group,
  action: r.action,
  targetType: r.targetType,
  targetId: r.targetId,
  targetLabel: r.targetLabel ?? null,
  before: r.before ?? null,
  after: r.after ?? null,
  details: r.details ?? null,
  reason: r.reason ?? null,
  result: r.result,
  ip: r.ip ?? null,
  userAgent: r.userAgent ?? null,
  requestId: r.requestId ?? null,
  supportSessionId: r.supportSessionId ?? null,
  prevHash: r.prevHash,
  hash: r.hash,
});
const mapStaff = (r: Row): StaffProfileRec => ({
  userId: r.userId,
  permissions: r.permissions ?? [],
  scope: r.scope ?? null,
  createdBy: r.createdBy ?? null,
  createdAt: r.createdAt,
  blockedAt: r.blockedAt ?? null,
  deletedAt: r.deletedAt ?? null,
});
const mapSupport = (r: Row): SupportSessionRec => ({
  id: r.id,
  actorId: r.actorId,
  teacherId: r.teacherId,
  mode: r.mode,
  reason: r.reason ?? null,
  ip: r.ip ?? null,
  startedAt: r.startedAt,
  expiresAt: r.expiresAt,
  endedAt: r.endedAt ?? null,
  endedBy: r.endedBy ?? null,
  endReason: r.endReason ?? null,
});
const mapAlert = (r: Row): AuditAlertRec => ({ id: r.id, key: r.key, at: r.at, kind: r.kind, actorId: r.actorId ?? null, summary: r.summary, seenAt: r.seenAt ?? null });
const mapDeletion = (r: Row): DeletionRequestRec => ({
  id: r.id,
  kind: r.kind,
  targetId: r.targetId,
  targetLabel: r.targetLabel,
  reason: r.reason,
  status: r.status,
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt,
  decidedBy: r.decidedBy ?? null,
  decidedAt: r.decidedAt ?? null,
  decisionNote: r.decisionNote ?? null,
});
function journalWhere(f: JournalFilter): Record<string, unknown> {
  return {
    ...(f.actorId ? { actorId: f.actorId } : {}),
    ...(f.onBehalfOfId ? { onBehalfOfId: f.onBehalfOfId } : {}),
    ...(f.group ? { group: f.group } : {}),
    ...(f.action || f.actionSuffix ? { action: { ...(f.action ? { equals: f.action } : {}), ...(f.actionSuffix ? { endsWith: f.actionSuffix } : {}) } } : {}),
    ...(f.targetType ? { targetType: f.targetType } : {}),
    ...(f.targetId ? { targetId: f.targetId } : {}),
    ...(f.from || f.to ? { at: range(f.from, f.to) } : {}),
    ...(f.result ? { result: f.result } : {}),
  };
}
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
      const { signup, ...rest } = u;
      return mapUser(await this.db.user.create({ data: { ...rest, signup: jsonOrNull(signup), createdAt: now, updatedAt: now, deletedAt: null } }));
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
  async getUserByPhone(phone: string) {
    const r = await this.db.user.findUnique({ where: { phone } });
    return r ? mapUser(r) : null;
  }
  async updateUser(id: Id, patch: Partial<UserRec>) {
    const { id: _i, createdAt: _c, signup, ...data } = patch;
    try {
      return mapUser(await this.db.user.update({ where: { id }, data: { ...data, ...(signup !== undefined ? { signup: jsonOrNull(signup) } : {}), updatedAt: new Date() } }));
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
    await this.db.authToken.create({ data: { ...t, attempts: t.attempts ?? 0 } });
  }
  async latestAuthToken(userId: Id, purpose: AuthTokenRec['purpose']) {
    const r = await this.db.authToken.findFirst({ where: { userId, purpose }, orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }] });
    return r ? mapAuthToken(r) : null;
  }
  async revokeAuthTokens(userId: Id, purpose: AuthTokenRec['purpose'], now: Date) {
    return (await this.db.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: now } })).count;
  }
  async failAuthTokenAttempt(id: Id, max: number, now: Date) {
    // One statement: increment and burn at `max` (no lost updates under concurrent wrong tries).
    const rows = await this.db.$queryRaw<{ attempts: number }[]>`
      UPDATE "AuthToken"
         SET "attempts" = "attempts" + 1,
             "usedAt" = CASE WHEN "attempts" + 1 >= ${max}::int THEN ${now}::timestamptz ELSE NULL END
       WHERE "id" = ${id}::uuid AND "usedAt" IS NULL
   RETURNING "attempts"`;
    return rows[0]?.attempts ?? 0;
  }
  async consumeAuthToken(tokenHash: string, purpose: AuthTokenRec['purpose'], now: Date) {
    const res = await this.db.authToken.updateMany({ where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (res.count !== 1) return null;
    const r = await this.db.authToken.findUnique({ where: { tokenHash } });
    return r ? mapAuthToken(r) : null;
  }
  async findAuthToken(tokenHash: string, purpose: AuthTokenRec['purpose'], now: Date) {
    const r = await this.db.authToken.findFirst({ where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } } });
    return r ? mapAuthToken(r) : null;
  }

  async createPhoneOtp(o: PhoneOtpRec) {
    await this.db.phoneOtp.create({ data: o });
  }
  async latestPhoneOtp(phone: string, purpose: PhoneOtpPurpose, kind: PhoneOtpRec['kind']) {
    const r = await this.db.phoneOtp.findFirst({ where: { phone, purpose, kind }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return r ? mapPhoneOtp(r) : null;
  }
  async revokePhoneOtps(phone: string, purpose: PhoneOtpPurpose, kind: PhoneOtpRec['kind'], now: Date) {
    return (await this.db.phoneOtp.updateMany({ where: { phone, purpose, kind, usedAt: null }, data: { usedAt: now } })).count;
  }
  async failPhoneOtpAttempt(id: Id, max: number, now: Date) {
    const rows = await this.db.$queryRaw<{ attempts: number }[]>`
      UPDATE "PhoneOtp"
         SET "attempts" = "attempts" + 1,
             "usedAt" = CASE WHEN "attempts" + 1 >= ${max}::int THEN ${now}::timestamptz ELSE NULL END
       WHERE "id" = ${id}::uuid AND "usedAt" IS NULL
   RETURNING "attempts"`;
    return rows[0]?.attempts ?? 0;
  }
  async findPhoneOtp(hash: string, kind: PhoneOtpRec['kind'], now: Date) {
    const r = await this.db.phoneOtp.findFirst({ where: { hash, kind, usedAt: null, expiresAt: { gt: now } } });
    return r ? mapPhoneOtp(r) : null;
  }
  async consumePhoneOtp(hash: string, kind: PhoneOtpRec['kind'], now: Date) {
    const res = await this.db.phoneOtp.updateMany({ where: { hash, kind, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (res.count !== 1) return null;
    const r = await this.db.phoneOtp.findUnique({ where: { hash } });
    return r ? mapPhoneOtp(r) : null;
  }

  async createInvite(i: Omit<InviteRec, 'revokedAt'> & { revokedAt?: Date | null }) {
    const { scope, ...rest } = i;
    await this.db.invite.create({ data: { ...rest, permissions: i.permissions ?? [], revokedAt: i.revokedAt ?? null, scopeType: scope } });
  }
  async getInvite(id: Id) {
    const r = await this.db.invite.findUnique({ where: { id } });
    return r ? mapInvite(r) : null;
  }
  async updateInvite(id: Id, patch: Partial<Pick<InviteRec, 'tokenHash' | 'expiresAt' | 'revokedAt'>>) {
    try {
      return mapInvite(await this.db.invite.update({ where: { id }, data: patch }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async getInviteByHash(tokenHash: string) {
    const r = await this.db.invite.findUnique({ where: { tokenHash } });
    return r ? mapInvite(r) : null;
  }
  async markInviteAccepted(id: Id, at: Date) {
    return (await this.db.invite.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: at } })).count === 1;
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

  async createSchool(s: Omit<SchoolRec, 'version'> & { version?: number }) {
    await this.db.school.create({ data: { ...s, origin: s.origin ?? 'admin', version: s.version ?? 1 } });
  }
  async getSchool(id: Id) {
    const r = await this.db.school.findUnique({ where: { id } });
    return r ? mapSchool(r) : null;
  }
  async updateSchool(id: Id, patch: Partial<SchoolRec>, expectedVersion: number | null = null) {
    const { id: _i, createdAt: _c, version: _v, ...data } = patch;
    const res = await this.db.school.updateMany({ where: { id, ...(expectedVersion !== null ? { version: expectedVersion } : {}) }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) return (await this.db.school.findUnique({ where: { id } })) ? ('version_mismatch' as const) : null;
    return mapSchool(await this.db.school.findUniqueOrThrow({ where: { id } }));
  }
  async listSchools(filter: { ids?: Id[] }, p: PageReq) {
    const rows = await this.db.school.findMany({ where: idWhere(p, filter.ids), orderBy: { id: 'asc' }, take: p.limit + 1 });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapSchool), nextCursor: res.nextCursor };
  }

  async createLicense(l: Omit<LicenseRec, 'version'> & { version?: number }) {
    try {
      return mapLicense(await this.db.license.create({ data: { ...l, version: l.version ?? 1 } }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async getLicense(id: Id) {
    const r = await this.db.license.findUnique({ where: { id } });
    return r ? mapLicense(r) : null;
  }
  async updateLicense(id: Id, patch: Partial<LicenseRec>, expectedVersion: number | null = null) {
    const { id: _i, schoolId: _s, version: _v, ...data } = patch;
    const res = await this.db.license.updateMany({ where: { id, ...(expectedVersion !== null ? { version: expectedVersion } : {}) }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) return (await this.db.license.findUnique({ where: { id } })) ? ('version_mismatch' as const) : null;
    return mapLicense(await this.db.license.findUniqueOrThrow({ where: { id } }));
  }
  async deleteLicense(id: Id, expectedVersion: number | null = null) {
    const res = await this.db.license.deleteMany({ where: { id, ...(expectedVersion !== null ? { version: expectedVersion } : {}) } });
    if (res.count > 0) return true;
    return (await this.db.license.findUnique({ where: { id } })) ? ('version_mismatch' as const) : false;
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
      return mapClass(await this.db.class.create({ data: { ...c, ...classSubjects({ subjectKey: c.subjectKey ?? null, subjectKeys: c.subjectKeys }) } }));
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
    const { id: _i, ...rest } = patch;
    try {
      let data: Record<string, unknown> = rest;
      if (patch.subjectKeys !== undefined || patch.subjectKey !== undefined) {
        const prev = await this.db.class.findUnique({ where: { id } });
        if (!prev) return null;
        data = { ...rest, ...classSubjects(patch, mapClass(prev)) };
      }
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

  async createTopic(t: Omit<TopicRec, 'createdAt' | 'updatedAt' | 'deletedAt' | 'version' | 'updatedBy'> & { updatedBy?: Id | null }) {
    const now = new Date();
    try {
      return mapTopic(await this.db.topic.create({ data: { ...t, updatedBy: t.updatedBy ?? null, version: 1, createdAt: now, updatedAt: now, deletedAt: null } }));
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
  async listBuilds(filter: { topicKey?: string; status?: BuildRec['status'] }, p: PageReq, order: 'asc' | 'desc' = 'asc') {
    const after = decodeCursor(p.cursor);
    const rows = await this.db.build.findMany({
      where: {
        ...(after !== undefined ? { id: order === 'desc' ? { lt: after } : { gt: after } } : {}),
        ...(filter.topicKey ? { topicKey: filter.topicKey } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { id: order },
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

  async createAsset(a: Omit<AssetRec, 'version'> & { version?: number }) {
    await this.db.asset.create({ data: assetData({ ...a, version: a.version ?? 1 }) as Prisma.AssetUncheckedCreateInput });
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
  async deleteAsset(id: Id) {
    // AssetVersion rows cascade.
    return (await this.db.asset.deleteMany({ where: { id } })).count > 0;
  }
  async createAssetVersion(v: AssetVersionRec) {
    try {
      return mapAssetVersion(await this.db.assetVersion.create({ data: { ...v, nodes: json(v.nodes), violations: json(v.violations) } }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async listAssetVersions(assetId: Id) {
    return (await this.db.assetVersion.findMany({ where: { assetId }, orderBy: { version: 'asc' } })).map(mapAssetVersion);
  }
  async updateAssetVersion(assetId: Id, version: number, patch: Partial<AssetVersionRec>) {
    const { assetId: _a, version: _v, ...rest } = patch;
    const data = {
      ...rest,
      ...(rest.nodes !== undefined ? { nodes: json(rest.nodes) } : {}),
      ...(rest.violations !== undefined ? { violations: json(rest.violations) } : {}),
    };
    try {
      return mapAssetVersion(await this.db.assetVersion.update({ where: { assetId_version: { assetId, version } }, data }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
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
  async upsertStrings(rows: readonly LocaleStringWrite[]) {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await this.db.$transaction(
        chunk.map((r) =>
          this.db.localeString.upsert({
            where: { key_locale: { key: r.key, locale: r.locale } },
            create: { key: r.key, locale: r.locale, value: r.value, status: r.status, sourceHash: r.sourceHash, updatedAt: r.updatedAt, version: 1 },
            update: { value: r.value, status: r.status, sourceHash: r.sourceHash, updatedAt: r.updatedAt, version: { increment: 1 } },
          }),
        ),
      );
    }
  }

  async createReviewComment(c: ReviewCommentWrite) {
    await this.db.reviewComment.create({ data: { ...c, anchor3d: jsonOrNull(c.anchor3d), resolvedBy: c.resolvedBy ?? null, topicVersion: c.topicVersion ?? null } });
  }
  async getReviewComment(id: Id) {
    const r = await this.db.reviewComment.findUnique({ where: { id } });
    return r ? mapComment(r) : null;
  }
  async listReviewComments(filter: ReviewCommentFilter, p: PageReq) {
    const rows = await this.db.reviewComment.findMany({
      where: {
        ...idWhere(p),
        ...(filter.targetType ? { targetType: filter.targetType } : {}),
        ...(filter.targetId ? { targetId: filter.targetId } : {}),
        ...(filter.authorId ? { authorId: filter.authorId } : {}),
        ...(filter.resolved === undefined ? {} : { resolvedAt: filter.resolved ? { not: null } : null }),
      },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapComment), nextCursor: res.nextCursor };
  }
  async updateReviewComment(id: Id, patch: Partial<Pick<ReviewCommentRec, 'body' | 'resolvedAt' | 'resolvedBy'>>) {
    try {
      return mapComment(await this.db.reviewComment.update({ where: { id }, data: patch }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
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
  // --- КТП ----------------------------------------------------------------------
  async createTeachingPlan(p: TeachingPlanRec) {
    await this.db.teachingPlan.create({ data: { ...p, doc: json(p.doc) } });
  }
  async getTeachingPlan(id: Id) {
    const r = await this.db.teachingPlan.findUnique({ where: { id } });
    return r ? mapTeachingPlan(r) : null;
  }
  async updateTeachingPlan(id: Id, patch: Partial<Pick<TeachingPlanRec, 'title' | 'doc'>>, expectedVersion: number): Promise<WriteResult<TeachingPlanRec>> {
    const data = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.doc !== undefined ? { doc: json(patch.doc) } : {}),
    };
    const res = await this.db.teachingPlan.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 }, updatedAt: new Date() } });
    if (res.count === 0) return (await this.db.teachingPlan.findUnique({ where: { id } })) ? 'version_mismatch' : 'not_found';
    return mapTeachingPlan(await this.db.teachingPlan.findUniqueOrThrow({ where: { id } }));
  }
  async deleteTeachingPlan(id: Id, expectedVersion: number) {
    const res = await this.db.teachingPlan.deleteMany({ where: { id, version: expectedVersion } });
    if (res.count > 0) return 'ok' as const;
    return (await this.db.teachingPlan.findUnique({ where: { id } })) ? ('version_mismatch' as const) : ('not_found' as const);
  }
  async listTeachingPlans(ownerId: Id, p: PageReq) {
    const rows = await this.db.teachingPlan.findMany({ where: { ...idWhere(p), ownerId }, orderBy: { id: 'asc' }, take: p.limit + 1 });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapTeachingPlan), nextCursor: res.nextCursor };
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
  async createBook(b: BookRec) {
    await this.db.book.create({ data: { ...b, contents: (b.contents ?? undefined) as object | undefined, usage: b.usage } });
  }
  async getBook(id: Id) {
    const r = await this.db.book.findUnique({ where: { id } });
    return r ? mapBook(r) : null;
  }
  async listBooks(f: { grade?: number; subjectKey?: string; lang?: string; statuses?: BookRec['status'][] }) {
    const rows = await this.db.book.findMany({
      where: { ...(f.grade !== undefined ? { grade: f.grade } : {}), ...(f.subjectKey ? { subjectKey: f.subjectKey } : {}), ...(f.lang ? { lang: f.lang } : {}), ...(f.statuses ? { status: { in: f.statuses } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(mapBook);
  }
  async updateBook(id: Id, patch: Partial<Omit<BookRec, 'id' | 'createdBy' | 'createdAt'>>) {
    const { contents, usage, ...rest } = patch;
    const r = await this.db.book.updateMany({
      where: { id },
      data: { ...rest, ...(contents !== undefined ? { contents: contents as object } : {}), ...(usage ? { usage } : {}) },
    });
    return r.count ? this.getBook(id) : null;
  }
  async claimBook(now: Date, until: Date) {
    // Optimistic claim: the lease condition is checked again in the update, so two workers never both win.
    for (let attempt = 0; attempt < 3; attempt++) {
      const b = await this.db.book.findFirst({
        where: { status: { in: ['queued', 'processing'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        orderBy: { updatedAt: 'asc' },
      });
      if (!b) return null;
      const r = await this.db.book.updateMany({ where: { id: b.id, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, data: { leaseUntil: until } });
      if (r.count) return mapBook({ ...b, leaseUntil: until });
    }
    return null;
  }
  async putBookPages(pages: BookPageRec[]) {
    for (const p of pages) {
      const data = { imageKey: p.imageKey, text: p.text, read: (p.read ?? undefined) as object | undefined };
      await this.db.bookPage.upsert({ where: { bookId_n: { bookId: p.bookId, n: p.n } }, create: { bookId: p.bookId, n: p.n, ...data }, update: { ...data, read: (p.read ?? null) as object } });
    }
  }
  async listBookPages(bookId: Id) {
    const rows = await this.db.bookPage.findMany({ where: { bookId }, orderBy: { n: 'asc' } });
    return rows.map((r) => ({ bookId: r.bookId, n: r.n, imageKey: r.imageKey, text: r.text, read: r.read ?? null }));
  }
  async setBookPageRead(bookId: Id, n: number, read: unknown) {
    await this.db.bookPage.updateMany({ where: { bookId, n }, data: { read: read as object } });
  }
  async replaceBookSections(bookId: Id, rows: BookSectionRec[]) {
    await this.db.$transaction([
      this.db.bookSection.deleteMany({ where: { bookId } }),
      this.db.bookSection.createMany({ data: rows.map((r) => ({ ...r, info: (r.info ?? undefined) as object | undefined })) }),
    ]);
  }
  async listBookSections(bookId: Id) {
    const rows = await this.db.bookSection.findMany({ where: { bookId }, orderBy: { order: 'asc' } });
    return rows.map(mapSection);
  }
  async updateBookSection(bookId: Id, id: Id, patch: Partial<Omit<BookSectionRec, 'id' | 'bookId'>>) {
    const { info, ...rest } = patch;
    const r = await this.db.bookSection.updateMany({ where: { id, bookId }, data: { ...rest, ...(info !== undefined ? { info: (info ?? null) as object } : {}) } });
    if (!r.count) return null;
    const row = await this.db.bookSection.findUnique({ where: { id } });
    return row ? mapSection(row) : null;
  }
  async getTutorAnswer(key: string) {
    const r = await this.db.tutorAnswer.findUnique({ where: { key } });
    return r ? { ...r, lang: r.lang as TutorAnswerRec['lang'] } : null;
  }
  async putTutorAnswer(a: TutorAnswerRec) {
    await this.db.tutorAnswer.createMany({ data: [a], skipDuplicates: true });
  }
  async hitTutorAnswer(key: string) {
    await this.db.tutorAnswer.updateMany({ where: { key }, data: { hits: { increment: 1 } } });
  }
  async addGenerated(rows: GeneratedRec[]) {
    if (!rows.length) return;
    await this.db.generatedContent.createMany({ data: rows.map((g) => ({ ...g, payload: g.payload as object, reasons: g.reasons })) });
  }
  async getGenerated(id: Id) {
    const r = await this.db.generatedContent.findUnique({ where: { id } });
    return r ? mapGenerated(r) : null;
  }
  async listGenerated(filter: GeneratedFilter, p: PageReq) {
    const rows = await this.db.generatedContent.findMany({
      where: {
        ...idWhere(p),
        ...(filter.topicKey ? { topicKey: filter.topicKey } : {}),
        ...(filter.conceptKey !== undefined ? { conceptKey: filter.conceptKey } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.lang ? { lang: filter.lang } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { id: 'asc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapGenerated), nextCursor: res.nextCursor };
  }
  async updateGenerated(id: Id, patch: Partial<Pick<GeneratedRec, 'status' | 'reviewedAt' | 'reviewedBy' | 'promotedTo'>>) {
    const r = await this.db.generatedContent.updateMany({ where: { id }, data: patch });
    return r.count ? this.getGenerated(id) : null;
  }
  async markGeneratedSeen(userId: Id, ids: Id[], at: Date) {
    if (!ids.length) return;
    await this.db.generatedSeen.createMany({ data: ids.map((generatedId) => ({ userId, generatedId, seenAt: at })), skipDuplicates: true });
  }
  async listSeenGenerated(userId: Id, filter: GeneratedFilter, limit: number) {
    const rows = await this.db.generatedSeen.findMany({
      where: {
        userId,
        generated: {
          ...(filter.topicKey ? { topicKey: filter.topicKey } : {}),
          ...(filter.conceptKey !== undefined ? { conceptKey: filter.conceptKey } : {}),
          ...(filter.kind ? { kind: filter.kind } : {}),
          ...(filter.lang ? { lang: filter.lang } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        },
      },
      include: { generated: true },
      orderBy: [{ seenAt: 'asc' }, { generatedId: 'asc' }],
      take: limit,
    });
    return rows.map((r) => mapGenerated(r.generated));
  }
  async countGenerated(ids: Id[], delta: { served?: number; good?: number; bad?: number; reason?: string }) {
    if (!ids.length) return;
    // One statement: counters and the per-reason JSON bump stay atomic under concurrent votes.
    await this.db.$executeRaw`
      UPDATE "GeneratedContent" SET
        "served" = "served" + ${delta.served ?? 0},
        "good" = "good" + ${delta.good ?? 0},
        "bad" = "bad" + ${delta.bad ?? 0},
        "reasons" = CASE WHEN ${delta.reason ?? null}::text IS NULL THEN "reasons"
          ELSE jsonb_set("reasons", ARRAY[${delta.reason ?? ''}::text], to_jsonb(COALESCE(("reasons"->>${delta.reason ?? ''}::text)::int, 0) + 1)) END
      WHERE "id" = ANY(${ids}::uuid[])`;
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
    await this.appendJournal(legacyToEvent(a));
  }
  async listAudit(filter: { actorId?: Id; action?: string; targetType?: string }, p: PageReq) {
    const rows = await this.db.auditEvent.findMany({
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
    return { items: res.items.map((r) => eventToLegacy(mapJournalEvent(r))), nextCursor: res.nextCursor };
  }

  // --- v0.8.0: the action journal ------------------------------------------------------
  async appendJournal(e: AuditEventInput) {
    const payload = JSON.stringify({ ...e, at: e.at.toISOString(), before: e.before ?? null, after: e.after ?? null, details: e.details ?? null });
    const rows = await this.db.$queryRaw<Row[]>`SELECT * FROM audit_event_append(${payload}::jsonb)`;
    return mapJournalEvent(rows[0]);
  }
  async listJournal(f: JournalFilter, p: PageReq, order: 'asc' | 'desc' = 'desc') {
    const after = decodeCursor(p.cursor);
    const cur = after !== undefined && /^\d+$/.test(after) ? BigInt(after) : null;
    const rows = await this.db.auditEvent.findMany({
      where: { ...journalWhere(f), ...(cur !== null ? { seq: order === 'desc' ? { lt: cur } : { gt: cur } } : {}) },
      orderBy: { seq: order },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => String(r.seq));
    return { items: res.items.map(mapJournalEvent), nextCursor: res.nextCursor };
  }
  async verifyJournal() {
    const [r] = await this.db.$queryRaw<{ ok: boolean; checked: bigint; broken_at: bigint | null }[]>`SELECT * FROM audit_event_verify()`;
    return { ok: r.ok, checked: Number(r.checked), brokenAt: r.broken_at === null ? null : Number(r.broken_at) };
  }
  async maintainJournal(now: Date, aheadMonths: number, retainMonths: number) {
    const [r] = await this.db.$queryRaw<{ created: number; dropped: number }[]>`SELECT * FROM audit_event_maintain(${now}::timestamptz, ${aheadMonths}::int, ${retainMonths}::int)`;
    return { created: Number(r.created), dropped: Number(r.dropped) };
  }
  async createAlert(a: AuditAlertRec) {
    try {
      return mapAlert(await this.db.auditAlert.create({ data: a }));
    } catch (e) {
      if (isUnique(e)) return 'conflict' as const;
      throw e;
    }
  }
  async listAlerts(limit: number) {
    return (await this.db.auditAlert.findMany({ orderBy: [{ at: 'desc' }, { id: 'desc' }], take: limit })).map(mapAlert);
  }
  async markAlertSeen(id: Id, at: Date) {
    const r = await this.db.auditAlert.findUnique({ where: { id } });
    if (!r) return false;
    if (!r.seenAt) await this.db.auditAlert.updateMany({ where: { id, seenAt: null }, data: { seenAt: at } });
    return true;
  }

  // --- v0.8.0: staff, support sessions, deletion requests ---------------------------------
  async getStaffProfile(userId: Id) {
    const r = await this.db.staffProfile.findUnique({ where: { userId } });
    return r ? mapStaff(r) : null;
  }
  async putStaffProfile(p: StaffProfileRec) {
    const data = { permissions: p.permissions, scope: jsonOrNull(p.scope), createdBy: p.createdBy, createdAt: p.createdAt, blockedAt: p.blockedAt, deletedAt: p.deletedAt };
    await this.db.staffProfile.upsert({ where: { userId: p.userId }, create: { userId: p.userId, ...data }, update: data });
  }
  async listStaffProfiles() {
    return (await this.db.staffProfile.findMany({ orderBy: { userId: 'asc' } })).map(mapStaff);
  }
  async listUserIdsByRole(role: GrantRec['role']) {
    const rows = await this.db.roleAssignment.findMany({ where: { role }, select: { userId: true }, distinct: ['userId'], orderBy: { userId: 'asc' } });
    return rows.map((r) => r.userId);
  }
  async createSupportSession(s: SupportSessionRec) {
    await this.db.impersonationSession.create({ data: s });
  }
  async getSupportSession(id: Id) {
    const r = await this.db.impersonationSession.findUnique({ where: { id } });
    return r ? mapSupport(r) : null;
  }
  async endSupportSession(id: Id, at: Date, by: Id | null, reason: 'ended' | 'expired') {
    const res = await this.db.impersonationSession.updateMany({ where: { id, endedAt: null }, data: { endedAt: at, endedBy: by, endReason: reason } });
    if (!res.count) return null;
    return mapSupport(await this.db.impersonationSession.findUniqueOrThrow({ where: { id } }));
  }
  async listExpiredSupportSessions(now: Date) {
    return (await this.db.impersonationSession.findMany({ where: { endedAt: null, expiresAt: { lte: now } }, orderBy: { id: 'asc' } })).map(mapSupport);
  }
  async createDeletionRequest(r: DeletionRequestRec) {
    await this.db.deletionRequest.create({ data: r });
  }
  async getDeletionRequest(id: Id) {
    const r = await this.db.deletionRequest.findUnique({ where: { id } });
    return r ? mapDeletion(r) : null;
  }
  async listDeletionRequests(f: { status?: DeletionRequestRec['status']; requestedBy?: Id }, p: PageReq) {
    const after = decodeCursor(p.cursor);
    const rows = await this.db.deletionRequest.findMany({
      where: { ...(f.status ? { status: f.status } : {}), ...(f.requestedBy ? { requestedBy: f.requestedBy } : {}), ...(after !== undefined ? { id: { lt: after } } : {}) },
      orderBy: { id: 'desc' },
      take: p.limit + 1,
    });
    const res = page(rows, p.limit, (r) => r.id);
    return { items: res.items.map(mapDeletion), nextCursor: res.nextCursor };
  }
  async decideDeletionRequest(id: Id, d: Pick<DeletionRequestRec, 'status' | 'decidedBy' | 'decidedAt' | 'decisionNote'>) {
    const res = await this.db.deletionRequest.updateMany({ where: { id, status: 'pending' }, data: d });
    if (!res.count) return null;
    return mapDeletion(await this.db.deletionRequest.findUniqueOrThrow({ where: { id } }));
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
