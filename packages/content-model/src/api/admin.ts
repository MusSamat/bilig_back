/**
 * Admin DTOs (TZ §5, §9 Admin:*). Forms and validation in the admin are built
 * from the same schemas (TZ §5 «Принцип масштаба»).
 */
import { z } from 'zod';
import type { Permission } from '@bilig/permissions';
import { KeySchema, SemverSchema } from '../common.js';
import { ConceptSchema } from '../concept.js';
import { CourseSchema, ObjectiveSchema, SubjectGroupSchema, SubjectSchema, UnitSchema } from '../curriculum.js';
import { GlossaryTermSchema } from '../glossary.js';
import { I18nStatusMapSchema, I18nStatusSchema, LANGS, LangSchema, LocalizedSchema } from '../i18n.js';
import { ItemSchema, ItemTypeSchema } from '../item.js';
import { ProcessSchema } from '../process.js';
import { ComparisonSchema, ContentStatusSchema, TopicSchema, TourSchema, type ContentStatus } from '../topic.js';
import { AuthorSubroleSchema, EmailSchema, RoleGrantSchema, RoleSchema, ScopeSchema } from './auth.js';
import { DateTimeSchema, IdSchema, PageQuerySchema, QueryBoolSchema, SortOrderSchema, VersionTagSchema, cursorPage, sortQuery } from './common.js';

// ---------------------------------------------------------------------------
// Publish workflow (A-13): draft → review → published → archived
// ---------------------------------------------------------------------------

export const WORKFLOW_ACTIONS = ['submit', 'reject', 'approve', 'publish', 'archive', 'rollback', 'restore'] as const;
export const WorkflowActionSchema = z.enum(WORKFLOW_ACTIONS);
export type WorkflowAction = z.infer<typeof WorkflowActionSchema>;

/**
 * Allowed transitions. `approve` and `publish` both move review → published
 * (approve = publish now after the checklist; publish may be scheduled).
 * `rollback` re-publishes a previous version; `restore` reopens an archived topic as a draft.
 */
export const WORKFLOW: Record<WorkflowAction, { from: readonly ContentStatus[]; to: ContentStatus; permission: Permission }> = {
  submit: { from: ['draft'], to: 'review', permission: 'content.draft.edit' },
  reject: { from: ['review'], to: 'draft', permission: 'content.publish' },
  approve: { from: ['review'], to: 'published', permission: 'content.publish' },
  publish: { from: ['review'], to: 'published', permission: 'content.publish' },
  archive: { from: ['published'], to: 'archived', permission: 'content.publish' },
  rollback: { from: ['published', 'archived'], to: 'published', permission: 'content.publish' },
  restore: { from: ['archived'], to: 'draft', permission: 'content.publish' },
};

/** Next state for an action, or null when the transition is not allowed. */
export function transition(state: ContentStatus, action: WorkflowAction): ContentStatus | null {
  const rule = WORKFLOW[action];
  return rule.from.includes(state) ? rule.to : null;
}

/** Actions available from a state. */
export function availableActions(state: ContentStatus): WorkflowAction[] {
  return WORKFLOW_ACTIONS.filter((a) => transition(state, a) !== null);
}

// POST /admin/topics/:id/{submit|reject|approve|publish|archive|rollback|restore}
export const SubmitRequestSchema = z.object({ message: z.string().max(2000).optional() });
export const RejectRequestSchema = z.object({ reason: z.string().min(1).max(2000) });
export const PublishRequestSchema = z.object({ scheduledAt: DateTimeSchema.optional() });
export const RollbackRequestSchema = z.object({ toVersion: SemverSchema });

export const ChecklistSchema = z.object({
  schema: z.boolean(),
  translations: z.boolean(),
  budgets: z.boolean(),
  altText: z.boolean(),
  issues: z.array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      code: z.string(),
      message: z.string(),
      severity: z.enum(['error', 'warning']),
    }),
  ),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

export const WorkflowResponseSchema = z.object({
  topicKey: KeySchema,
  status: ContentStatusSchema,
  version: SemverSchema,
  checklist: ChecklistSchema.optional(),
  scheduledAt: DateTimeSchema.optional(),
});
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

// ---------------------------------------------------------------------------
// CRUD payloads. Create = full schema; update = partial + `version` (If-Match).
// ---------------------------------------------------------------------------

/** Optional fields of a patch accept `null` = remove the field (v0.3.0). */
type NullableOptionals<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodOptional<z.ZodTypeAny> ? z.ZodNullable<T[K]> : T[K];
};
const nullableOptionals = <T extends z.ZodRawShape>(s: z.ZodObject<T>): z.ZodObject<NullableOptionals<T>> => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(s.shape) as [string, z.ZodTypeAny][]) shape[k] = v.isOptional() ? v.nullable() : v;
  return z.object(shape) as unknown as z.ZodObject<NullableOptionals<T>>;
};

/**
 * Partial update + `version` (If-Match). Fields that are optional in the
 * entity schema also accept `null`, which REMOVES the field (JSON has no
 * `undefined`), e.g. `{ subtitle: null, version: 3 }` (v0.3.0).
 */
const withVersion = <T extends z.ZodRawShape>(s: z.ZodObject<T>) =>
  nullableOptionals(s).partial().extend({ version: VersionTagSchema });

export const AdminSubjectCreateSchema = SubjectSchema;
export const AdminSubjectPatchSchema = withVersion(SubjectSchema.omit({ key: true }));
export const AdminCourseCreateSchema = CourseSchema;
export const AdminCoursePatchSchema = withVersion(CourseSchema.omit({ key: true }));
export const AdminUnitCreateSchema = UnitSchema;
export const AdminUnitPatchSchema = withVersion(UnitSchema.omit({ key: true }));
export const AdminObjectiveCreateSchema = ObjectiveSchema;
export const AdminObjectivePatchSchema = withVersion(ObjectiveSchema.omit({ key: true }));
export const AdminConceptCreateSchema = ConceptSchema;
export const AdminConceptPatchSchema = withVersion(ConceptSchema.omit({ key: true }));
export const AdminProcessCreateSchema = ProcessSchema;
export const AdminProcessPatchSchema = withVersion(ProcessSchema.omit({ key: true }));
export const AdminItemSchema = ItemSchema;
export const AdminGlossaryTermSchema = GlossaryTermSchema;

/** Envelope for a stored entity row: data + optimistic version + audit fields. */
export const adminRecord = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ id: IdSchema, data, version: VersionTagSchema, updatedAt: DateTimeSchema, updatedBy: IdSchema.optional() });

/** «Где используется» for a concept (A-04); deleting a used concept → 409. */
export const ConceptUsageSchema = z.object({
  conceptKey: KeySchema,
  topicKeys: z.array(KeySchema),
  /**
   * v0.3.0: everything that blocks deletion, as `topic:<key>`, `process:<key>`
   * (a step highlights the concept) and `concept:<key>` (lists it in `related`).
   */
  usedBy: z.array(z.string()).optional(),
});

// Topics + versions
export const AdminTopicCreateSchema = z.object({ key: KeySchema, unitKey: KeySchema });
export const AdminTopicSchema = z.object({
  id: IdSchema,
  key: KeySchema,
  unitKey: KeySchema,
  status: ContentStatusSchema,
  publishedVersion: SemverSchema.optional(),
  latestVersion: SemverSchema.optional(),
  updatedAt: DateTimeSchema,
  version: VersionTagSchema,
  /** v0.3.0: title of the latest version (absent while the topic has no versions). */
  title: LocalizedSchema.optional(),
  /** v0.3.0: who last changed the topic row or wrote its latest version. */
  updatedBy: IdSchema.optional(),
  /** v0.3.0: author of the latest version (A-01 «мои черновики»: `?mine=true`). */
  authorId: IdSchema.optional(),
  createdAt: DateTimeSchema.optional(),
});
export type AdminTopic = z.infer<typeof AdminTopicSchema>;
export const AdminTopicListSchema = cursorPage(AdminTopicSchema);

// POST /admin/topics/:id/versions
export const TopicVersionCreateRequestSchema = z.object({
  doc: TopicSchema,
  basedOn: SemverSchema.optional(),
  message: z.string().max(2000).optional(),
});
export type TopicVersionCreateRequest = z.infer<typeof TopicVersionCreateRequestSchema>;
export const TopicVersionSchema = z.object({
  id: IdSchema,
  topicKey: KeySchema,
  version: SemverSchema,
  doc: TopicSchema,
  authorId: IdSchema,
  createdAt: DateTimeSchema,
  reviewState: ContentStatusSchema,
});
export type TopicVersion = z.infer<typeof TopicVersionSchema>;

// Review comments (A-14)
export const REVIEW_TARGET_TYPES = ['topic', 'concept', 'process', 'item'] as const;
export const ReviewTargetTypeSchema = z.enum(REVIEW_TARGET_TYPES);
export const ReviewCommentSchema = z.object({
  id: IdSchema,
  targetType: ReviewTargetTypeSchema,
  /** Topic id or the dictionary record id (`adminRecord().id`). */
  targetId: IdSchema,
  /** Field path in the document (`activities.tour.steps.2.text`); '' = the whole entity. */
  path: z.string(),
  /** Point on the 3D model (scene coordinates). */
  anchor3d: z.tuple([z.number(), z.number(), z.number()]).optional(),
  body: z.string().min(1).max(4000),
  resolvedAt: DateTimeSchema.optional(),
  // v0.3.0 (the server always sends both; optional so 0.2.1 client-side drafts still type-check)
  authorId: IdSchema.optional(),
  createdAt: DateTimeSchema.optional(),
  resolvedBy: IdSchema.optional(),
  /** Topic version (semver) the comment was written against. */
  topicVersion: SemverSchema.optional(),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

// Assets (A-05)
export const ASSET_KINDS = ['glb', 'image', 'molfile'] as const;
export const AssetUploadRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  kind: z.enum(ASSET_KINDS),
  size: z.number().int().positive().max(200 * 1024 * 1024),
  contentType: z.string().min(1),
  license: z.string().min(1),
  author: z.string().min(1),
  source: z.string().min(1),
});
export type AssetUploadRequest = z.infer<typeof AssetUploadRequestSchema>;
export const AssetUploadResponseSchema = z.object({
  assetId: IdSchema,
  uploadId: z.string(),
  partSize: z.number().int().positive(),
  partUrls: z.array(z.string()),
  /** v0.3.0: the asset version this upload creates (1 for a new asset). */
  version: z.number().int().min(1).optional(),
});
export const ASSET_STATUSES = ['uploaded', 'processing', 'ready', 'failed'] as const;
export const AssetReportSchema = z.object({
  id: IdSchema,
  key: KeySchema,
  status: z.enum(ASSET_STATUSES),
  sizeBefore: z.number().int().min(0),
  sizeAfter: z.number().int().min(0).optional(),
  triangles: z.number().int().min(0).optional(),
  nodes: z.array(z.string()),
  violations: z.array(z.string()),
  thumbUrl: z.string().optional(),
  // v0.3.0: the metadata collected at upload + the current file version.
  filename: z.string().optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  contentType: z.string().optional(),
  license: z.string().optional(),
  author: z.string().optional(),
  source: z.string().optional(),
  createdAt: DateTimeSchema.optional(),
  createdBy: IdSchema.optional(),
  /** Current file version (1-based; see GET /admin/assets/:id/versions). */
  version: z.number().int().min(1).optional(),
  /** When the multipart upload of the current version was completed. */
  completedAt: DateTimeSchema.optional(),
});
export type AssetReport = z.infer<typeof AssetReportSchema>;

// Strings (A-11)
export const STRING_SORTS = ['key', 'updatedAt', 'status', 'value'] as const;
export const StringsQuerySchema = z.object({
  locale: LangSchema,
  status: I18nStatusSchema.optional(),
  untranslated: QueryBoolSchema.optional(),
  sourceChanged: QueryBoolSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  // v0.3.0
  /** Case-insensitive search in the key and in the value. */
  q: z.string().trim().max(200).optional(),
  /** Key prefix (one entity: `topic/animal-cell/`, `concept/bio.nucleus/`). */
  prefix: z.string().max(300).optional(),
  ...sortQuery(STRING_SORTS),
});
export const LocaleStringSchema = z.object({
  key: z.string().min(1),
  locale: LangSchema,
  value: z.string(),
  status: I18nStatusSchema,
  sourceHash: z.string(),
  sourceChanged: z.boolean(),
  /** v0.3.0: row version for the optimistic PATCH precondition. */
  version: VersionTagSchema.optional(),
  updatedAt: DateTimeSchema.optional(),
});
export type LocaleString = z.infer<typeof LocaleStringSchema>;
export const StringsListSchema = cursorPage(LocaleStringSchema);
export const StringsPatchRequestSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(1),
        locale: LangSchema,
        value: z.string(),
        status: I18nStatusSchema,
        /**
         * v0.3.0 preconditions (409 `version_mismatch` when stale; the whole
         * request is rejected before anything is written):
         *  - `version`: the row version the editor saw (0 = the row did not exist);
         *  - `sourceHash`: the source (ru) hash the translation was made from.
         */
        version: VersionTagSchema.optional(),
        sourceHash: z.string().min(1).max(64).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

/** v0.3.0: `locales=ru,ky,en` — a comma-separated list of content languages. */
export const LocalesParamSchema = z
  .string()
  .regex(new RegExp(`^(?:${LANGS.join('|')})(?:,(?:${LANGS.join('|')}))*$`), 'Expected e.g. ru,ky,en');

// GET /admin/strings/rows (v0.3.0): one row per key with several locales side by side (A-11).
export const StringRowsQuerySchema = PageQuerySchema.extend({
  /** Default: all content languages. */
  locales: LocalesParamSchema.optional(),
  /** Rows where one of the requested locales has this status. */
  status: I18nStatusSchema.optional(),
  /** Rows where one of the requested locales is empty. */
  untranslated: QueryBoolSchema.optional(),
  /** Rows where one of the requested locales was translated from an older source. */
  sourceChanged: QueryBoolSchema.optional(),
  q: z.string().trim().max(200).optional(),
  prefix: z.string().max(300).optional(),
  ...sortQuery(['key', 'updatedAt'] as const),
}).extend({ limit: z.coerce.number().int().min(1).max(500).optional() });
const langMap = <T extends z.ZodTypeAny>(v: T) => z.object({ ky: v, ru: v, en: v }).partial();
export const StringRowSchema = z.object({
  key: z.string().min(1),
  /** Values of the requested locales (a locale without a row is absent). */
  values: langMap(z.string()),
  status: I18nStatusMapSchema,
  /** Row versions (PATCH precondition). */
  versions: langMap(VersionTagSchema),
  /** Hash of the current source (ru) text. */
  sourceHash: z.string(),
  /** Some requested locale was translated from an older source. */
  sourceChanged: z.boolean(),
  sourceChangedLocales: z.array(LangSchema),
  updatedAt: DateTimeSchema.optional(),
});
export type StringRow = z.infer<typeof StringRowSchema>;
export const StringRowListSchema = cursorPage(StringRowSchema);

// Org: schools, licenses, users, invites (A-15, A-16)
export const SchoolSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  region: z.string().min(1),
  type: z.enum(['state', 'private']),
  language: LangSchema,
  status: z.enum(['active', 'suspended']),
  /** v0.3.0: optimistic version (send it as If-Match or `version` on PATCH). */
  version: VersionTagSchema.optional(),
});
export type School = z.infer<typeof SchoolSchema>;
export const SchoolCreateSchema = SchoolSchema.omit({ id: true, version: true });
export const LicenseSchema = z
  .object({
    id: IdSchema,
    schoolId: IdSchema,
    subjects: z.array(KeySchema).min(1),
    grades: z.array(z.number().int().min(1).max(11)).min(1),
    seats: z.number().int().positive(),
    startsAt: DateTimeSchema,
    endsAt: DateTimeSchema,
    /** v0.3.0: optimistic version (ignored on create). */
    version: VersionTagSchema.optional(),
  })
  .refine((l) => l.endsAt > l.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type License = z.infer<typeof LicenseSchema>;
export const InviteCreateRequestSchema = z.object({
  email: EmailSchema,
  role: RoleSchema,
  scope: ScopeSchema,
  scopeId: z.string().min(1).optional(),
  subrole: AuthorSubroleSchema.optional(),
});
export const AdminUserSchema = z.object({
  id: IdSchema,
  kind: z.enum(['adult', 'student']),
  displayName: z.string(),
  email: EmailSchema.optional(),
  status: z.enum(['active', 'blocked', 'invited']),
  grants: z.array(RoleGrantSchema),
});
export const AdminUserListSchema = cursorPage(AdminUserSchema);

// Audit (A-19)
export const AuditEntrySchema = z.object({
  id: IdSchema,
  /** null for anonymous actions (class-code access, PIN lockout). */
  actorId: IdSchema.nullable(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  diff: z.unknown().optional(),
  ip: z.string().optional(),
  ts: DateTimeSchema,
});
export const AuditListSchema = cursorPage(AuditEntrySchema);

// ---------------------------------------------------------------------------
// v0.2.1 (additive): the rest of TZ §9 Admin:* — lists, patches, deletes,
// workflow extras, builds, i18n import/export, org, analytics, tutor settings.
// ---------------------------------------------------------------------------

/** Field names accepted by `sort` on the generic admin lists. */
export const ADMIN_SORT_FIELD_RE = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

/** Common admin list query: cursor page + free-text and the usual filters. */
export const AdminListQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  subjectKey: KeySchema.optional(),
  /** Topics: a ContentStatus; subjects (v0.3.0): `soon` | `live` (an unknown value → 400); ignored by lists without a status. */
  status: z.string().max(40).optional(),
  // v0.3.0
  /**
   * Sort field. Every list: `key`, `updatedAt`, `createdAt`, `title` (in the
   * Accept-Language with the ky → ru → en chain); dictionary lists also any
   * top-level field of the entity (`order`, `grade`, `kind`, `difficulty`,
   * `ru`…; arrays sort by length); topics also `unitKey`, `status`,
   * `publishedVersion`, `latestVersion`. Missing values sort last (asc).
   * Without `sort` the order is `key` ascending (as before).
   */
  sort: z.string().regex(ADMIN_SORT_FIELD_RE).optional(),
  order: SortOrderSchema.optional(),
  /** Topics and objectives of one unit (A-13 «массовая публикация раздела»). */
  unitKey: KeySchema.optional(),
  /** Topics: author of the latest version; dictionary entries: the last editor. */
  authorId: IdSchema.optional(),
  /** Shorthand for `authorId` = the caller (A-01 «мои черновики»). */
  mine: QueryBoolSchema.optional(),
});
export type AdminListQuery = z.infer<typeof AdminListQuerySchema>;

/** Paginated list of admin records of one entity type. */
export const adminRecordPage = <T extends z.ZodTypeAny>(data: T) => cursorPage(adminRecord(data));

/** v0.3.0: GET /admin/concepts filters. */
export const AdminConceptListQuerySchema = AdminListQuerySchema.extend({ kind: z.string().trim().min(1).max(60).optional() });
/** v0.3.0: GET /admin/items filters. */
export const AdminItemListQuerySchema = AdminListQuerySchema.extend({ type: ItemTypeSchema.optional(), objectiveKey: KeySchema.optional() });

export const AdminSubjectGroupSchema = SubjectGroupSchema;
export const AdminSubjectGroupPatchSchema = withVersion(SubjectGroupSchema.omit({ key: true }));
export const AdminItemPatchSchema = z.object({ data: ItemSchema, version: VersionTagSchema });
export const AdminGlossaryPatchSchema = withVersion(GlossaryTermSchema.omit({ id: true }));

// Topics
export const AdminTopicPatchSchema = z.object({
  unitKey: KeySchema.optional(),
  /** Open demo topic (TZ §2): guests may load it. Applied on the next publish/build. */
  demo: z.boolean().optional(),
  version: VersionTagSchema,
});
export const AdminTopicDetailSchema = AdminTopicSchema.extend({
  demo: z.boolean(),
  subjectKey: KeySchema,
  scheduledAt: DateTimeSchema.optional(),
  availableActions: z.array(WorkflowActionSchema),
});
export type AdminTopicDetail = z.infer<typeof AdminTopicDetailSchema>;
export const TopicVersionListSchema = z.object({ items: z.array(TopicVersionSchema.omit({ doc: true })) });
export const ArchiveRequestSchema = z.object({ reason: z.string().max(2000).optional() });

// GET /admin/topics/:id/diff?from=&to= (A-13 «дифф с опубликованной версией»)
export const TopicDiffQuerySchema = z.object({ from: SemverSchema.optional(), to: SemverSchema.optional() });
export const TopicDiffSchema = z.object({
  from: SemverSchema.nullable(),
  to: SemverSchema,
  changes: z.array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      kind: z.enum(['added', 'removed', 'changed']),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
});
export type TopicDiff = z.infer<typeof TopicDiffSchema>;

// Tours & comparisons live inside the topic document; PUT writes a new draft version.
export const TourPutRequestSchema = z.object({ tour: TourSchema, version: VersionTagSchema });
export const ComparisonPutRequestSchema = z.object({ comparison: ComparisonSchema, version: VersionTagSchema });
export const TourResponseSchema = z.object({ topicKey: KeySchema, tour: TourSchema.nullable(), version: SemverSchema.nullable() });
export const ComparisonResponseSchema = z.object({
  topicKey: KeySchema,
  comparison: ComparisonSchema.nullable(),
  version: SemverSchema.nullable(),
});

// Items: answer statistics (A-10)
export const ItemStatsSchema = z.object({
  itemKey: KeySchema,
  answers: z.number().int().min(0),
  correctRate: z.number().min(0).max(1).nullable(),
  /** Most frequent wrong response (option key / concept key / number as string). */
  commonWrong: z.string().optional(),
  avgTimeMs: z.number().min(0).nullable(),
});
export type ItemStats = z.infer<typeof ItemStatsSchema>;

// Assets (A-05)
export const AssetListSchema = cursorPage(AssetReportSchema);

// Strings import/export (A-11)
export const STRINGS_FORMATS = ['csv', 'xliff'] as const;
export const StringsImportRequestSchema = z.object({
  format: z.enum(STRINGS_FORMATS),
  /** Target locale of the file. */
  locale: LangSchema,
  content: z.string().min(1).max(5_000_000),
  /** Status given to imported values (default `draft`). */
  status: I18nStatusSchema.optional(),
});
export const StringsImportResponseSchema = z.object({
  updated: z.number().int().min(0),
  unchanged: z.number().int().min(0),
  unknownKeys: z.array(z.string()),
  errors: z.array(z.object({ line: z.number().int().optional(), message: z.string() })),
});
export const StringsExportQuerySchema = z.object({
  format: z.enum(STRINGS_FORMATS),
  locale: LangSchema,
  /** Source language shown next to the target (default `ru`). */
  source: LangSchema.optional(),
  untranslated: QueryBoolSchema.optional(),
});

// Glossary
export const GlossaryListSchema = adminRecordPage(GlossaryTermSchema);

// Builds (§8 Build)
export const BUILD_STATUSES = ['queued', 'building', 'ready', 'failed'] as const;
export const BuildSchema = z.object({
  id: IdSchema,
  topicKey: KeySchema,
  topicVersionId: IdSchema,
  version: SemverSchema,
  status: z.enum(BUILD_STATUSES),
  hash: z.string().optional(),
  packageUrl: z.string().optional(),
  log: z.array(z.string()),
  createdAt: DateTimeSchema,
});
export type Build = z.infer<typeof BuildSchema>;
export const BuildListSchema = cursorPage(BuildSchema);
export const BuildListQuerySchema = PageQuerySchema.extend({
  topicKey: KeySchema.optional(),
  /** v0.3.0 (A-01 «ошибки сборки»: `status=failed`). */
  status: z.enum(BUILD_STATUSES).optional(),
  /** v0.3.0: builds sort by creation time only; `order=desc` = newest first. */
  ...sortQuery(['createdAt'] as const),
});

// Org (A-15, A-16)
export const SchoolListSchema = cursorPage(SchoolSchema);
/**
 * PATCH /admin/schools/:id. v0.3.0: optimistic locking is OPTIONAL — send
 * `version` (or If-Match); a stale one → 409. Without it the last write wins.
 */
export const SchoolPatchSchema = SchoolCreateSchema.partial().extend({ version: VersionTagSchema.optional() });
/** v0.3.0: GET /admin/schools filters and sort. */
export const SchoolListQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  region: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  ...sortQuery(['name', 'region', 'type', 'language', 'status', 'createdAt'] as const),
});
export const LicenseListSchema = cursorPage(LicenseSchema);
export const LicenseListQuerySchema = PageQuerySchema.extend({
  schoolId: IdSchema.optional(),
  // v0.3.0
  /** Licences valid now (true) or not valid now (false). */
  active: QueryBoolSchema.optional(),
  ...sortQuery(['startsAt', 'endsAt', 'seats', 'schoolId', 'createdAt'] as const),
});
/** PATCH /admin/licenses/:id. v0.3.0: optional `version` (or If-Match) precondition, as for schools. */
export const LicensePatchSchema = z.object({
  subjects: z.array(KeySchema).min(1),
  grades: z.array(z.number().int().min(1).max(11)).min(1),
  seats: z.number().int().positive(),
  startsAt: DateTimeSchema,
  endsAt: DateTimeSchema,
  version: VersionTagSchema,
}).partial();
export const AdminUserListQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  schoolId: IdSchema.optional(),
  role: RoleSchema.optional(),
  status: z.enum(['active', 'blocked', 'invited']).optional(),
  /** v0.3.0 */
  ...sortQuery(['displayName', 'email', 'kind', 'status', 'createdAt'] as const),
});
export const AdminUserPatchSchema = z
  .object({ status: z.enum(['active', 'blocked']), displayName: z.string().trim().min(1).max(100) })
  .partial();
/** PUT /admin/users/:id/grants — replaces the user's role grants (audited). */
export const UserGrantsPutSchema = z.object({ grants: z.array(RoleGrantSchema).max(50) });
export const INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export const InviteSchema = z.object({
  id: IdSchema,
  email: EmailSchema,
  role: RoleSchema,
  scope: ScopeSchema,
  scopeId: z.string().optional(),
  expiresAt: DateTimeSchema,
  acceptedAt: DateTimeSchema.optional(),
  // v0.3.0
  revokedAt: DateTimeSchema.optional(),
  createdAt: DateTimeSchema.optional(),
  invitedBy: IdSchema.optional(),
  status: z.enum(INVITE_STATUSES).optional(),
});
export type Invite = z.infer<typeof InviteSchema>;
export const InviteListSchema = cursorPage(InviteSchema);
/** v0.3.0: GET /admin/invites filters and sort. */
export const InviteListQuerySchema = PageQuerySchema.extend({
  status: z.enum(INVITE_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  ...sortQuery(['email', 'role', 'expiresAt', 'acceptedAt', 'createdAt'] as const),
});

// Audit filters (A-19)
export const AUDIT_SORTS = ['ts', 'action', 'target', 'targetType', 'actorId'] as const;
export const AuditQuerySchema = PageQuerySchema.extend({
  /** A full UUID, or (v0.3.0) a hex prefix of one (≥ 4 chars). */
  actorId: z.string().trim().regex(/^[0-9a-fA-F-]{4,36}$/, 'Expected a UUID or a UUID prefix').optional(),
  action: z.string().max(100).optional(),
  targetType: z.string().max(100).optional(),
  // v0.3.0
  targetId: z.string().min(1).max(200).optional(),
  /** Entries at or after `from` and before `to`. */
  from: DateTimeSchema.optional(),
  to: DateTimeSchema.optional(),
  /** `target` sorts by targetType, then targetId. Default `ts` ascending. */
  ...sortQuery(AUDIT_SORTS),
});

// Analytics (A-17)
export const AnalyticsQuerySchema = z.object({ from: DateTimeSchema.optional(), to: DateTimeSchema.optional() });
const countBy = <K extends z.ZodTypeAny>(key: K) => z.array(z.object({ key, count: z.number().int().min(0) }));
export const AnalyticsOverviewSchema = z.object({
  from: DateTimeSchema,
  to: DateTimeSchema,
  activeSchools: z.number().int().min(0),
  activeStudents: z.number().int().min(0),
  attempts: z.number().int().min(0),
  events: z.number().int().min(0),
  daily: z.array(z.object({ date: z.string(), events: z.number().int().min(0), attempts: z.number().int().min(0) })),
  bySchool: countBy(IdSchema),
  byRegion: countBy(z.string()),
  popularTopics: countBy(z.string()),
  popularConcepts: countBy(z.string()),
  hardestItems: z.array(ItemStatsSchema),
  tutor: z.object({
    questions: z.number().int().min(0),
    refused: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    /** Masked questions the tutor could not answer from the materials (content backlog). */
    unanswered: z.array(z.object({ topicKey: z.string(), text: z.string(), ts: DateTimeSchema })),
  }),
});
export type AnalyticsOverview = z.infer<typeof AnalyticsOverviewSchema>;

// Tutor settings (A-18)
export const TutorSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['anthropic']),
  model: z.string().min(1),
  /** Extra per-language instructions appended to the fixed safety rules. */
  systemPrompts: z.object({ ky: z.string().max(4000), ru: z.string().max(4000), en: z.string().max(4000) }),
  limits: z.object({
    guestPerHour: z.number().int().min(0),
    studentPerHour: z.number().int().min(0),
    adultPerHour: z.number().int().min(0),
    ipPerHour: z.number().int().min(0),
    schoolPerDay: z.number().int().min(0),
  }),
  /** Daily token budget (input + output); when spent the tutor goes offline (503). */
  dailyTokenBudget: z.number().int().min(0),
  stopTopics: z.array(z.string().min(1).max(100)).max(200),
  regressionQuestions: z
    .array(
      z.object({
        lang: LangSchema,
        question: z.string().min(1).max(2000),
        expectConcepts: z.array(KeySchema).optional(),
        /** v0.3.0: topic whose published package grounds the answer (else the run's `topicKey`). */
        topicKey: KeySchema.optional(),
      }),
    )
    .max(200),
  version: VersionTagSchema,
});
export type TutorSettings = z.infer<typeof TutorSettingsSchema>;

// ---------------------------------------------------------------------------
// v0.3.0 (additive)
// ---------------------------------------------------------------------------

// Review comments (A-14): GET/POST /admin/review-comments, PATCH /admin/review-comments/:id
export const ReviewCommentListQuerySchema = PageQuerySchema.extend({
  targetType: ReviewTargetTypeSchema.optional(),
  targetId: IdSchema.optional(),
  /** true = only resolved, false = only open. */
  resolved: QueryBoolSchema.optional(),
  authorId: IdSchema.optional(),
});
export const ReviewCommentListSchema = cursorPage(ReviewCommentSchema);
export const ReviewCommentCreateSchema = z.object({
  targetType: ReviewTargetTypeSchema,
  targetId: IdSchema,
  path: z.string().max(500),
  anchor3d: z.tuple([z.number(), z.number(), z.number()]).optional(),
  body: z.string().trim().min(1).max(4000),
  /** Topic comments: the version the reviewer looked at (default: the latest). */
  topicVersion: SemverSchema.optional(),
});
/** Resolve / reopen (`resolved`), or edit the text (author only). */
export const ReviewCommentPatchSchema = z
  .object({ resolved: z.boolean().optional(), body: z.string().trim().min(1).max(4000).optional() })
  .refine((v) => v.resolved !== undefined || v.body !== undefined, { message: 'resolved or body is required' });

// Assets (A-05): versions, multipart completion, list filters
export const AssetListQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  ...sortQuery(['key', 'status', 'sizeBefore', 'sizeAfter', 'triangles', 'violations', 'filename', 'createdAt'] as const),
});
export const AssetVersionSchema = z.object({
  assetId: IdSchema,
  version: z.number().int().min(1),
  filename: z.string(),
  contentType: z.string(),
  status: z.enum(ASSET_STATUSES),
  sizeBefore: z.number().int().min(0),
  sizeAfter: z.number().int().min(0).optional(),
  triangles: z.number().int().min(0).optional(),
  nodes: z.array(z.string()),
  violations: z.array(z.string()),
  thumbUrl: z.string().optional(),
  message: z.string().optional(),
  createdAt: DateTimeSchema,
  createdBy: IdSchema,
  completedAt: DateTimeSchema.optional(),
  /** This is the asset's current version. */
  current: z.boolean(),
});
export type AssetVersion = z.infer<typeof AssetVersionSchema>;
export const AssetVersionListSchema = z.object({ items: z.array(AssetVersionSchema) });
/** POST /admin/assets/:id/versions — upload a new file for an existing asset (same key). */
export const AssetVersionCreateRequestSchema = AssetUploadRequestSchema.pick({ filename: true, size: true, contentType: true }).extend({
  /** Rights change with the new file (otherwise the asset's are kept). */
  license: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  message: z.string().max(2000).optional(),
});
/** POST /admin/assets/:id/complete — finish the presigned multipart upload of the current version. */
export const AssetCompleteRequestSchema = z.object({
  /** Must match the upload's id when given. */
  uploadId: z.string().min(1).optional(),
  /** Uploaded parts (ETag from each part PUT); empty for storages without multipart (`partUrls: []`). */
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .max(10_000),
});

// Students: audited reveal of a pseudonymised pupil with grounds (A-16 «кроме запросов с основанием»)
export const REVEAL_GROUNDS = ['parent_request', 'school_request', 'legal_request', 'safeguarding', 'support_incident'] as const;
export const StudentRevealRequestSchema = z.object({
  ground: z.enum(REVEAL_GROUNDS),
  /** Why the real name is needed (stored in the audit log). */
  reason: z.string().trim().min(10).max(1000),
  /** Letter / ticket number of the request. */
  reference: z.string().trim().max(200).optional(),
});
export const StudentRevealSchema = z.object({
  userId: IdSchema,
  displayName: z.string(),
  classes: z.array(z.object({ classId: IdSchema, className: z.string(), schoolId: IdSchema, schoolName: z.string().optional() })),
  revealedAt: DateTimeSchema,
  /** Id of the audit entry that records this access. */
  auditId: IdSchema,
});
export type StudentReveal = z.infer<typeof StudentRevealSchema>;

// Tutor regression (A-18): POST /admin/tutor-settings/regression
export const TUTOR_REGRESSION_MAX = 50;
export const TutorRegressionRequestSchema = z.object({
  /** Default topic for questions without `topicKey`. */
  topicKey: KeySchema.optional(),
  /** Indexes into `regressionQuestions` (default: all, at most TUTOR_REGRESSION_MAX per run). */
  indexes: z.array(z.number().int().min(0)).min(1).max(TUTOR_REGRESSION_MAX).optional(),
});
export const TutorRegressionItemSchema = z.object({
  index: z.number().int().min(0),
  lang: LangSchema,
  question: z.string(),
  topicKey: KeySchema.optional(),
  answer: z.string(),
  /** Concept keys cited by the answer. */
  citations: z.array(KeySchema),
  expectConcepts: z.array(KeySchema),
  /** Expected concepts that were not cited. */
  missing: z.array(KeySchema),
  /** Answered (not refused, not «no answer»), no provider error, nothing missing. */
  passed: z.boolean(),
  refused: z.boolean(),
  noAnswer: z.boolean(),
  /** `topic_not_found`, `provider_error`, `no_topic`… */
  error: z.string().optional(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export const TutorRegressionResultSchema = z.object({
  ranAt: DateTimeSchema,
  model: z.string(),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  items: z.array(TutorRegressionItemSchema),
});
export type TutorRegressionResult = z.infer<typeof TutorRegressionResultSchema>;
