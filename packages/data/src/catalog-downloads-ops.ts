import type { DownloadRecord, Result, SqlDriver } from '@elv/domain';
import {
  deleteDownload,
  getDownload,
  type ListDownloadsOptions,
  listDownloads,
  type UpsertDownloadInput,
  upsertDownload,
} from './downloads-repo';

/** Offline VOD downloads persistence methods exposed on `CatalogService`. */
export interface CatalogDownloadsOpsMethods {
  listDownloads(opts?: ListDownloadsOptions): Promise<DownloadRecord[]>;
  getDownload(itemKey: string, profileId?: string): Promise<DownloadRecord | null>;
  upsertDownload(input: UpsertDownloadInput): Promise<Result<DownloadRecord>>;
  deleteDownload(itemKey: string, profileId?: string): Promise<Result<void>>;
}

/** @internal Creates offline downloads persistence methods for `CatalogService`. */
export function createCatalogDownloadsOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
}): CatalogDownloadsOpsMethods {
  const { db, clock } = deps;
  return {
    listDownloads: (opts) => listDownloads(db, opts),
    getDownload: (itemKey, profileId) => getDownload(db, itemKey, profileId),
    upsertDownload: (input) => upsertDownload(db, input, clock),
    deleteDownload: (itemKey, profileId) => deleteDownload(db, itemKey, profileId),
  };
}
