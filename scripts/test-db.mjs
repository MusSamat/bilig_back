#!/usr/bin/env node
/**
 * `npm run test:db`: apply migrations to TEST_DATABASE_URL (default: the
 * docker-compose `bilig_test` database) and run the Prisma repository contract and
 * the journal / 0.8.0 migration tests (files in sequence: they share the database).
 */
import { spawnSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://bilig:bilig@localhost:55433/bilig_test';
const env = { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: url };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('npx', ['prisma', 'migrate', 'deploy']);
run('npx', ['vitest', 'run', '--no-file-parallelism', 'src/repo/prisma.test.ts', 'src/repo/prisma-journal.test.ts', ...process.argv.slice(2)]);
