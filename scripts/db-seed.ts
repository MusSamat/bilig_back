/**
 * `npm run db:seed`: import content/** into the database as published
 * TopicVersions + Builds (validated with validatePackage at load).
 * Optional dev superadmin: DEV_ADMIN_EMAIL + DEV_ADMIN_PASSWORD.
 */
import { loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import { createRepository } from '../src/bootstrap.js';
import { hashSecret } from '../src/domain/passwords.js';
import { systemClock } from '../src/services/clock.js';
import { importContent, loadContentDir } from '../src/services/seed.js';

const config = loadConfig();
const repo = await createRepository(config);
try {
  const report = await importContent(repo, systemClock, loadContentDir(config.contentDir), config);
  console.log(`seeded (${repo.kind}):`, JSON.stringify(report));

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
