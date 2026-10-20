/** bilig_back entrypoint: config → deps → app → listen; scheduled publishes + data purge timers. */
import { buildApp } from './app.js';
import { createDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import { seedDemo } from './services/demo-seed.js';
import { importContent, loadContentDir } from './services/seed.js';
import { runScheduledPublishes } from './services/workflow.js';
import { expireSupportSessions } from './services/support.js';

/** v0.8.0 journal: monthly partitions this many months ahead; partitions older than the retention are dropped. */
const JOURNAL_AHEAD_MONTHS = 3;
const JOURNAL_RETAIN_MONTHS = 36;
const maintainJournal = () =>
  deps.repo.maintainJournal(deps.clock.now(), JOURNAL_AHEAD_MONTHS, JOURNAL_RETAIN_MONTHS).catch((err) => app.log.error({ err: String(err) }, 'journal maintenance failed'));

const config = loadConfig();
const deps = await createDeps(config);
if (deps.repo.kind === 'memory') {
  // Zero-dependency dev mode: load content/** into memory on boot.
  const report = await importContent(deps.repo, deps.clock, loadContentDir(config.contentDir), config);
  process.stdout.write(`memory repo seeded: ${JSON.stringify(report)}\n`);
}
// DEV ONLY: demo school + accounts (throws when NODE_ENV=production).
if (config.demoSeed) await seedDemo(deps.repo, deps);
const app = await buildApp(deps);
if (deps.limiter.kind === 'memory' && config.redisUrl) app.log.warn('REDIS_URL set but unreachable — using in-memory rate limits');
if (config.authFixedOtp) {
  app.log.warn(
    `AUTH_FIXED_OTP is set: every one-time code (e-mail registration and WhatsApp phone codes) is the same fixed value and phone codes are not sent (OTP_SENDER=${config.otpSender}). TEMPORARY and INSECURE — remove it once a WhatsApp provider and a mail server are configured.`,
  );
} else if (config.otpSender === 'console') {
  app.log.warn('OTP_SENDER=console: phone one-time codes are printed to stdout, not sent (development only)');
}
if (config.authFixedTotp) {
  app.log.warn(
    'AUTH_FIXED_TOTP is set: the admin panel accepts a fixed 2FA code for every admin (each such sign-in is marked totp=fixed in the audit log). TEMPORARY (test period) and INSECURE — remove it once admins have set up an authenticator app.',
  );
}
if (!deps.tutor) app.log.warn('ANTHROPIC_API_KEY not set — tutor answers 503 (clients use the offline index)');

await maintainJournal();
const timers = [
  setInterval(() => void maintainJournal(), 24 * 3600_000),
  setInterval(() => void expireSupportSessions(deps).catch((err) => app.log.error({ err: String(err) }, 'support expiry failed')), 60_000),
  setInterval(() => void runScheduledPublishes(deps).catch((err) => app.log.error({ err: String(err) }, 'scheduled publish failed')), 60_000),
  setInterval(() => void deps.repo.purgeDeleted(new Date(deps.clock.now().getTime() - 30 * 24 * 3600_000)).catch(() => {}), 6 * 3600_000),
];

const shutdown = async () => {
  timers.forEach(clearInterval);
  await app.close();
  await deps.repo.close();
  await deps.limiter.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
