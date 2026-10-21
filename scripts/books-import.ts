/**
 * `npm run books:import`: write the books shipped in content/books/<key>/ (book.json + cover.jpg) into the
 * database of DATABASE_URL — the same import the API runs on start, without a restart. A book already in the
 * database is skipped (staff edits are never overwritten).
 */
import { loadConfig } from '../src/config.js';
import { createDeps } from '../src/bootstrap.js';
import { importBooks, loadBookSeeds } from '../src/services/book-seed.js';
import { DEFAULT_CONTENT_DIR } from '../src/services/seed.js';

const config = loadConfig();
const deps = await createDeps(config);
const seeds = loadBookSeeds(config.contentDir ?? DEFAULT_CONTENT_DIR);
const { created } = await importBooks(deps, seeds);
for (const s of seeds) process.stdout.write(`${created.includes(s.id) ? 'imported' : 'exists  '}  ${s.title} (${s.lang}, grade ${s.grade}, ${s.sections.length} sections)\n`);
process.exit(0);
