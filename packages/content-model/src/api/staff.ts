/**
 * v0.8.0: roles, the teacher cabinet from the admin, and the action journal.
 * Three working roles: teacher, manager, SuperAdmin. Staff (manager,
 * SuperAdmin) sign in only at /admin (e-mail + password + TOTP); a manager
 * holds the permissions SuperAdmin ticked (RoleGrant.permissions). Support
 * opens a teacher's cabinet through a short impersonation session; every
 * action is written to an append-only, hash-chained journal.
 */
import { z } from 'zod';
import { PERMISSIONS, type Permission } from '@bilig/permissions';
import { KeySchema } from '../common.js';
import { DateTimeSchema, IdSchema, cursorPage } from './common.js';
import { EmailSchema, TotpSchema } from './auth.js';

const tuple = <T extends string>(xs: readonly T[]) => xs as unknown as [T, ...T[]];
const PermissionEnum = z.enum(tuple<Permission>(PERMISSIONS));

// ---------------------------------------------------------------------------
// Staff (managers and SuperAdmins) — staff.manage
// ---------------------------------------------------------------------------
export const STAFF_ROLES = ['manager', 'superadmin'] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const STAFF_STATUSES = ['invited', 'active', 'blocked', 'deleted'] as const;
export const StaffStatusSchema = z.enum(STAFF_STATUSES);

export const StaffMemberSchema = z.object({
  userId: IdSchema,
  email: EmailSchema,
  displayName: z.string(),
  role: StaffRoleSchema,
  /** The ticked permissions (managers); empty for SuperAdmin (they hold everything). */
  permissions: z.array(PermissionEnum),
  status: StaffStatusSchema,
  totpEnabled: z.boolean(),
  createdAt: DateTimeSchema,
  createdBy: IdSchema.nullable(),
  lastLoginAt: DateTimeSchema.nullable(),
});
export type StaffMember = z.infer<typeof StaffMemberSchema>;
export const StaffListSchema = z.object({ items: z.array(StaffMemberSchema) });
export type StaffList = z.infer<typeof StaffListSchema>;

/** POST /admin/staff/invites — SuperAdmin invites a manager; they set the password and TOTP themselves. */
export const StaffInviteRequestSchema = z.object({
  email: EmailSchema,
  displayName: z.string().trim().min(2).max(100),
  /** Must be a subset of MANAGER_ASSIGNABLE. */
  permissions: z.array(PermissionEnum).max(PERMISSIONS.length),
});
export type StaffInviteRequest = z.infer<typeof StaffInviteRequestSchema>;

/** PATCH /admin/staff/:userId — never on yourself. */
export const StaffPatchRequestSchema = z.object({
  permissions: z.array(PermissionEnum).max(PERMISSIONS.length).optional(),
  displayName: z.string().trim().min(2).max(100).optional(),
  /** Why (written to the journal). */
  reason: z.string().trim().min(3).max(500),
});
export type StaffPatchRequest = z.infer<typeof StaffPatchRequestSchema>;

/** POST /admin/staff/:userId/{block,restore,delete} — never on yourself; never below two active SuperAdmins. */
export const StaffActionRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type StaffActionRequest = z.infer<typeof StaffActionRequestSchema>;

// ---------------------------------------------------------------------------
// Teachers — teacher.view
// ---------------------------------------------------------------------------
/** Minimum profile: full name, school, teaching language, at least one class with a subject. */
export const TEACHING_LANGS = ['ky', 'ru', 'uz', 'en'] as const;
export const TeachingLangSchema = z.enum(TEACHING_LANGS);
export type TeachingLang = z.infer<typeof TeachingLangSchema>;

export const ProfileSetupSchema = z.object({
  name: z.boolean(),
  school: z.boolean(),
  teachingLang: z.boolean(),
  /** At least one class with at least one subject. */
  classWithSubject: z.boolean(),
});
export type ProfileSetup = z.infer<typeof ProfileSetupSchema>;
export const PROFILE_STATUSES = ['incomplete', 'complete'] as const;
export const ProfileStatusSchema = z.enum(PROFILE_STATUSES);

export const TeacherSummarySchema = z.object({
  id: IdSchema,
  displayName: z.string(),
  phone: z.string().nullable(),
  email: EmailSchema.nullable(),
  schoolName: z.string(),
  region: z.string(),
  teachingLang: TeachingLangSchema.nullable(),
  classes: z.number().int().min(0),
  subjects: z.array(KeySchema),
  profileStatus: ProfileStatusSchema,
  status: z.enum(['active', 'blocked', 'deleted']),
  createdAt: DateTimeSchema,
  lastActiveAt: DateTimeSchema.nullable(),
});
export type TeacherSummary = z.infer<typeof TeacherSummarySchema>;

export const TeacherListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'blocked', 'deleted']).optional(),
  profileStatus: ProfileStatusSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type TeacherListQuery = z.infer<typeof TeacherListQuerySchema>;
export const TeacherListSchema = cursorPage(TeacherSummarySchema);

// ---------------------------------------------------------------------------
// Support: the teacher's cabinet from the admin (impersonation)
// ---------------------------------------------------------------------------
export const SUPPORT_MODES = ['view', 'edit'] as const;
export const SupportModeSchema = z.enum(SUPPORT_MODES);
export type SupportMode = z.infer<typeof SupportModeSchema>;

/**
 * POST /admin/teachers/:id/support — teacher.view (view) / teacher.edit (edit).
 * Edit needs a reason and the staff member's TOTP again. Never a staff account.
 */
export const SupportStartRequestSchema = z
  .object({
    mode: SupportModeSchema,
    reason: z.string().trim().max(500).optional(),
    totp: TotpSchema.optional(),
  })
  .refine((b) => b.mode === 'view' || ((b.reason ?? '').length >= 10 && !!b.totp), {
    message: 'Edit mode needs a reason (≥ 10 characters) and the 2FA code',
    path: ['reason'],
  });
export type SupportStartRequest = z.infer<typeof SupportStartRequestSchema>;

export const SupportSessionSchema = z.object({
  id: IdSchema,
  mode: SupportModeSchema,
  teacher: z.object({ id: IdSchema, displayName: z.string() }),
  actor: z.object({ id: IdSchema, displayName: z.string(), role: StaffRoleSchema }),
  reason: z.string().nullable(),
  startedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  endedAt: DateTimeSchema.nullable(),
});
export type SupportSession = z.infer<typeof SupportSessionSchema>;

/**
 * The start response carries a client-audience access token: sub = the
 * teacher, act = the staff member, mode, 15–30 min, no refresh. Forbidden in
 * every mode: password, phone, e-mail, 2FA, account deletion, payment; view
 * mode: every write.
 */
export const SupportStartResponseSchema = z.object({
  session: SupportSessionSchema,
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});
export type SupportStartResponse = z.infer<typeof SupportStartResponseSchema>;

// ---------------------------------------------------------------------------
// Journal — audit.read (manager: own records; SuperAdmin: all)
// ---------------------------------------------------------------------------
export const AUDIT_GROUPS = ['auth', 'staff', 'support', 'content', 'teacher_data', 'export', 'deletion'] as const;
export const AuditGroupSchema = z.enum(AUDIT_GROUPS);
export type AuditGroup = z.infer<typeof AuditGroupSchema>;

export const AuditEventSchema = z.object({
  id: IdSchema,
  /** Monotonic position in the chain. */
  seq: z.number().int().min(1),
  at: DateTimeSchema,
  actor: z.object({ id: IdSchema.nullable(), displayName: z.string().nullable(), role: z.string().nullable() }),
  /** Support sessions: the teacher in whose name the action was done. */
  onBehalfOf: z.object({ id: IdSchema, displayName: z.string() }).nullable(),
  group: AuditGroupSchema,
  /** `content.published`, `support.started`, `staff.blocked` … */
  action: z.string(),
  target: z.object({ type: z.string(), id: z.string(), label: z.string().nullable() }),
  /** Values before / after (secrets never written). */
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  result: z.enum(['ok', 'denied', 'failed']),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  supportSessionId: IdSchema.nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEventQuerySchema = z.object({
  actorId: IdSchema.optional(),
  onBehalfOfId: IdSchema.optional(),
  group: AuditGroupSchema.optional(),
  action: z.string().max(80).optional(),
  targetType: z.string().max(40).optional(),
  targetId: z.string().max(80).optional(),
  from: DateTimeSchema.optional(),
  to: DateTimeSchema.optional(),
  result: z.enum(['ok', 'denied', 'failed']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type AuditEventQuery = z.infer<typeof AuditEventQuerySchema>;
export const AuditEventPageSchema = cursorPage(AuditEventSchema);

/** GET /admin/audit/verify — SuperAdmin: walks the hash chain. */
export const AuditVerifySchema = z.object({
  ok: z.boolean(),
  checked: z.number().int().min(0),
  /** First event whose hash does not match. */
  brokenAt: z.number().int().nullable(),
});

/** Alerts for SuperAdmin (e.g. mass deletion: ≥ N deletions by one actor within a window). */
export const AuditAlertSchema = z.object({
  id: IdSchema,
  at: DateTimeSchema,
  kind: z.enum(['mass_deletion', 'chain_broken', 'support_edit']),
  actor: z.object({ id: IdSchema.nullable(), displayName: z.string().nullable() }),
  summary: z.string(),
  seenAt: DateTimeSchema.nullable(),
});
export const AuditAlertListSchema = z.object({ items: z.array(AuditAlertSchema) });

// ---------------------------------------------------------------------------
// Deletion requests — a manager asks, SuperAdmin deletes
// ---------------------------------------------------------------------------
export const DELETION_KINDS = ['teacher', 'topic', 'concept', 'item', 'asset'] as const;
export const DeletionKindSchema = z.enum(DELETION_KINDS);
export const DeletionRequestSchema = z.object({
  id: IdSchema,
  kind: DeletionKindSchema,
  targetId: z.string().min(1).max(120),
  targetLabel: z.string(),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  requestedBy: z.object({ id: IdSchema, displayName: z.string() }),
  requestedAt: DateTimeSchema,
  decidedBy: z.object({ id: IdSchema, displayName: z.string() }).nullable(),
  decidedAt: DateTimeSchema.nullable(),
  decisionNote: z.string().nullable(),
});
export type DeletionRequest = z.infer<typeof DeletionRequestSchema>;
export const DeletionRequestCreateSchema = z.object({
  kind: DeletionKindSchema,
  targetId: z.string().min(1).max(120),
  reason: z.string().trim().min(10).max(1000),
});
export const DeletionDecisionSchema = z.object({ note: z.string().trim().max(1000).optional(), totp: TotpSchema });
export const DeletionListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const DeletionPageSchema = cursorPage(DeletionRequestSchema);

// ---------------------------------------------------------------------------
// Teacher home: classes → subjects
// ---------------------------------------------------------------------------
/** GET /classes/:id/subjects — what the teacher teaches in a class, with the КТП status. */
export const ClassSubjectSchema = z.object({
  subjectKey: KeySchema,
  ktp: z.object({
    status: z.enum(['none', 'parsed']),
    planId: IdSchema.nullable(),
    errors: z.number().int().min(0),
    warnings: z.number().int().min(0),
  }),
  /** The next lesson of this class and subject by the КТП date (today included). */
  nextLesson: z.object({ index: z.number().int().min(1), title: z.string(), date: z.string(), topicKey: KeySchema.nullable() }).nullable(),
  /** Lessons whose date has passed / all lessons in the КТП. */
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }),
});
export type ClassSubject = z.infer<typeof ClassSubjectSchema>;
export const ClassSubjectsResponseSchema = z.object({ items: z.array(ClassSubjectSchema) });

