import {
  type DownloadEnqueueInput,
  type DownloadManagerPort,
  type DownloadRecord,
  elvError,
  err,
  type Result,
} from '@elv/domain';
import type { DownloadsBridge } from '../../../src/shared/downloads-ipc.ts';

function resolveDownloadsBridge(override?: DownloadsBridge): DownloadsBridge | undefined {
  if (override !== undefined) return override;
  if (typeof window === 'undefined') return undefined;
  return (window as { elv?: { downloads?: DownloadsBridge } }).elv?.downloads;
}

/**
 * Adapts the sandboxed `window.elv.downloads` Electron preload bridge into `@elv/domain`'s
 * {@link DownloadManagerPort}. Falls back cleanly with `supported: false` outside Electron.
 */
export function createDesktopDownloadsPort(bridgeOverride?: DownloadsBridge): DownloadManagerPort {
  const bridge = resolveDownloadsBridge(bridgeOverride);

  if (bridge === undefined) {
    const unsupportedError = (): Result<never> =>
      err(elvError('storage', 'downloads-unsupported', 'offline downloads require desktop app'));
    return {
      supported: false,
      list: async () => [],
      get: async () => null,
      enqueue: async () => unsupportedError(),
      pause: async () => unsupportedError(),
      resume: async () => unsupportedError(),
      cancel: async () => unsupportedError(),
      remove: async () => unsupportedError(),
      notifyOnlinePlaybackActive: async () => undefined,
      subscribe: () => () => undefined,
    };
  }

  return {
    supported: true,

    async list(profileId?: string): Promise<readonly DownloadRecord[]> {
      try {
        return await bridge.list(profileId);
      } catch {
        return [];
      }
    },

    async get(itemKey: string, profileId?: string): Promise<DownloadRecord | null> {
      try {
        return await bridge.get(itemKey, profileId);
      } catch {
        return null;
      }
    },

    async enqueue(input: DownloadEnqueueInput): Promise<Result<DownloadRecord>> {
      try {
        return await bridge.enqueue(input);
      } catch {
        return err(elvError('storage', 'downloads-ipc-failed'));
      }
    },

    async pause(itemKey: string, profileId?: string): Promise<Result<void>> {
      try {
        return await bridge.pause(itemKey, profileId);
      } catch {
        return err(elvError('storage', 'downloads-ipc-failed'));
      }
    },

    async resume(itemKey: string, profileId?: string): Promise<Result<void>> {
      try {
        return await bridge.resume(itemKey, profileId);
      } catch {
        return err(elvError('storage', 'downloads-ipc-failed'));
      }
    },

    async cancel(itemKey: string, profileId?: string): Promise<Result<void>> {
      try {
        return await bridge.cancel(itemKey, profileId);
      } catch {
        return err(elvError('storage', 'downloads-ipc-failed'));
      }
    },

    async remove(itemKey: string, profileId?: string): Promise<Result<void>> {
      try {
        return await bridge.remove(itemKey, profileId);
      } catch {
        return err(elvError('storage', 'downloads-ipc-failed'));
      }
    },

    async notifyOnlinePlaybackActive(active: boolean): Promise<void> {
      await bridge.notifyOnlinePlaybackActive(active).catch(() => undefined);
    },

    subscribe(listener: (records: readonly DownloadRecord[]) => void): () => void {
      return bridge.onChanged(listener);
    },
  };
}
