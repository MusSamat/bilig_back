/** The dependency container handed to every module (built in main.ts or by tests). */
import type { Config } from './config.js';
import type { JwtService } from './domain/jwt.js';
import type { Repository } from './repo/types.js';
import type { AuditService } from './services/audit.js';
import type { Clock } from './services/clock.js';
import type { Mailer } from './services/mailer.js';
import type { OtpSender } from './services/otp-sender.js';
import type { Limiter } from './services/rate-limit.js';
import type { ObjectStorage } from './services/storage.js';
import type { TutorProvider } from './services/tutor-provider.js';
import type { ContentService } from './services/content.js';

export interface Deps {
  config: Config;
  repo: Repository;
  limiter: Limiter;
  mailer: Mailer;
  /** v0.7.0: phone one-time codes (WhatsApp). */
  otp: OtpSender;
  storage: ObjectStorage;
  clock: Clock;
  jwt: JwtService;
  audit: AuditService;
  content: ContentService;
  /** null = no provider configured → tutor answers 503 and the client goes offline. */
  tutor: TutorProvider | null;
}
