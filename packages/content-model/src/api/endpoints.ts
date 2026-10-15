/**
 * The route table (TZ §9). Server routes and the client API wrapper are both
 * derived from this map, so a contract drift fails to compile. `auth` is the
 * permission checked by the backend (null = public, 'session' = any signed-in user).
 */
import { z } from 'zod';
import type { Permission } from '@bilig/permissions';
import { ConceptSchema } from '../concept.js';
import { ContentPackageSchema } from '../package.js';
import { ProcessSchema } from '../process.js';
import * as admin from './admin.js';
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import * as classes from './classes.js';
import {
  API_PREFIX,
  BinaryResponseSchema,
  EmptySchema,
  HealthResponseSchema,
  OkSchema,
  PageQuerySchema,
  ReadyResponseSchema,
  VersionResponseSchema,
  cursorPage,
} from './common.js';
import { CourseSchema, ObjectiveSchema, SubjectGroupSchema, UnitSchema } from '../curriculum.js';
import { GlossaryTermSchema } from '../glossary.js';
import { ItemSchema } from '../item.js';
import * as decks from './decks.js';
import * as learning from './learning.js';
import * as tutor from './tutor.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointDef {
  method: HttpMethod;
  /** Path under API_PREFIX with `:params`. */
  path: string;
  auth: Permission | 'session' | null;
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  /** Response is an SSE stream of this schema (JSON mode uses `response`). */
  stream?: z.ZodTypeAny;
  /** Requires the Idempotency-Key header. */
  idempotent?: boolean;
  /** Requires If-Match with the entity version. */
  ifMatch?: boolean;
  /** Non-JSON response media type (PDF, PPTX, CSV…); `response` is then BinaryResponseSchema. */
  produces?: string;
}

const e = <T extends EndpointDef>(d: T): T => d;

export const ENDPOINTS = {
  // System
  health: e({ method: 'GET', path: '/health', auth: null, response: HealthResponseSchema }),

  // Auth
  login: e({ method: 'POST', path: '/auth/login', auth: null, body: auth.LoginRequestSchema, response: auth.TokenResponseSchema }),
  classCode: e({ method: 'POST', path: '/auth/class-code', auth: null, body: auth.ClassCodeRequestSchema, response: auth.ClassCodeResponseSchema }),
  studentLogin: e({ method: 'POST', path: '/auth/student-login', auth: null, body: auth.StudentLoginRequestSchema, response: auth.TokenResponseSchema }),
  refresh: e({ method: 'POST', path: '/auth/refresh', auth: null, body: EmptySchema, response: auth.TokenResponseSchema }),
  logout: e({ method: 'POST', path: '/auth/logout', auth: 'session', body: EmptySchema, response: OkSchema }),
  logoutAll: e({ method: 'POST', path: '/auth/logout-all', auth: 'session', body: EmptySchema, response: OkSchema }),
  passwordForgot: e({ method: 'POST', path: '/auth/password/forgot', auth: null, body: auth.PasswordForgotRequestSchema, response: OkSchema }),
  passwordReset: e({ method: 'POST', path: '/auth/password/reset', auth: null, body: auth.PasswordResetRequestSchema, response: OkSchema }),
  inviteAccept: e({ method: 'POST', path: '/auth/invites/:token/accept', auth: null, body: auth.InviteAcceptRequestSchema, response: auth.TokenResponseSchema }),

  // Me
  me: e({ method: 'GET', path: '/me', auth: 'session', response: auth.MeResponseSchema }),
  mePatch: e({ method: 'PATCH', path: '/me', auth: 'session', body: auth.MePatchRequestSchema, response: auth.MeResponseSchema }),
  meSessions: e({ method: 'GET', path: '/me/sessions', auth: 'session', response: auth.SessionsResponseSchema }),
  me2fa: e({ method: 'POST', path: '/me/2fa', auth: 'session', body: auth.TwoFactorRequestSchema, response: auth.TwoFactorResponseSchema }),

  // Catalog
  catalog: e({ method: 'GET', path: '/catalog', auth: 'demo.view', response: catalog.CatalogResponseSchema }),
  subjects: e({ method: 'GET', path: '/subjects', auth: 'demo.view', response: catalog.SubjectsResponseSchema }),
  subjectCourses: e({ method: 'GET', path: '/subjects/:key/courses', auth: 'demo.view', response: catalog.SubjectCoursesResponseSchema }),
  course: e({ method: 'GET', path: '/courses/:key', auth: 'demo.view', response: catalog.CourseDetailResponseSchema }),
  topicManifest: e({ method: 'GET', path: '/topics/:key/manifest', auth: 'demo.view', response: catalog.TopicManifestResponseSchema }),
  /** Dev/offline-server stand-in for the CDN package URL. */
  topicPackage: e({ method: 'GET', path: '/packages/:key', auth: 'demo.view', response: ContentPackageSchema }),
  search: e({ method: 'GET', path: '/search', auth: 'demo.view', query: catalog.SearchQuerySchema, response: catalog.SearchResponseSchema }),

  // Learning
  progressGet: e({ method: 'GET', path: '/progress/:topicKey', auth: 'topic.view', response: learning.ProgressSchema }),
  progressPut: e({ method: 'PUT', path: '/progress/:topicKey', auth: 'topic.view', body: learning.ProgressPutRequestSchema, response: learning.ProgressSchema }),
  attemptCreate: e({ method: 'POST', path: '/attempts', auth: 'quiz.attempt.save', body: learning.AttemptCreateRequestSchema, response: learning.AttemptSchema }),
  attemptAnswer: e({ method: 'POST', path: '/attempts/:id/answers', auth: 'quiz.attempt.save', body: learning.AnswerSubmitRequestSchema, response: learning.AnswerResultSchema }),
  attemptFinish: e({ method: 'POST', path: '/attempts/:id/finish', auth: 'quiz.attempt.save', body: learning.AttemptFinishRequestSchema, response: learning.AttemptResultSchema }),
  sync: e({ method: 'POST', path: '/sync', auth: 'quiz.attempt.save', body: learning.SyncRequestSchema, response: learning.SyncResponseSchema, idempotent: true }),
  events: e({ method: 'POST', path: '/events', auth: null, body: learning.EventsBatchRequestSchema, response: learning.EventsBatchResponseSchema }),

  // Classes
  classList: e({ method: 'GET', path: '/classes', auth: 'class.manage', query: PageQuerySchema, response: cursorPage(classes.ClassSchema) }),
  classCreate: e({ method: 'POST', path: '/classes', auth: 'class.manage', body: classes.ClassCreateRequestSchema, response: classes.ClassSchema }),
  classPatch: e({ method: 'PATCH', path: '/classes/:id', auth: 'class.manage', body: classes.ClassPatchRequestSchema, response: classes.ClassSchema }),
  classJoinCode: e({ method: 'POST', path: '/classes/:id/join-code', auth: 'class.manage', body: EmptySchema, response: classes.JoinCodeResponseSchema }),
  classStudentsAdd: e({ method: 'POST', path: '/classes/:id/students', auth: 'class.manage', body: classes.StudentsAddRequestSchema, response: classes.StudentsAddResponseSchema }),
  studentResetPin: e({ method: 'POST', path: '/students/:id/reset-pin', auth: 'class.manage', body: EmptySchema, response: classes.ResetPinResponseSchema }),
  assignmentList: e({ method: 'GET', path: '/classes/:id/assignments', auth: 'assignment.manage', query: PageQuerySchema, response: cursorPage(classes.AssignmentSchema) }),
  assignmentCreate: e({ method: 'POST', path: '/classes/:id/assignments', auth: 'assignment.manage', body: classes.AssignmentCreateRequestSchema, response: classes.AssignmentSchema }),
  assignmentResults: e({ method: 'GET', path: '/assignments/:id/results', auth: 'assignment.manage', response: classes.AssignmentResultsSchema }),

  // Tutor
  tutorAsk: e({ method: 'POST', path: '/tutor/ask', auth: 'assistant.ask.online', body: tutor.TutorAskRequestSchema, response: tutor.TutorAskResponseSchema, stream: tutor.TutorStreamEventSchema }),

  // Decks
  presentationList: e({ method: 'GET', path: '/presentations', auth: 'session', query: PageQuerySchema, response: decks.PresentationListSchema }),
  presentationCreate: e({ method: 'POST', path: '/presentations', auth: 'session', body: decks.PresentationCreateRequestSchema, response: decks.PresentationSchema }),
  presentationGet: e({ method: 'GET', path: '/presentations/:id', auth: 'session', response: decks.PresentationSchema }),
  presentationPatch: e({ method: 'PATCH', path: '/presentations/:id', auth: 'session', body: decks.PresentationPatchRequestSchema, response: decks.PresentationSchema, ifMatch: true }),
  presentationExport: e({ method: 'POST', path: '/presentations/:id/export', auth: 'session', query: decks.ExportQuerySchema, body: EmptySchema, response: decks.ExportResponseSchema }),
  snapshotCreate: e({ method: 'POST', path: '/snapshots', auth: 'session', body: decks.SnapshotCreateRequestSchema, response: decks.SnapshotResponseSchema }),

  // Admin: content
  adminSubjectCreate: e({ method: 'POST', path: '/admin/subjects', auth: 'platform.manage', body: admin.AdminSubjectCreateSchema, response: admin.adminRecord(admin.AdminSubjectCreateSchema) }),
  adminSubjectPatch: e({ method: 'PATCH', path: '/admin/subjects/:key', auth: 'platform.manage', body: admin.AdminSubjectPatchSchema, response: admin.adminRecord(admin.AdminSubjectCreateSchema), ifMatch: true }),
  adminConceptCreate: e({ method: 'POST', path: '/admin/concepts', auth: 'content.draft.edit', body: admin.AdminConceptCreateSchema, response: admin.adminRecord(ConceptSchema) }),
  adminConceptPatch: e({ method: 'PATCH', path: '/admin/concepts/:key', auth: 'content.draft.edit', body: admin.AdminConceptPatchSchema, response: admin.adminRecord(ConceptSchema), ifMatch: true }),
  adminConceptUsage: e({ method: 'GET', path: '/admin/concepts/:key/usage', auth: 'content.draft.edit', response: admin.ConceptUsageSchema }),
  adminProcessCreate: e({ method: 'POST', path: '/admin/processes', auth: 'content.draft.edit', body: admin.AdminProcessCreateSchema, response: admin.adminRecord(ProcessSchema) }),
  adminItemCreate: e({ method: 'POST', path: '/admin/items', auth: 'content.draft.edit', body: admin.AdminItemSchema, response: admin.adminRecord(admin.AdminItemSchema) }),
  adminTopicList: e({ method: 'GET', path: '/admin/topics', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.AdminTopicListSchema }),
  adminTopicCreate: e({ method: 'POST', path: '/admin/topics', auth: 'content.draft.edit', body: admin.AdminTopicCreateSchema, response: admin.AdminTopicSchema }),
  adminTopicVersionCreate: e({ method: 'POST', path: '/admin/topics/:id/versions', auth: 'content.draft.edit', body: admin.TopicVersionCreateRequestSchema, response: admin.TopicVersionSchema, ifMatch: true }),
  adminTopicSubmit: e({ method: 'POST', path: '/admin/topics/:id/submit', auth: 'content.draft.edit', body: admin.SubmitRequestSchema, response: admin.WorkflowResponseSchema }),
  adminTopicReject: e({ method: 'POST', path: '/admin/topics/:id/reject', auth: 'content.publish', body: admin.RejectRequestSchema, response: admin.WorkflowResponseSchema }),
  adminTopicApprove: e({ method: 'POST', path: '/admin/topics/:id/approve', auth: 'content.publish', body: EmptySchema, response: admin.WorkflowResponseSchema }),
  adminTopicPublish: e({ method: 'POST', path: '/admin/topics/:id/publish', auth: 'content.publish', body: admin.PublishRequestSchema, response: admin.WorkflowResponseSchema }),
  adminTopicRollback: e({ method: 'POST', path: '/admin/topics/:id/rollback', auth: 'content.publish', body: admin.RollbackRequestSchema, response: admin.WorkflowResponseSchema }),
  adminGlossaryCreate: e({ method: 'POST', path: '/admin/glossary', auth: 'content.publish', body: admin.AdminGlossaryTermSchema, response: admin.adminRecord(admin.AdminGlossaryTermSchema) }),
  adminAssetUpload: e({ method: 'POST', path: '/admin/assets/uploads', auth: 'model.upload', body: admin.AssetUploadRequestSchema, response: admin.AssetUploadResponseSchema }),
  adminAssetGet: e({ method: 'GET', path: '/admin/assets/:id', auth: 'model.upload', response: admin.AssetReportSchema }),
  adminStrings: e({ method: 'GET', path: '/admin/strings', auth: 'content.draft.edit', query: admin.StringsQuerySchema, response: admin.StringsListSchema }),
  adminStringsPatch: e({ method: 'PATCH', path: '/admin/strings', auth: 'content.draft.edit', body: admin.StringsPatchRequestSchema, response: OkSchema }),

  // Admin: org & ops
  adminSchoolCreate: e({ method: 'POST', path: '/admin/schools', auth: 'platform.manage', body: admin.SchoolCreateSchema, response: admin.SchoolSchema }),
  adminLicenseCreate: e({ method: 'POST', path: '/admin/licenses', auth: 'platform.manage', body: admin.LicenseSchema, response: admin.LicenseSchema }),
  adminUsers: e({ method: 'GET', path: '/admin/users', auth: 'school.teachers.manage', query: admin.AdminUserListQuerySchema, response: admin.AdminUserListSchema }),
  adminInviteCreate: e({ method: 'POST', path: '/admin/invites', auth: 'school.teachers.manage', body: admin.InviteCreateRequestSchema, response: OkSchema }),
  adminAudit: e({ method: 'GET', path: '/admin/audit', auth: 'audit.view', query: admin.AuditQuerySchema, response: admin.AuditListSchema }),

  // ---------------------------------------------------------------------------
  // v0.2.1 (additive)
  // ---------------------------------------------------------------------------
  ready: e({ method: 'GET', path: '/ready', auth: null, response: ReadyResponseSchema }),
  version: e({ method: 'GET', path: '/version', auth: null, response: VersionResponseSchema }),

  register: e({ method: 'POST', path: '/auth/register', auth: null, body: auth.RegisterRequestSchema, response: OkSchema }),
  emailVerify: e({ method: 'POST', path: '/auth/email/verify', auth: null, body: auth.EmailVerifyRequestSchema, response: OkSchema }),
  meSessionRevoke: e({ method: 'DELETE', path: '/me/sessions/:id', auth: 'session', response: OkSchema }),
  meAssignments: e({ method: 'GET', path: '/me/assignments', auth: 'session', response: classes.MyAssignmentsResponseSchema }),

  classGet: e({ method: 'GET', path: '/classes/:id', auth: 'class.manage', response: classes.ClassSchema }),
  classStudents: e({ method: 'GET', path: '/classes/:id/students', auth: 'class.manage', query: PageQuerySchema, response: cursorPage(classes.StudentSchema) }),
  classLoginCards: e({ method: 'POST', path: '/classes/:id/login-cards', auth: 'class.manage', body: classes.LoginCardsRequestSchema, response: BinaryResponseSchema, produces: 'application/pdf' }),
  studentPatch: e({ method: 'PATCH', path: '/students/:id', auth: 'class.manage', body: classes.StudentPatchRequestSchema, response: classes.StudentSchema }),
  studentDelete: e({ method: 'DELETE', path: '/students/:id', auth: 'class.manage', response: OkSchema }),

  presentationDelete: e({ method: 'DELETE', path: '/presentations/:id', auth: 'session', response: OkSchema }),
  snapshotGet: e({ method: 'GET', path: '/snapshots/:id', auth: 'session', response: decks.SnapshotResponseSchema }),

  // Admin: program structure & dictionary (generic CRUD; PATCH/DELETE need If-Match)
  adminGroupList: e({ method: 'GET', path: '/admin/groups', auth: 'platform.manage', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(SubjectGroupSchema) }),
  adminGroupCreate: e({ method: 'POST', path: '/admin/groups', auth: 'platform.manage', body: admin.AdminSubjectGroupSchema, response: admin.adminRecord(SubjectGroupSchema) }),
  adminGroupPatch: e({ method: 'PATCH', path: '/admin/groups/:key', auth: 'platform.manage', body: admin.AdminSubjectGroupPatchSchema, response: admin.adminRecord(SubjectGroupSchema), ifMatch: true }),
  adminGroupDelete: e({ method: 'DELETE', path: '/admin/groups/:key', auth: 'platform.manage', response: OkSchema, ifMatch: true }),
  adminSubjectList: e({ method: 'GET', path: '/admin/subjects', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(admin.AdminSubjectCreateSchema) }),
  adminSubjectGet: e({ method: 'GET', path: '/admin/subjects/:key', auth: 'content.draft.edit', response: admin.adminRecord(admin.AdminSubjectCreateSchema) }),
  adminSubjectDelete: e({ method: 'DELETE', path: '/admin/subjects/:key', auth: 'platform.manage', response: OkSchema, ifMatch: true }),
  adminCourseList: e({ method: 'GET', path: '/admin/courses', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(CourseSchema) }),
  adminCourseGet: e({ method: 'GET', path: '/admin/courses/:key', auth: 'content.draft.edit', response: admin.adminRecord(CourseSchema) }),
  adminCourseCreate: e({ method: 'POST', path: '/admin/courses', auth: 'content.draft.edit', body: admin.AdminCourseCreateSchema, response: admin.adminRecord(CourseSchema) }),
  adminCoursePatch: e({ method: 'PATCH', path: '/admin/courses/:key', auth: 'content.draft.edit', body: admin.AdminCoursePatchSchema, response: admin.adminRecord(CourseSchema), ifMatch: true }),
  adminCourseDelete: e({ method: 'DELETE', path: '/admin/courses/:key', auth: 'content.draft.edit', response: OkSchema, ifMatch: true }),
  adminUnitList: e({ method: 'GET', path: '/admin/units', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(UnitSchema) }),
  adminUnitGet: e({ method: 'GET', path: '/admin/units/:key', auth: 'content.draft.edit', response: admin.adminRecord(UnitSchema) }),
  adminUnitCreate: e({ method: 'POST', path: '/admin/units', auth: 'content.draft.edit', body: admin.AdminUnitCreateSchema, response: admin.adminRecord(UnitSchema) }),
  adminUnitPatch: e({ method: 'PATCH', path: '/admin/units/:key', auth: 'content.draft.edit', body: admin.AdminUnitPatchSchema, response: admin.adminRecord(UnitSchema), ifMatch: true }),
  adminUnitDelete: e({ method: 'DELETE', path: '/admin/units/:key', auth: 'content.draft.edit', response: OkSchema, ifMatch: true }),
  adminObjectiveList: e({ method: 'GET', path: '/admin/objectives', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(ObjectiveSchema) }),
  adminObjectiveGet: e({ method: 'GET', path: '/admin/objectives/:key', auth: 'content.draft.edit', response: admin.adminRecord(ObjectiveSchema) }),
  adminObjectiveCreate: e({ method: 'POST', path: '/admin/objectives', auth: 'content.draft.edit', body: admin.AdminObjectiveCreateSchema, response: admin.adminRecord(ObjectiveSchema) }),
  adminObjectivePatch: e({ method: 'PATCH', path: '/admin/objectives/:key', auth: 'content.draft.edit', body: admin.AdminObjectivePatchSchema, response: admin.adminRecord(ObjectiveSchema), ifMatch: true }),
  adminObjectiveDelete: e({ method: 'DELETE', path: '/admin/objectives/:key', auth: 'content.draft.edit', response: OkSchema, ifMatch: true }),
  adminConceptList: e({ method: 'GET', path: '/admin/concepts', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(ConceptSchema) }),
  adminConceptGet: e({ method: 'GET', path: '/admin/concepts/:key', auth: 'content.draft.edit', response: admin.adminRecord(ConceptSchema) }),
  /** 409 `in_use` while any topic version references the concept (A-04). */
  adminConceptDelete: e({ method: 'DELETE', path: '/admin/concepts/:key', auth: 'content.draft.edit', response: OkSchema, ifMatch: true }),
  adminProcessList: e({ method: 'GET', path: '/admin/processes', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(ProcessSchema) }),
  adminProcessGet: e({ method: 'GET', path: '/admin/processes/:key', auth: 'content.draft.edit', response: admin.adminRecord(ProcessSchema) }),
  adminProcessPatch: e({ method: 'PATCH', path: '/admin/processes/:key', auth: 'content.draft.edit', body: admin.AdminProcessPatchSchema, response: admin.adminRecord(ProcessSchema), ifMatch: true }),
  adminProcessDelete: e({ method: 'DELETE', path: '/admin/processes/:key', auth: 'content.draft.edit', response: OkSchema, ifMatch: true }),
  adminItemList: e({ method: 'GET', path: '/admin/items', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.adminRecordPage(ItemSchema) }),
  adminItemGet: e({ method: 'GET', path: '/admin/items/:key', auth: 'content.draft.edit', response: admin.adminRecord(ItemSchema) }),
  adminItemPatch: e({ method: 'PATCH', path: '/admin/items/:key', auth: 'content.draft.edit', body: admin.AdminItemPatchSchema, response: admin.adminRecord(ItemSchema), ifMatch: true }),
  adminItemDelete: e({ method: 'DELETE', path: '/admin/items/:key', auth: 'content.draft.edit', response: OkSchema, ifMatch: true }),
  adminItemStats: e({ method: 'GET', path: '/admin/items/:key/stats', auth: 'content.draft.edit', response: admin.ItemStatsSchema }),

  // Admin: topics & workflow
  adminTopicGet: e({ method: 'GET', path: '/admin/topics/:id', auth: 'content.draft.edit', response: admin.AdminTopicDetailSchema }),
  adminTopicPatch: e({ method: 'PATCH', path: '/admin/topics/:id', auth: 'content.draft.edit', body: admin.AdminTopicPatchSchema, response: admin.AdminTopicDetailSchema, ifMatch: true }),
  adminTopicDelete: e({ method: 'DELETE', path: '/admin/topics/:id', auth: 'content.publish', response: OkSchema, ifMatch: true }),
  adminTopicVersions: e({ method: 'GET', path: '/admin/topics/:id/versions', auth: 'content.draft.edit', response: admin.TopicVersionListSchema }),
  adminTopicVersionGet: e({ method: 'GET', path: '/admin/topics/:id/versions/:version', auth: 'content.draft.edit', response: admin.TopicVersionSchema }),
  adminTopicDiff: e({ method: 'GET', path: '/admin/topics/:id/diff', auth: 'content.draft.edit', query: admin.TopicDiffQuerySchema, response: admin.TopicDiffSchema }),
  adminTopicChecklist: e({ method: 'GET', path: '/admin/topics/:id/checklist', auth: 'content.draft.edit', response: admin.ChecklistSchema }),
  adminTopicArchive: e({ method: 'POST', path: '/admin/topics/:id/archive', auth: 'content.publish', body: admin.ArchiveRequestSchema, response: admin.WorkflowResponseSchema }),
  adminTopicRestore: e({ method: 'POST', path: '/admin/topics/:id/restore', auth: 'content.publish', body: EmptySchema, response: admin.WorkflowResponseSchema }),
  adminTourGet: e({ method: 'GET', path: '/admin/tours/:topicKey', auth: 'content.draft.edit', response: admin.TourResponseSchema }),
  adminTourPut: e({ method: 'PUT', path: '/admin/tours/:topicKey', auth: 'content.draft.edit', body: admin.TourPutRequestSchema, response: admin.TopicVersionSchema, ifMatch: true }),
  adminTourDelete: e({ method: 'DELETE', path: '/admin/tours/:topicKey', auth: 'content.draft.edit', response: admin.TopicVersionSchema, ifMatch: true }),
  adminComparisonGet: e({ method: 'GET', path: '/admin/comparisons/:topicKey', auth: 'content.draft.edit', response: admin.ComparisonResponseSchema }),
  adminComparisonPut: e({ method: 'PUT', path: '/admin/comparisons/:topicKey', auth: 'content.draft.edit', body: admin.ComparisonPutRequestSchema, response: admin.TopicVersionSchema, ifMatch: true }),
  adminComparisonDelete: e({ method: 'DELETE', path: '/admin/comparisons/:topicKey', auth: 'content.draft.edit', response: admin.TopicVersionSchema, ifMatch: true }),

  // Admin: assets
  adminAssetList: e({ method: 'GET', path: '/admin/assets', auth: 'model.upload', query: PageQuerySchema, response: admin.AssetListSchema }),
  /** Queue processing (validation, meshopt, KTX2, thumbnail). Stub report until bilig_worker exists. */
  adminAssetProcess: e({ method: 'POST', path: '/admin/assets/:id/process', auth: 'model.upload', body: EmptySchema, response: admin.AssetReportSchema }),

  // Admin: i18n
  adminStringsImport: e({ method: 'POST', path: '/admin/strings/import', auth: 'content.draft.edit', body: admin.StringsImportRequestSchema, response: admin.StringsImportResponseSchema }),
  adminStringsExport: e({ method: 'GET', path: '/admin/strings/export', auth: 'content.draft.edit', query: admin.StringsExportQuerySchema, response: BinaryResponseSchema, produces: 'text/csv' }),
  adminGlossaryList: e({ method: 'GET', path: '/admin/glossary', auth: 'content.draft.edit', query: admin.AdminListQuerySchema, response: admin.GlossaryListSchema }),
  adminGlossaryPatch: e({ method: 'PATCH', path: '/admin/glossary/:id', auth: 'content.publish', body: admin.AdminGlossaryPatchSchema, response: admin.adminRecord(GlossaryTermSchema), ifMatch: true }),
  adminGlossaryDelete: e({ method: 'DELETE', path: '/admin/glossary/:id', auth: 'content.publish', response: OkSchema, ifMatch: true }),

  // Admin: builds
  adminBuildList: e({ method: 'GET', path: '/admin/builds', auth: 'content.publish', query: admin.BuildListQuerySchema, response: admin.BuildListSchema }),
  adminBuildCreate: e({ method: 'POST', path: '/admin/builds/:topicVersionId', auth: 'content.publish', body: EmptySchema, response: admin.BuildSchema }),

  // Admin: org
  adminSchoolList: e({ method: 'GET', path: '/admin/schools', auth: 'school.teachers.manage', query: PageQuerySchema, response: admin.SchoolListSchema }),
  adminSchoolGet: e({ method: 'GET', path: '/admin/schools/:id', auth: 'school.teachers.manage', response: admin.SchoolSchema }),
  adminSchoolPatch: e({ method: 'PATCH', path: '/admin/schools/:id', auth: 'platform.manage', body: admin.SchoolPatchSchema, response: admin.SchoolSchema }),
  adminLicenseList: e({ method: 'GET', path: '/admin/licenses', auth: 'school.teachers.manage', query: admin.LicenseListQuerySchema, response: admin.LicenseListSchema }),
  adminLicensePatch: e({ method: 'PATCH', path: '/admin/licenses/:id', auth: 'platform.manage', body: admin.LicensePatchSchema, response: admin.LicenseSchema }),
  adminLicenseDelete: e({ method: 'DELETE', path: '/admin/licenses/:id', auth: 'platform.manage', response: OkSchema }),
  adminUserGet: e({ method: 'GET', path: '/admin/users/:id', auth: 'school.teachers.manage', response: admin.AdminUserSchema }),
  adminUserPatch: e({ method: 'PATCH', path: '/admin/users/:id', auth: 'school.teachers.manage', body: admin.AdminUserPatchSchema, response: admin.AdminUserSchema }),
  adminUserGrants: e({ method: 'PUT', path: '/admin/users/:id/grants', auth: 'school.teachers.manage', body: admin.UserGrantsPutSchema, response: admin.AdminUserSchema }),
  adminUserRevokeSessions: e({ method: 'POST', path: '/admin/users/:id/revoke-sessions', auth: 'school.teachers.manage', body: EmptySchema, response: OkSchema }),
  adminUserReset2fa: e({ method: 'POST', path: '/admin/users/:id/reset-2fa', auth: 'platform.manage', body: EmptySchema, response: OkSchema }),
  adminUserPasswordReset: e({ method: 'POST', path: '/admin/users/:id/password-reset', auth: 'school.teachers.manage', body: EmptySchema, response: OkSchema }),
  adminInviteList: e({ method: 'GET', path: '/admin/invites', auth: 'school.teachers.manage', query: PageQuerySchema, response: admin.InviteListSchema }),

  // Admin: ops
  adminAnalyticsOverview: e({ method: 'GET', path: '/admin/analytics/overview', auth: 'platform.manage', query: admin.AnalyticsQuerySchema, response: admin.AnalyticsOverviewSchema }),
  adminTutorSettingsGet: e({ method: 'GET', path: '/admin/tutor-settings', auth: 'platform.manage', response: admin.TutorSettingsSchema }),
  adminTutorSettingsPut: e({ method: 'PUT', path: '/admin/tutor-settings', auth: 'platform.manage', body: admin.TutorSettingsSchema, response: admin.TutorSettingsSchema, ifMatch: true }),
} as const satisfies Record<string, EndpointDef>;

export type EndpointName = keyof typeof ENDPOINTS;
type Def<N extends EndpointName> = (typeof ENDPOINTS)[N];
export type EndpointBody<N extends EndpointName> = Def<N> extends { body: z.ZodTypeAny } ? z.input<Def<N>['body']> : never;
export type EndpointResponse<N extends EndpointName> = z.infer<Def<N>['response']>;

/** Fill `:params` in a path (values are URI-encoded). Throws on a missing param. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`Missing path param "${name}"`);
    return encodeURIComponent(v);
  });
}

/** Fastify/Express-style path (same `:param` syntax) under the API prefix. */
export const routePath = (name: EndpointName, prefix = API_PREFIX): string => prefix + ENDPOINTS[name].path;
