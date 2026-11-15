import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FetchLike } from '@elv/domain';
import Database from 'better-sqlite3';
import { createCatalogWorkerRuntime, type WorkerParentPortLike } from './catalog-worker-runtime.ts';

const parentPort = (process as NodeJS.Process & { parentPort?: WorkerParentPortLike }).parentPort;
if (!parentPort) {
  throw new Error('catalog-worker must run inside an Electron utilityProcess');
}

createCatalogWorkerRuntime({
  parentPort,
  openDatabase: (filePath) => {
    mkdirSync(dirname(filePath), { recursive: true });
    return new Database(filePath);
  },
  fetchImpl: fetch as unknown as FetchLike,
  onExit: (code) => process.exit(code),
});
