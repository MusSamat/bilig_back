/** Environment configuration (parsed once with Zod; see .env.example). */
import { randomBytes } from 'node:crypto';
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
  TUTOR_MODEL: z.string().default('claude-opus-5-5'),
  TUTOR_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(2_000_000),
  MAIL_TRANSPORT: z.enum(['console', 'memory']).default('console'),
  TRUST_PROXY: bool,
  GIT_COMMIT: z.string().optional(),
  /** DEV ONLY: `1` loads the demo school/accounts at startup (src/services/demo-seed.ts); refused in production. */
  DEMO_SEED: bool,
  /** DEV ONLY: `1` skips the admin-audience TOTP check (TZ §6 requires it); refused in production. */
  ADMIN_TOTP_DISABLED: bool,
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
  tutorModel: string;
  tutorDailyTokenBudget: number;
  mailTransport: Env['MAIL_TRANSPORT'];
  trustProxy: boolean;
  commit?: string;
  demoSeed: boolean;
  adminTotpDisabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  if (e.NODE_ENV === 'production' && (!e.JWT_SECRET || !e.PSEUDONYM_SECRET)) {
    throw new Error('JWT_SECRET and PSEUDONYM_SECRET are required in production');
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
    tutorModel: e.TUTOR_MODEL,
    tutorDailyTokenBudget: e.TUTOR_DAILY_TOKEN_BUDGET,
    mailTransport: e.MAIL_TRANSPORT,
    trustProxy: e.TRUST_PROXY,
    commit: e.GIT_COMMIT,
    demoSeed: e.DEMO_SEED,
    adminTotpDisabled: e.ADMIN_TOTP_DISABLED,
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
