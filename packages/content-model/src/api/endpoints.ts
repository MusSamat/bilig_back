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
import { API_PREFIX, EmptySchema, HealthResponseSchema, OkSchema, PageQuerySchema, cursorPage } from './common.js';
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
  adminTopicList: e({ method: 'GET', path: '/admin/topics', auth: 'content.draft.edit', query: PageQuerySchema, response: admin.AdminTopicListSchema }),
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
  adminUsers: e({ method: 'GET', path: '/admin/users', auth: 'school.teachers.manage', query: PageQuerySchema, response: admin.AdminUserListSchema }),
  adminInviteCreate: e({ method: 'POST', path: '/admin/invites', auth: 'school.teachers.manage', body: admin.InviteCreateRequestSchema, response: OkSchema }),
  adminAudit: e({ method: 'GET', path: '/admin/audit', auth: 'audit.view', query: PageQuerySchema, response: admin.AuditListSchema }),
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
