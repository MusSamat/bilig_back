/** Repository contract on the in-memory implementation (always part of `npm test`). */
import { MemoryRepository } from './memory.js';
import { runRepositoryContract } from './repo.contract.js';

runRepositoryContract('memory', async () => new MemoryRepository());
