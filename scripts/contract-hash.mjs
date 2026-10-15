#!/usr/bin/env node
/**
 * Prints a sha256 over the shared contract packages (packages/permissions and
 * packages/content-model, excluding node_modules). bilig_ft holds the canonical
 * copy; bilig_back vendors it byte-for-byte, so both repos must print the same hash.
 *
 * Hash input, for every file in sorted posix-path order:
 *   "<relative path>\0<file bytes>\0"
 * Usage: node scripts/contract-hash.mjs [--list]
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = ['packages/permissions', 'packages/content-model'];
const EXCLUDE = new Set(['node_modules']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (EXCLUDE.has(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = PACKAGES.flatMap((p) => walk(join(root, p)))
  .map((abs) => ({ abs, rel: relative(root, abs).split(sep).join('/') }))
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

const hash = createHash('sha256');
for (const f of files) {
  hash.update(f.rel + '\0');
  hash.update(readFileSync(f.abs));
  hash.update('\0');
}
if (process.argv.includes('--list')) for (const f of files) console.log(f.rel);
console.log(hash.digest('hex'));
