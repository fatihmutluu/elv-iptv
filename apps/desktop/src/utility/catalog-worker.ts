import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import * as nodeModule from 'node:module';
import * as nodeNet from 'node:net';
import { dirname } from 'node:path';
import type { FetchLike } from '@elv/domain';
import Database from 'better-sqlite3';
import { createCatalogWorkerRuntime, type WorkerParentPortLike } from './catalog-worker-runtime.ts';
import { createNodeGzipDecompressor } from './node-gzip-decompressor.ts';

/** Raised Happy Eyeballs timeout (ms) so VPN / blackholed IPv6 links fall back cleanly to IPv4. */
export const CATALOG_WORKER_AUTO_SELECT_FAMILY_TIMEOUT_MS = 2_500;

/** Best-effort SQLite memory-mapped I/O window on 64-bit desktop builds (256 MiB). */
export const CATALOG_DB_MMAP_SIZE_BYTES = 268_435_456;

/** Injectable Node runtime hooks used by {@link configureCatalogWorkerRuntime}. */
export interface CatalogWorkerRuntimeHooks {
  readonly enableCompileCache?: () => unknown;
  readonly setDefaultAutoSelectFamilyAttemptTimeout?: (value: number) => void;
  readonly execArgv?: readonly string[];
  readonly nodeOptions?: string;
}

const AUTO_SELECT_TIMEOUT_FLAG = '--network-family-autoselection-attempt-timeout';
const AUTO_SELECT_TIMEOUT_NODE_OPTS_RE =
  /(?:^|\s)--network-family-autoselection-attempt-timeout(?:=|\s|$)/;

function hasExplicitAutoSelectFamilyTimeout(
  execArgv: readonly string[],
  nodeOptions: string,
): boolean {
  if (
    execArgv.some(
      (arg) => arg === AUTO_SELECT_TIMEOUT_FLAG || arg.startsWith(`${AUTO_SELECT_TIMEOUT_FLAG}=`),
    )
  ) {
    return true;
  }
  return AUTO_SELECT_TIMEOUT_NODE_OPTS_RE.test(nodeOptions);
}

/**
 * Enables Node's V8 bytecode compile cache and raises `net.setDefaultAutoSelectFamilyAttemptTimeout`
 * to 2,500 ms inside the catalog utility worker isolate unless an explicit CLI or `NODE_OPTIONS`
 * timeout override is already configured.
 */
export function configureCatalogWorkerRuntime(
  hooks: CatalogWorkerRuntimeHooks = {
    enableCompileCache: nodeModule.enableCompileCache,
    setDefaultAutoSelectFamilyAttemptTimeout: nodeNet.setDefaultAutoSelectFamilyAttemptTimeout,
  },
): void {
  try {
    hooks.enableCompileCache?.();
  } catch {
    // Compile cache is optional on runtimes without support.
  }
  const execArgv = hooks.execArgv ?? process.execArgv;
  const nodeOptions = hooks.nodeOptions ?? process.env.NODE_OPTIONS ?? '';
  if (hasExplicitAutoSelectFamilyTimeout(execArgv, nodeOptions)) return;
  try {
    hooks.setDefaultAutoSelectFamilyAttemptTimeout?.(CATALOG_WORKER_AUTO_SELECT_FAMILY_TIMEOUT_MS);
  } catch {
    // Best-effort Happy Eyeballs timeout boost for VPN/dual-stack links.
  }
}

configureCatalogWorkerRuntime();

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
  try {
    db.pragma?.(`mmap_size = ${CATALOG_DB_MMAP_SIZE_BYTES}`);
  } catch {
    // Best-effort 256 MiB memory-mapped I/O on desktop SQLite connections.
  }
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
