/**
 * `npm run db:seed:demo`: DEV ONLY — add the demo school, accounts, class and
 * assignment (src/services/demo-seed.ts) to the database. Run `npm run db:seed`
 * first so the licence and the animal-cell assignment have content to point at.
 * Idempotent; refused when NODE_ENV=production.
 */
import { loadConfig } from '../src/config.js';
import { createRepository } from '../src/bootstrap.js';
import { systemClock } from '../src/services/clock.js';
import { assertDemoAllowed, seedDemo } from '../src/services/demo-seed.js';

const config = loadConfig();
assertDemoAllowed(config.env);
const repo = await createRepository(config);
try {
  await seedDemo(repo, { config, clock: systemClock });
} finally {
  await repo.close();
}
