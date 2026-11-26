import type { CatalogService } from '@elv/data';
import { type DownloadManagerPort, type DownloadRecord, elvError, err } from '@elv/domain';

const UNSUPPORTED = err(elvError('storage', 'unsupported'));

/**
 * Read-only SQLite-backed {@link DownloadManagerPort} for TV and Mobile targets (`Wave P5`).
 * Reports `supported: false` until native background download workers ship, while safely
 * surfacing any persisted catalog download records without adding native dependencies.
 */
export function createMobileDownloadManagerPort(catalog: CatalogService): DownloadManagerPort {
  return {
    supported: false,
    async list(profileId?: string): Promise<readonly DownloadRecord[]> {
      try {
        return (
          (await catalog.listDownloads?.(profileId !== undefined ? { profileId } : undefined)) ?? []
        );
      } catch {
        return [];
      }
    },
    async get(itemKey: string, profileId?: string): Promise<DownloadRecord | null> {
      try {
        return (await catalog.getDownload?.(itemKey, profileId)) ?? null;
      } catch {
        return null;
      }
    },
    enqueue: async () => UNSUPPORTED,
    pause: async () => UNSUPPORTED,
    resume: async () => UNSUPPORTED,
    cancel: async () => UNSUPPORTED,
    remove: async () => UNSUPPORTED,
    notifyOnlinePlaybackActive: () => {},
    subscribe: () => () => {},
  };
}
