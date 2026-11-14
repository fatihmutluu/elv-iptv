import { openCatalog } from '@elv/data';
import type { ElvError, SqlDriver } from '@elv/domain';
import { Platform } from 'react-native';
import {
  createDeviceHttpClient,
  createMacrotaskScheduler,
  createOpSqliteDriver,
  createSecureSecretStore,
  createSettingsStore,
  databaseLocation,
} from '../storage';
import { type CatalogService, createCatalogService } from './catalog';
import { type ManifestStore, reconcileManifest } from './manifest';

/**
 * File name of the catalog database: in `Library/Caches` on Apple platforms (tvOS hardware gives apps only purgeable
 * storage; iOS backs `Library` up to iCloud), in op-sqlite's databases directory on Android. The OS may purge the
 * Apple copy; the source manifest brings the sources back.
 */
const DATABASE_NAME = 'catalog.db';

/** `Settings` key of the source manifest (Apple platforms). */
const MANIFEST_KEY = 'elv.catalog.sources';

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

/**
 * A failed read or restore of the manifest never stops the catalog from opening: the database stays as it is, the
 * warning carries only a category and code, and the service rewrites the manifest on its next successful write.
 */
async function reconcile(db: SqlDriver, manifest: ManifestStore): Promise<void> {
  try {
    await reconcileManifest(db, manifest);
  } catch {
    // biome-ignore lint/suspicious/noConsole: a categorized warning without values; there is no logging port yet
    console.warn('catalog: storage/manifest-failed');
  }
}

async function open(): Promise<CatalogService> {
  const db = await createOpSqliteDriver(DATABASE_NAME, databaseLocation(Platform.OS));
  const opened = await openCatalog(db);
  if (!opened.ok) throw new CatalogOpenError(opened.error);
  const manifest = Platform.OS === 'ios' ? createSettingsStore(MANIFEST_KEY) : undefined;
  if (manifest !== undefined) await reconcile(db, manifest);
  return createCatalogService({
    db,
    secrets: createSecureSecretStore(),
    scheduler: createMacrotaskScheduler(),
    http: createDeviceHttpClient(),
    clock: Date.now,
    ...(manifest === undefined ? {} : { manifest }),
  });
}
