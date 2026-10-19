/** Environment configuration (parsed once with Zod; see .env.example). */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** `prisma` (PostgreSQL via DATABASE_URL) or `memory` (no persistence, dev only). */
  STORAGE: z.enum(['prisma', 'memory']).default('prisma'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Public base URL of this API (links in e-mails, file URLs). */
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  /** Client app URL used in verification / reset / invite links. */
  APP_URL: z.string().default('http://localhost:5173'),
  ADMIN_URL: z.string().default('http://localhost:5174'),
  /** Optional CDN base for packages: `${CDN_BASE_URL}/<hash>/package.json`. */
  CDN_BASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).optional(),
  /** HMAC key for learning-event pseudonyms (TZ §8). */
  PSEUDONYM_SECRET: z.string().min(16).optional(),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  STORAGE_DIR: z.string().default('./var/storage'),
  CONTENT_DIR: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * `anthropic` (needs ANTHROPIC_API_KEY), `dev` (answers and generates from the
   * package itself, no LLM; refused in production) or `none` (offline 503).
   * Unset: `anthropic` with a key, else `dev` in development, else `none`.
   */
  TUTOR_PROVIDER: z.enum(['anthropic', 'dev', 'none']).optional(),
  TUTOR_MODEL: z.string().default('claude-opus-5-5'),
  TUTOR_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(2_000_000),
  MAIL_TRANSPORT: z.enum(['console', 'memory']).default('console'),
  TRUST_PROXY: bool,
  GIT_COMMIT: z.string().optional(),
  /** DEV ONLY: `1` loads the demo school/accounts at startup (src/services/demo-seed.ts); refused in production. */
  DEMO_SEED: bool,
  /** DEV ONLY: `1` skips the admin-audience TOTP check (TZ §6 requires it); refused in production. */
  ADMIN_TOTP_DISABLED: bool,
  /**
   * v0.6.0 TEMPORARY (no mail server yet): every registration code is this fixed
   * 6-digit value instead of a random one. Insecure — logged as a warning at start.
   */
  AUTH_FIXED_OTP: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .pipe(z.string().regex(/^\d{6}$/, 'AUTH_FIXED_OTP must be exactly 6 digits').optional()),
  /** v0.6.0: length of a self-registered teacher's trial licence, in days. */
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  port: number;
  host: string;
  logLevel: Env['LOG_LEVEL'];
  storage: Env['STORAGE'];
  databaseUrl?: string;
  redisUrl?: string;
  corsOrigins: string[];
  publicUrl: string;
  appUrl: string;
  adminUrl: string;
  cdnBaseUrl?: string;
  jwtSecret: string;
  pseudonymSecret: string;
  cookieSecure: boolean;
  storageDir: string;
  contentDir?: string;
  anthropicApiKey?: string;
  tutorProvider: 'anthropic' | 'dev' | 'none';
  tutorModel: string;
  tutorDailyTokenBudget: number;
  mailTransport: Env['MAIL_TRANSPORT'];
  trustProxy: boolean;
  commit?: string;
  demoSeed: boolean;
  adminTotpDisabled: boolean;
  /** v0.6.0: fixed registration code (temporary insecure mode), or undefined for random codes. */
  authFixedOtp?: string;
  trialDays: number;
}

/** Fill unset variables from `./.env` (the same file the Prisma CLI reads); the real environment wins. */
export function loadDotEnv(file = '.env', env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) if (env[k] === undefined) env[k] = v;
}

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  if (!env) {
    loadDotEnv();
    env = process.env;
  }
  const e = EnvSchema.parse(env);
  if (e.NODE_ENV === 'production' && (!e.JWT_SECRET || !e.PSEUDONYM_SECRET)) {
    throw new Error('JWT_SECRET and PSEUDONYM_SECRET are required in production');
  }
  if (e.NODE_ENV === 'production' && e.TUTOR_PROVIDER === 'dev') {
    throw new Error('TUTOR_PROVIDER=dev is a dev-only switch and is refused in production');
  }
  if (e.TUTOR_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) {
    throw new Error('TUTOR_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  if (e.NODE_ENV === 'production' && e.ADMIN_TOTP_DISABLED) {
    throw new Error('ADMIN_TOTP_DISABLED is a dev-only switch and is refused in production');
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    storage: e.STORAGE,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL || undefined,
    corsOrigins: e.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: e.PUBLIC_URL.replace(/\/$/, ''),
    appUrl: e.APP_URL.replace(/\/$/, ''),
    adminUrl: e.ADMIN_URL.replace(/\/$/, ''),
    cdnBaseUrl: e.CDN_BASE_URL?.replace(/\/$/, ''),
    // Dev fallback: a random secret per process (tokens die on restart — intentional).
    jwtSecret: e.JWT_SECRET ?? randomBytes(32).toString('hex'),
    pseudonymSecret: e.PSEUDONYM_SECRET ?? randomBytes(16).toString('hex'),
    cookieSecure: e.COOKIE_SECURE,
    storageDir: e.STORAGE_DIR,
    contentDir: e.CONTENT_DIR,
    anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
    tutorProvider: e.TUTOR_PROVIDER ?? (e.ANTHROPIC_API_KEY ? 'anthropic' : e.NODE_ENV === 'development' ? 'dev' : 'none'),
    tutorModel: e.TUTOR_MODEL,
    tutorDailyTokenBudget: e.TUTOR_DAILY_TOKEN_BUDGET,
    mailTransport: e.MAIL_TRANSPORT,
    trustProxy: e.TRUST_PROXY,
    commit: e.GIT_COMMIT,
    demoSeed: e.DEMO_SEED,
    adminTotpDisabled: e.ADMIN_TOTP_DISABLED,
    authFixedOtp: e.AUTH_FIXED_OTP,
    trialDays: e.TRIAL_DAYS,
  };
}

/** Config for tests: deterministic secrets, memory transports. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: 'test', STORAGE: 'memory', MAIL_TRANSPORT: 'memory', LOG_LEVEL: 'silent' }),
    jwtSecret: 'test-secret-test-secret-test-secret-0000',
    pseudonymSecret: 'pseudonym-test-secret',
    anthropicApiKey: undefined,
    ...overrides,
  };
}
