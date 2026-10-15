/**
 * Admin DTOs (TZ §5, §9 Admin:*). Forms and validation in the admin are built
 * from the same schemas (TZ §5 «Принцип масштаба»).
 */
import { z } from 'zod';
import type { Permission } from '@bilig/permissions';
import { KeySchema, SemverSchema } from '../common.js';
import { ConceptSchema } from '../concept.js';
import { CourseSchema, ObjectiveSchema, SubjectSchema, UnitSchema } from '../curriculum.js';
import { GlossaryTermSchema } from '../glossary.js';
import { I18nStatusSchema, LangSchema } from '../i18n.js';
import { ItemSchema } from '../item.js';
import { ProcessSchema } from '../process.js';
import { ContentStatusSchema, TopicSchema, type ContentStatus } from '../topic.js';
import { AuthorSubroleSchema, EmailSchema, RoleGrantSchema, RoleSchema, ScopeSchema } from './auth.js';
import { DateTimeSchema, IdSchema, VersionTagSchema, cursorPage } from './common.js';

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

const withVersion = <T extends z.ZodRawShape>(s: z.ZodObject<T>) =>
  s.partial().extend({ version: VersionTagSchema });

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
export const ConceptUsageSchema = z.object({ conceptKey: KeySchema, topicKeys: z.array(KeySchema) });

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
export const ReviewCommentSchema = z.object({
  id: IdSchema,
  targetType: z.enum(['topic', 'concept', 'process', 'item']),
  targetId: IdSchema,
  path: z.string(),
  anchor3d: z.tuple([z.number(), z.number(), z.number()]).optional(),
  body: z.string().min(1).max(4000),
  resolvedAt: DateTimeSchema.optional(),
});

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
});
export const AssetReportSchema = z.object({
  id: IdSchema,
  key: KeySchema,
  status: z.enum(['uploaded', 'processing', 'ready', 'failed']),
  sizeBefore: z.number().int().min(0),
  sizeAfter: z.number().int().min(0).optional(),
  triangles: z.number().int().min(0).optional(),
  nodes: z.array(z.string()),
  violations: z.array(z.string()),
  thumbUrl: z.string().optional(),
});
export type AssetReport = z.infer<typeof AssetReportSchema>;

// Strings (A-11)
export const StringsQuerySchema = z.object({
  locale: LangSchema,
  status: I18nStatusSchema.optional(),
  untranslated: z.coerce.boolean().optional(),
  sourceChanged: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const LocaleStringSchema = z.object({
  key: z.string().min(1),
  locale: LangSchema,
  value: z.string(),
  status: I18nStatusSchema,
  sourceHash: z.string(),
  sourceChanged: z.boolean(),
});
export type LocaleString = z.infer<typeof LocaleStringSchema>;
export const StringsListSchema = cursorPage(LocaleStringSchema);
export const StringsPatchRequestSchema = z.object({
  items: z
    .array(z.object({ key: z.string().min(1), locale: LangSchema, value: z.string(), status: I18nStatusSchema }))
    .min(1)
    .max(1000),
});

// Org: schools, licenses, users, invites (A-15, A-16)
export const SchoolSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  region: z.string().min(1),
  type: z.enum(['state', 'private']),
  language: LangSchema,
  status: z.enum(['active', 'suspended']),
});
export type School = z.infer<typeof SchoolSchema>;
export const SchoolCreateSchema = SchoolSchema.omit({ id: true });
export const LicenseSchema = z
  .object({
    id: IdSchema,
    schoolId: IdSchema,
    subjects: z.array(KeySchema).min(1),
    grades: z.array(z.number().int().min(1).max(11)).min(1),
    seats: z.number().int().positive(),
    startsAt: DateTimeSchema,
    endsAt: DateTimeSchema,
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
  actorId: IdSchema,
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  diff: z.unknown().optional(),
  ip: z.string().optional(),
  ts: DateTimeSchema,
});
export const AuditListSchema = cursorPage(AuditEntrySchema);
