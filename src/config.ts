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
   * `deepseek` (needs DEEPSEEK_API_KEY; the provider in use), `anthropic`
   * (needs ANTHROPIC_API_KEY; kept, not used for now), `dev` (answers and
   * generates from the package itself, no LLM; refused in production) or
   * `none` (offline 503). Unset: `deepseek` with its key, else `dev` in
   * development, else `none` — Anthropic only when chosen explicitly.
   */
  TUTOR_PROVIDER: z.enum(['anthropic', 'deepseek', 'dev', 'none']).optional(),
  /** Model of the primary provider; unset: deepseek-flash (deepseek) / claude-opus-5-5 (anthropic). */
  TUTOR_MODEL: z.string().optional(),
  /** Failover provider when the primary is unavailable (outage, rate limit, balance); needs its key. */
  TUTOR_FALLBACK: z.enum(['anthropic', 'deepseek']).optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  /** Model when DeepSeek is the fallback (as primary, TUTOR_MODEL wins). */
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
  /** Thinking mode for chat answers (off by default: fast first token in class). */
  DEEPSEEK_CHAT_THINKING: bool,
  /**
   * Reasoning effort for «more examples / questions» generation; `none` turns thinking off.
   * Default `none`: reasoning tokens are billed as output and were half of the whole bill (measured:
   * 567 output tokens per request against ~150 for an answer); one short school item needs no
   * reasoning, and every item is validated server-side anyway (language, length, options, duplicates).
   */
  DEEPSEEK_GENERATE_EFFORT: z.enum(['none', 'low', 'high', 'max']).default('none'),
  TUTOR_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(2_000_000),
  /** USD per 1M tokens, for the cost in logs and the eval (check the provider's price page; defaults: deepseek-flash). */
  /** v0.9.3 book library: the model reading books, reasoning for page transcription and for the § analysis, a daily token cap. */
  BOOK_MODEL: z.string().default('deepseek-flash'),
  BOOK_OCR_EFFORT: z.enum(['none', 'low', 'high', 'max']).default('none'),
  BOOK_ANALYSIS_EFFORT: z.enum(['none', 'low', 'high', 'max']).default('high'),
  BOOK_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(30_000_000),
  /** Shared answers to self-contained questions (starters, first questions): a repeat costs no tokens. `0` turns it off. */
  TUTOR_ANSWER_CACHE: z.enum(['0', '1']).default('1').transform((v) => v === '1'),
  TUTOR_PRICE_INPUT: z.coerce.number().min(0).default(0.15),
  TUTOR_PRICE_INPUT_CACHED: z.coerce.number().min(0).default(0.003),
  TUTOR_PRICE_OUTPUT: z.coerce.number().min(0).default(0.6),
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
  /**
   * TEMPORARY, for the test period (until admins set up an authenticator
   * app): the admin audience accepts this fixed 6-digit value as the 2FA
   * code, also for admins without an enrolled authenticator (they are asked
   * for the code instead of being sent to enrolment). Real authenticator
   * codes keep working. Insecure — a warning at every start and `totp:
   * 'fixed'` in the audit entry of every sign-in that used it. Remove the
   * variable to restore normal 2FA.
   */
  AUTH_FIXED_TOTP: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .pipe(z.string().regex(/^\d{6}$/, 'AUTH_FIXED_TOTP must be exactly 6 digits').optional()),
  /**
   * v0.7.0: how phone one-time codes reach the teacher's WhatsApp
   * (src/services/otp-sender.ts): `fixed` (needs AUTH_FIXED_OTP; nothing is
   * sent), `console` (prints the message; refused in production) or `whatsapp`
   * (WhatsApp Business provider — not implemented yet, refused at start).
   * Unset: `fixed` with AUTH_FIXED_OTP, else `console` outside production, else
   * `whatsapp` (so production without a working sender does not start).
   */
  OTP_SENDER: z.enum(['fixed', 'console', 'whatsapp']).optional(),
  /** v0.6.0: length of a self-registered teacher's trial licence, in days. */
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

export type Env = z.infer<typeof EnvSchema>;

export interface TokenPrices {
  input: number;
  inputCached: number;
  output: number;
}
/** USD of one call: cached input at the cache price, the rest of the input at the full price. */
export const usageCostUsd = (u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }, p: TokenPrices): number => {
  const cached = Math.min(u.cachedInputTokens ?? 0, u.inputTokens);
  return ((u.inputTokens - cached) * p.input + cached * p.inputCached + u.outputTokens * p.output) / 1e6;
};

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
  tutorProvider: 'anthropic' | 'deepseek' | 'dev' | 'none';
  tutorModel: string;
  tutorFallback?: 'anthropic' | 'deepseek';
  /** Configuration problems that do not stop the server (logged at start). */
  warnings: string[];
  deepseek: {
    apiKey?: string;
    baseURL: string;
    model: string;
    chatThinking: boolean;
    generateEffort: 'none' | 'low' | 'high' | 'max';
  };
  tutorDailyTokenBudget: number;
  /** USD per 1M tokens: input (cache miss), input served from the prompt cache, output. */
  tutorPrices: TokenPrices;
  /** Shared answers to self-contained questions (TUTOR_ANSWER_CACHE). */
  tutorAnswerCache: boolean;
  bookModel: string;
  bookOcrEffort: 'none' | 'low' | 'high' | 'max';
  bookAnalysisEffort: 'none' | 'low' | 'high' | 'max';
  bookDailyTokenBudget: number;
  mailTransport: Env['MAIL_TRANSPORT'];
  trustProxy: boolean;
  commit?: string;
  demoSeed: boolean;
  adminTotpDisabled: boolean;
  /** v0.6.0: fixed registration code (temporary insecure mode), or undefined for random codes. */
  authFixedOtp?: string;
  /** TEMPORARY fixed admin 2FA code (AUTH_FIXED_TOTP), test period only. */
  authFixedTotp?: string;
  /** v0.7.0: phone one-time code delivery (see OTP_SENDER). */
  otpSender: OtpSenderKind;
  trialDays: number;
}

export type OtpSenderKind = 'fixed' | 'console' | 'whatsapp';

/** v0.7.0: the effective phone-code sender, or a start-up error explaining what to set. */
export function resolveOtpSender(e: Pick<Env, 'NODE_ENV' | 'OTP_SENDER' | 'AUTH_FIXED_OTP'>): OtpSenderKind {
  const prod = e.NODE_ENV === 'production';
  const kind: OtpSenderKind = e.OTP_SENDER ?? (e.AUTH_FIXED_OTP ? 'fixed' : prod ? 'whatsapp' : 'console');
  if (kind === 'fixed' && !e.AUTH_FIXED_OTP) throw new Error('OTP_SENDER=fixed requires AUTH_FIXED_OTP (6 digits)');
  if (kind === 'console' && prod) throw new Error('OTP_SENDER=console prints one-time codes to the log and is refused in production');
  if (kind === 'whatsapp') {
    throw new Error(
      'No working sender for phone one-time codes: the WhatsApp provider (OTP_SENDER=whatsapp) is not configured yet. ' +
        'Set AUTH_FIXED_OTP=<6 digits> (TEMPORARY, insecure: every code is that value and nothing is sent)' +
        (prod ? '.' : ', or OTP_SENDER=console in development.'),
    );
  }
  return kind;
}

/** Fill unset variables from `./.env` (the same file the Prisma CLI reads); the real environment wins. */
export function loadDotEnv(file = '.env', env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) if (env[k] === undefined) env[k] = v;
}

/**
 * Env files are edited by hand on servers: `KEY=` (empty) means «not set», and
 * values wrapped in matching quotes (`KEY="012345"`, which docker's env_file
 * keeps literally) are unwrapped. Without this, an empty or quoted line made
 * the API exit at start.
 */
export function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(env)) {
    if (raw === undefined) continue;
    let v = raw.trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1).trim();
    if (v !== '') out[k] = v;
  }
  return out;
}

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  if (!env) {
    loadDotEnv();
    env = process.env;
  }
  const parsed = EnvSchema.safeParse(normalizeEnv(env));
  if (!parsed.success) {
    // One readable line per bad setting instead of a Zod dump: «Invalid setting DEEPSEEK_BASE_URL: Invalid url».
    const lines = parsed.error.issues.map((i) => `Invalid setting ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(lines.join('\n'));
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && (!e.JWT_SECRET || !e.PSEUDONYM_SECRET)) {
    throw new Error('JWT_SECRET and PSEUDONYM_SECRET are required in production');
  }
  if (e.NODE_ENV === 'production' && e.TUTOR_PROVIDER === 'dev') {
    throw new Error('TUTOR_PROVIDER=dev is a dev-only switch and is refused in production');
  }
  // The assistant is optional: a provider without its key turns the assistant off (with a warning at start)
  // instead of taking the whole platform down.
  const warnings: string[] = [];
  const keyOf = { anthropic: e.ANTHROPIC_API_KEY, deepseek: e.DEEPSEEK_API_KEY } as const;
  let chosen = e.TUTOR_PROVIDER;
  if ((chosen === 'anthropic' || chosen === 'deepseek') && !keyOf[chosen]) {
    warnings.push(`TUTOR_PROVIDER=${chosen} but ${chosen === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY'} is empty — the assistant is off (answers 503) until the key is set`);
    chosen = 'none';
  }
  let fallback = e.TUTOR_FALLBACK;
  if (fallback && !keyOf[fallback]) {
    warnings.push(`TUTOR_FALLBACK=${fallback} but ${fallback === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY'} is empty — no failover`);
    fallback = undefined;
  }
  if (e.NODE_ENV === 'production' && e.ADMIN_TOTP_DISABLED) {
    throw new Error('ADMIN_TOTP_DISABLED is a dev-only switch and is refused in production');
  }
  const tutorProvider: Config['tutorProvider'] =
    chosen ?? (e.DEEPSEEK_API_KEY ? 'deepseek' : e.NODE_ENV === 'development' ? 'dev' : 'none');
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
    tutorProvider,
    tutorModel: e.TUTOR_MODEL ?? (tutorProvider === 'anthropic' ? 'claude-opus-5-5' : e.DEEPSEEK_MODEL),
    ...(fallback && fallback !== tutorProvider ? { tutorFallback: fallback } : {}),
    warnings,
    deepseek: {
      apiKey: e.DEEPSEEK_API_KEY || undefined,
      baseURL: e.DEEPSEEK_BASE_URL,
      model: e.DEEPSEEK_MODEL,
      chatThinking: e.DEEPSEEK_CHAT_THINKING,
      generateEffort: e.DEEPSEEK_GENERATE_EFFORT,
    },
    tutorDailyTokenBudget: e.TUTOR_DAILY_TOKEN_BUDGET,
    tutorPrices: { input: e.TUTOR_PRICE_INPUT, inputCached: e.TUTOR_PRICE_INPUT_CACHED, output: e.TUTOR_PRICE_OUTPUT },
    tutorAnswerCache: e.TUTOR_ANSWER_CACHE,
    bookModel: e.BOOK_MODEL,
    bookOcrEffort: e.BOOK_OCR_EFFORT,
    bookAnalysisEffort: e.BOOK_ANALYSIS_EFFORT,
    bookDailyTokenBudget: e.BOOK_DAILY_TOKEN_BUDGET,
    mailTransport: e.MAIL_TRANSPORT,
    trustProxy: e.TRUST_PROXY,
    commit: e.GIT_COMMIT,
    demoSeed: e.DEMO_SEED,
    adminTotpDisabled: e.ADMIN_TOTP_DISABLED,
    authFixedOtp: e.AUTH_FIXED_OTP,
    authFixedTotp: e.AUTH_FIXED_TOTP,
    otpSender: resolveOtpSender(e),
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
