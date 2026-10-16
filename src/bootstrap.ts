/** Wire the dependency container from config (main.ts, scripts) or with test overrides. */
import type { Config } from './config.js';
import type { Deps } from './deps.js';
import { JwtService } from './domain/jwt.js';
import { MemoryRepository } from './repo/memory.js';
import type { Repository } from './repo/types.js';
import { AuditService } from './services/audit.js';
import { systemClock, type Clock } from './services/clock.js';
import { ContentService } from './services/content.js';
import { ConsoleMailer, MemoryMailer, type Mailer } from './services/mailer.js';
import { createLimiter, MemoryLimiter, type Limiter } from './services/rate-limit.js';
import { LocalDiskStorage, MemoryStorage, type ObjectStorage } from './services/storage.js';
import { DevProvider } from './services/tutor-dev-provider.js';
import { AnthropicProvider, type TutorProvider } from './services/tutor-provider.js';

export interface DepsOverrides {
  repo?: Repository;
  limiter?: Limiter;
  mailer?: Mailer;
  storage?: ObjectStorage;
  clock?: Clock;
  /** `null` forces "no provider" (offline 503). */
  tutor?: TutorProvider | null;
}

export async function createRepository(config: Config): Promise<Repository> {
  if (config.storage === 'memory') return new MemoryRepository();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for STORAGE=prisma');
  const { createPrismaRepository } = await import('./repo/prisma.js');
  return createPrismaRepository(config.databaseUrl);
}

export async function createDeps(config: Config, o: DepsOverrides = {}): Promise<Deps> {
  const clock = o.clock ?? systemClock;
  const repo = o.repo ?? (await createRepository(config));
  const limiter = o.limiter ?? (config.env === 'test' ? new MemoryLimiter(clock) : await createLimiter(config.redisUrl, clock));
  const mailer = o.mailer ?? (config.mailTransport === 'memory' ? new MemoryMailer() : new ConsoleMailer());
  const storage =
    o.storage ?? (config.env === 'test' ? new MemoryStorage(config.publicUrl) : new LocalDiskStorage(config.storageDir, config.publicUrl));
  const tutor = o.tutor !== undefined ? o.tutor : createTutorProvider(config);
  return {
    config,
    repo,
    limiter,
    mailer,
    storage,
    clock,
    jwt: new JwtService(config.jwtSecret),
    audit: new AuditService(repo, clock),
    content: new ContentService(repo, clock, { publicUrl: config.publicUrl, cdnBaseUrl: config.cdnBaseUrl }),
    tutor,
  };
}

export function createTutorProvider(config: Pick<Config, 'tutorProvider' | 'anthropicApiKey'>): TutorProvider | null {
  if (config.tutorProvider === 'anthropic' && config.anthropicApiKey) return new AnthropicProvider(config.anthropicApiKey);
  if (config.tutorProvider === 'dev') return new DevProvider();
  return null;
}
