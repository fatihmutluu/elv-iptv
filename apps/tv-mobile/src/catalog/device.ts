import { openCatalog } from '@elv/data';
import type { ElvError } from '@elv/domain';
import {
  createDeviceHttpClient,
  createMacrotaskScheduler,
  createOpSqliteDriver,
  createSecureSecretStore,
} from '../storage';
import { type CatalogService, createCatalogService } from './catalog';

/** File name of the catalog database; op-sqlite places it in the app's persistent database directory, not the cache. */
const DATABASE_NAME = 'catalog.db';

/** The database could not be opened or migrated; `error` carries the typed cause (no secrets). */
export class CatalogOpenError extends Error {
  constructor(readonly error: ElvError) {
    super(`catalog open failed: ${error.category}/${error.code}`);
  }
}

let instance: Promise<CatalogService> | undefined;

/**
 * The one catalog of this app process, created on first use. A failed open is not remembered, so the next call retries.
 */
export function createDeviceCatalog(): Promise<CatalogService> {
  instance ??= open().catch((e: unknown) => {
    instance = undefined;
    throw e;
  });
  return instance;
}

async function open(): Promise<CatalogService> {
  const db = await createOpSqliteDriver(DATABASE_NAME);
  const opened = await openCatalog(db);
  if (!opened.ok) throw new CatalogOpenError(opened.error);
  return createCatalogService({
    db,
    secrets: createSecureSecretStore(),
    scheduler: createMacrotaskScheduler(),
    http: createDeviceHttpClient(),
    clock: Date.now,
  });
}
