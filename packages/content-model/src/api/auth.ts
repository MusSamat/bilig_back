/**
 * Auth & profile DTOs (TZ §6, §9 Auth/Me). Refresh tokens travel only in an
 * HttpOnly cookie, never in a body.
 */
import { z } from 'zod';
import {
  AUTHOR_SUBROLES,
  PERMISSIONS,
  ROLES,
  SCOPES,
  type AuthorSubrole,
  type Permission,
  type Role,
  type RoleGrant,
  type Scope,
} from '@bilig/permissions';
import { LangSchema } from '../i18n.js';
import { DateTimeSchema, IdSchema } from './common.js';

const tuple = <T extends string>(xs: readonly T[]) => xs as unknown as [T, ...T[]];

export const RoleSchema = z.enum(tuple<Role>(ROLES));
export const ScopeSchema = z.enum(tuple<Scope>(SCOPES));
export const AuthorSubroleSchema = z.enum(tuple<AuthorSubrole>(AUTHOR_SUBROLES));
export const PermissionSchema = z.enum(tuple<Permission>(PERMISSIONS));

export const RoleGrantSchema: z.ZodType<RoleGrant> = z.object({
  role: RoleSchema,
  scope: ScopeSchema,
  scopeId: z.string().min(1).optional(),
  subrole: AuthorSubroleSchema.optional(),
});

export const PasswordSchema = z.string().min(10).max(256);
export const EmailSchema = z.string().email().max(254);
/** Class join code: 6 characters, case-insensitive (normalized to upper). */
export const ClassCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{6}$/));
export const PinSchema = z.string().regex(/^\d{4,6}$/);
export const TotpSchema = z.string().regex(/^\d{6}$/);

// POST /auth/login
export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(256),
  totp: TotpSchema.optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserKindSchema = z.enum(['adult', 'student']);
export type UserKind = z.infer<typeof UserKindSchema>;

/** Access token response (login, student-login, refresh). */
export const TokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  /** Seconds (15 min for access tokens). */
  expiresIn: z.number().int().positive(),
  /** True when the account needs a TOTP code to finish login (admin). */
  totpRequired: z.boolean().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// POST /auth/class-code
export const ClassCodeRequestSchema = z.object({ code: ClassCodeSchema });
export type ClassCodeRequest = z.infer<typeof ClassCodeRequestSchema>;
export const ClassCodeResponseSchema = z.object({
  classId: IdSchema,
  className: z.string(),
  students: z.array(z.object({ id: IdSchema, displayName: z.string() })),
});
export type ClassCodeResponse = z.infer<typeof ClassCodeResponseSchema>;

// POST /auth/student-login
export const StudentLoginRequestSchema = z.object({
  classId: IdSchema,
  studentId: IdSchema,
  pin: PinSchema,
});
export type StudentLoginRequest = z.infer<typeof StudentLoginRequestSchema>;

// POST /auth/refresh, /auth/logout, /auth/logout-all: empty body, cookie-based.
// POST /auth/password/forgot, /auth/password/reset
export const PasswordForgotRequestSchema = z.object({ email: EmailSchema });
export const PasswordResetRequestSchema = z.object({ token: z.string().min(1), password: PasswordSchema });
// POST /auth/invites/:token/accept
export const InviteAcceptRequestSchema = z.object({
  displayName: z.string().min(1).max(100),
  password: PasswordSchema,
});

// GET /me
export const MeResponseSchema = z.object({
  id: IdSchema,
  kind: UserKindSchema,
  displayName: z.string(),
  email: EmailSchema.optional(),
  locale: LangSchema,
  grants: z.array(RoleGrantSchema),
  /** `grantedPermissions(principal)` — the FE hides buttons from this list. */
  permissions: z.array(PermissionSchema),
  totpEnabled: z.boolean().optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// PATCH /me
export const MePatchRequestSchema = z
  .object({ displayName: z.string().min(1).max(100), locale: LangSchema })
  .partial();
export type MePatchRequest = z.infer<typeof MePatchRequestSchema>;

// GET /me/sessions
export const SessionInfoSchema = z.object({
  id: IdSchema,
  device: z.string(),
  ip: z.string().optional(),
  createdAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export const SessionsResponseSchema = z.object({ items: z.array(SessionInfoSchema) });

// POST /me/2fa  (setup → verify)
export const TwoFactorRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setup') }),
  z.object({ action: z.literal('verify'), code: TotpSchema }),
  z.object({ action: z.literal('disable'), code: TotpSchema }),
]);
export const TwoFactorResponseSchema = z.object({
  enabled: z.boolean(),
  otpauthUrl: z.string().optional(),
});

// ---------------------------------------------------------------------------
// v0.2.1 (additive)
// ---------------------------------------------------------------------------

// POST /auth/register — teacher self-registration; the e-mail must be verified before login.
export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(100),
  locale: LangSchema.optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

// POST /auth/email/verify
export const EmailVerifyRequestSchema = z.object({ token: z.string().min(1).max(200) });
