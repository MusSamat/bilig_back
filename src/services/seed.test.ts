import { describe, expect, it } from 'vitest';
import { demoPackage, fixtureContent, makeTestApp } from '../test/helpers.js';
import { CONTENT_IMPORT_SETTING, importContent, importContentIfChanged } from './seed.js';

describe('importContent', () => {
  it('re-imports a changed package without a version bump as a new build, and leaves unchanged ones alone', async () => {
    const t = await makeTestApp({ seed: false });
    try {
      const base = fixtureContent().base;
      const pkg = demoPackage();
      pkg.manifest.hash = 'aa'.repeat(32);
      const first = await importContent(t.repo, t.clock, { base, packages: [pkg] }, t.deps.config);
      expect(first).toMatchObject({ versionsCreated: 1, versionsRefreshed: 0 });

      const again = await importContent(t.repo, t.clock, { base, packages: [pkg] }, t.deps.config);
      expect(again).toMatchObject({ versionsCreated: 0, versionsRefreshed: 0 });

      const changed = demoPackage();
      changed.manifest.hash = 'bb'.repeat(32);
      changed.manifest.files = [{ path: 'models/x.glb', hash: 'cc'.repeat(32), size: 10 }];
      const refreshed = await importContent(t.repo, t.clock, { base, packages: [changed] }, t.deps.config);
      expect(refreshed).toMatchObject({ versionsCreated: 0, versionsRefreshed: 1 });

      const topic = await t.repo.getTopicByKey(changed.topic.key);
      const build = await t.repo.readyBuildForVersion(topic!.publishedVersionId!);
      expect(build?.hash).toBe('bb'.repeat(32));
      expect(build?.manifest?.files).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});

describe('importContentIfChanged (container start-up)', () => {
  it('imports once, skips while the content is unchanged, imports again on a change or with force', async () => {
    const t = await makeTestApp({ seed: false });
    try {
      const base = fixtureContent().base;
      const pkg = demoPackage();
      pkg.manifest.hash = 'aa'.repeat(32);
      const content = { base, packages: [pkg] };

      const first = await importContentIfChanged(t.repo, t.clock, content, t.deps.config);
      expect(first.skipped).toBe(false);
      expect((await t.repo.getSetting(CONTENT_IMPORT_SETTING))?.value).toMatchObject({ fingerprint: first.fingerprint });

      const again = await importContentIfChanged(t.repo, t.clock, content, t.deps.config);
      expect(again).toEqual({ skipped: true, fingerprint: first.fingerprint });

      const forced = await importContentIfChanged(t.repo, t.clock, content, { ...t.deps.config, force: true });
      expect(forced.skipped).toBe(false);

      const changed = demoPackage();
      changed.manifest.hash = 'bb'.repeat(32);
      const next = await importContentIfChanged(t.repo, t.clock, { base, packages: [changed] }, t.deps.config);
      expect(next.skipped).toBe(false);
      expect(next.fingerprint).not.toBe(first.fingerprint);

      // Same content behind another public URL bakes other package URLs into builds: import again.
      const moved = await importContentIfChanged(t.repo, t.clock, { base, packages: [changed] }, { ...t.deps.config, publicUrl: 'https://other.example' });
      expect(moved.skipped).toBe(false);
    } finally {
      await t.close();
    }
  });
});
