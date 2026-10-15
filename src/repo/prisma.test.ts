/**
 * Repository contract on PostgreSQL. Runs only when TEST_DATABASE_URL is set
 * (`npm run test:db` applies migrations to it first; CI uses a postgres service).
 * Every test starts from empty tables (TRUNCATE … CASCADE).
 */
import { describe, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaRepository } from './prisma.js';
import { runRepositoryContract } from './repo.contract.js';

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  describe.skip('Repository contract: prisma (set TEST_DATABASE_URL, see `npm run test:db`)', () => {
    it('skipped', () => {});
  });
} else {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const repo = new PrismaRepository(db);
  let tables: string[] | null = null;
  runRepositoryContract(
    'prisma',
    async () => {
      tables ??= (
        await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
      ).map((r) => `"public"."${r.tablename}"`);
      await db.$executeRawUnsafe(`TRUNCATE ${tables.join(', ')} CASCADE`);
      return repo;
    },
    () => db.$disconnect(),
  );
}
