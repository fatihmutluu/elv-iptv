import {
  type CatalogService,
  createCatalogService,
  type ManifestStore,
  openCatalog,
  reconcileManifest,
  reconcileUserData,
  type UserDataStore,
} from '@elv/data';
import type { ElvError, SqlDriver } from '@elv/domain';
import { Platform } from 'react-native';
import {
  createAppleUserDataStore,
  createDeviceHttpClient,
  createMacrotaskScheduler,
  createOpSqliteDriver,
  createSecureSecretStore,
  createSettingsStore,
  databaseLocation,
} from '../storage';
import { createMobileLocalPlaylistStore } from './local-playlist-store';
import { createDeviceNativeGuideStager } from './native-guide-stager';

/**
 * File name of the catalog database: in `Library/Caches` on Apple platforms (tvOS hardware gives apps only purgeable
 * storage; iOS backs `Library` up to iCloud), in op-sqlite's databases directory on Android. The OS may purge the
 * Apple copy; the source manifest and user-data store bring sources, favorites, and watch progress back (ADR 0014).
 */
const DATABASE_NAME = 'catalog.db';

/** `Settings` key of the source manifest (Apple platforms). */
const MANIFEST_KEY = 'elv.catalog.sources';

/** Persistent KV key of the purge-safe user-data snapshot on Apple platforms (`#79`, ADR 0014). */
const USER_DATA_KEY = 'elv.catalog.userstate.v1';

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

/**
 * Restores favorites and watch progress after an Apple `Library/Caches` purge without blocking catalog open on
 * unexpected read/write failures (`#79`, ADR 0014).
 */
async function reconcileAppleUserData(db: SqlDriver, store: UserDataStore): Promise<void> {
  try {
    await reconcileUserData(db, store);
  } catch {
    // biome-ignore lint/suspicious/noConsole: a categorized warning without values; there is no logging port yet
    console.warn('catalog: storage/user-data-failed');
  }
}

async function open(): Promise<CatalogService> {
  const db = await createOpSqliteDriver(DATABASE_NAME, databaseLocation(Platform.OS));
  try {
    const opened = await openCatalog(db);
    if (!opened.ok) {
      throw new CatalogOpenError(opened.error);
    }
    const isApple = Platform.OS === 'ios';
    const manifest = isApple ? createSettingsStore(MANIFEST_KEY) : undefined;
    const userData = isApple ? createAppleUserDataStore(USER_DATA_KEY) : undefined;
    if (manifest !== undefined) await reconcile(db, manifest);
    if (userData !== undefined) await reconcileAppleUserData(db, userData);
    const localPlaylistStore = createMobileLocalPlaylistStore(() =>
      createOpSqliteDriver('local-playlists.db', databaseLocation(Platform.OS)),
    );
    const nativeGuideStager = createDeviceNativeGuideStager(db);
    return createCatalogService({
      db,
      secrets: createSecureSecretStore(),
      scheduler: createMacrotaskScheduler(),
      http: createDeviceHttpClient(),
      clock: Date.now,
      localPlaylistStore,
      ...(nativeGuideStager === undefined ? {} : { nativeGuideStager }),
      ...(manifest === undefined ? {} : { manifest }),
      ...(userData === undefined ? {} : { userData }),
    });
  } catch (error) {
    try {
      await db.close?.();
    } catch {
      // Preserve the original open error even if closing the partial handle throws synchronously or rejects.
    }
    throw error;
  }
}
