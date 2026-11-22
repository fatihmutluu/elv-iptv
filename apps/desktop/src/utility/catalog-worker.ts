import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FetchLike } from '@elv/domain';
import Database from 'better-sqlite3';
import { createCatalogWorkerRuntime, type WorkerParentPortLike } from './catalog-worker-runtime.ts';
import { createNodeGzipDecompressor } from './node-gzip-decompressor.ts';

/** Collaborators for {@link openHardenedCatalogDatabase}, injectable for unit tests. */
export interface HardenedCatalogDbDeps {
  platform?: NodeJS.Platform;
  mkdir?: typeof mkdirSync;
  chmod?: typeof chmodSync;
  exists?: typeof existsSync;
  openDb?: (path: string) => Database.Database;
}

/**
 * Ensures the parent directory exists with `0o700` permissions, opens `filePath` via
 * `better-sqlite3`, and applies best-effort `0o600` permissions on POSIX platforms to the database
 * file and any existing `-wal`/`-shm` sidecars.
 */
export function openHardenedCatalogDatabase(
  filePath: string,
  deps?: HardenedCatalogDbDeps,
): Database.Database {
  const platform = deps?.platform ?? process.platform;
  const mkdir = deps?.mkdir ?? mkdirSync;
  const chmod = deps?.chmod ?? chmodSync;
  const exists = deps?.exists ?? existsSync;
  const openDb = deps?.openDb ?? ((p: string) => new Database(p));

  mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = openDb(filePath);
  if (platform !== 'win32') {
    for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
      try {
        if (candidate === filePath || exists(candidate)) {
          chmod(candidate, 0o600);
        }
      } catch {
        // Best-effort POSIX permission hardening.
      }
    }
  }
  return db;
}

const parentPort = (process as NodeJS.Process & { parentPort?: WorkerParentPortLike }).parentPort;
if (parentPort) {
  createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (filePath) => openHardenedCatalogDatabase(filePath),
    fetchImpl: fetch as unknown as FetchLike,
    decompressor: createNodeGzipDecompressor(),
    onExit: (code) => process.exit(code),
  });
} else if (!process.env.VITEST) {
  throw new Error('catalog-worker must run inside an Electron utilityProcess');
}
