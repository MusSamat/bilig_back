/**
 * `npm run db:seed`: import content/** into the database as published
 * TopicVersions + Builds (validated with validatePackage at load).
 * Skipped when the content is unchanged since the last completed import;
 * `--force` (or CONTENT_IMPORT=force) imports anyway.
 * Optional dev superadmin: DEV_ADMIN_EMAIL + DEV_ADMIN_PASSWORD.
 */
import { loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import { createRepository } from '../src/bootstrap.js';
import { hashSecret } from '../src/domain/passwords.js';
import { systemClock } from '../src/services/clock.js';
import { importContentIfChanged, loadContentDir } from '../src/services/seed.js';

const config = loadConfig();
const repo = await createRepository(config);
try {
  const force = process.argv.includes('--force') || process.env.CONTENT_IMPORT === 'force';
  const started = Date.now();
  const res = await importContentIfChanged(repo, systemClock, loadContentDir(config.contentDir), { ...config, force });
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  if (res.skipped) console.log(`content unchanged (${res.fingerprint.slice(0, 12)}), import skipped in ${took}; --force to import anyway`);
  else console.log(`seeded (${repo.kind}) in ${took}:`, JSON.stringify(res.report));

  const email = process.env.DEV_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.DEV_ADMIN_PASSWORD;
  if (email && password) {
    let user = await repo.getUserByEmail(email);
    if (!user) {
      const created = await repo.createUser({ id: newId(), kind: 'adult', email, emailVerifiedAt: new Date(), displayName: 'Dev Admin', locale: 'ru', status: 'active' });
      if (created === 'conflict') throw new Error('dev admin conflict');
      user = created;
    }
    await repo.setCredential(user.id, 'password', await hashSecret(password));
    await repo.addGrant({ userId: user.id, role: 'superadmin', scope: 'platform', scopeId: null, subrole: null });
    console.log(`dev superadmin ready: ${email} (enrol TOTP via POST /me/2fa before using the admin audience)`);
  }
} finally {
  await repo.close();
}
