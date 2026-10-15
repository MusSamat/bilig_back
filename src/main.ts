/** bilig_back entrypoint: config → deps → app → listen; scheduled publishes + data purge timers. */
import { buildApp } from './app.js';
import { createDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import { importContent, loadContentDir } from './services/seed.js';
import { runScheduledPublishes } from './services/workflow.js';

const config = loadConfig();
const deps = await createDeps(config);
if (deps.repo.kind === 'memory') {
  // Zero-dependency dev mode: load content/** into memory on boot.
  const report = await importContent(deps.repo, deps.clock, loadContentDir(config.contentDir), config);
  process.stdout.write(`memory repo seeded: ${JSON.stringify(report)}\n`);
}
const app = await buildApp(deps);
if (deps.limiter.kind === 'memory' && config.redisUrl) app.log.warn('REDIS_URL set but unreachable — using in-memory rate limits');
if (!deps.tutor) app.log.warn('ANTHROPIC_API_KEY not set — tutor answers 503 (clients use the offline index)');

const timers = [
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
