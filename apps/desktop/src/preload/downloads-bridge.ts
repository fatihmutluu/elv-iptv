import type { DownloadEnqueueInput, DownloadRecord, Result } from '@elv/domain';
import {
  DOWNLOADS_CHANNELS,
  type DownloadsBridge,
  isDownloadEnqueueRequest,
  isDownloadKeyRequest,
  isDownloadListRequest,
  isDownloadOnlinePlaybackRequest,
  isDownloadRecord,
  isDownloadRecordList,
  isDownloadRecordResult,
  isDownloadVoidResult,
} from '../shared/downloads-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createDownloadsBridge}. */
export interface DownloadsIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/**
 * Builds the frozen `window.elv.downloads` bridge inside the sandboxed Electron preload.
 * Strictly validates every request before sending and every reply before returning to the renderer.
 */
export function createDownloadsBridge(ipc: DownloadsIpcRendererLike): DownloadsBridge {
  const bridge: DownloadsBridge = {
    async list(profileId?: string): Promise<readonly DownloadRecord[]> {
      const payload = profileId === undefined ? {} : { profileId };
      if (!isDownloadListRequest(payload)) {
        throw new Error(`${DOWNLOADS_CHANNELS.list} received invalid profileId`);
      }
      const reply = await ipc.invoke(DOWNLOADS_CHANNELS.list, payload);
      if (!isDownloadRecordList(reply)) {
        throw new Error(`${DOWNLOADS_CHANNELS.list} returned an unexpected reply`);
      }
      return reply;
    },

    async get(itemKey: string, profileId?: string): Promise<DownloadRecord | null> {
      const payload = profileId === undefined ? { itemKey } : { itemKey, profileId };
      if (!isDownloadKeyRequest(payload)) {
        throw new Error(`${DOWNLOADS_CHANNELS.get} received invalid request`);
      }
      const reply = await ipc.invoke(DOWNLOADS_CHANNELS.get, payload);
      if (reply !== null && !isDownloadRecord(reply)) {
        throw new Error(`${DOWNLOADS_CHANNELS.get} returned an unexpected reply`);
      }
      return reply;
    },

    async enqueue(input: DownloadEnqueueInput): Promise<Result<DownloadRecord>> {
      if (!isDownloadEnqueueRequest(input)) {
        throw new Error(`${DOWNLOADS_CHANNELS.enqueue} received invalid download payload`);
      }
      const reply = await ipc.invoke(DOWNLOADS_CHANNELS.enqueue, input);
      if (!isDownloadRecordResult(reply)) {
        throw new Error(`${DOWNLOADS_CHANNELS.enqueue} returned an unexpected reply`);
      }
      return reply;
    },

    async pause(itemKey: string, profileId?: string): Promise<Result<void>> {
      const payload = profileId === undefined ? { itemKey } : { itemKey, profileId };
      if (!isDownloadKeyRequest(payload)) {
        throw new Error(`${DOWNLOADS_CHANNELS.pause} received invalid request`);
      }
      const reply = await ipc.invoke(DOWNLOADS_CHANNELS.pause, payload);
      if (!isDownloadVoidResult(reply)) {
        throw new Error(`${DOWNLOADS_CHANNELS.pause} returned an unexpected reply`);
      }
      return reply;
    },

    async resume(itemKey: string, profileId?: string): Promise<Result<void>> {
      const payload = profileId === undefined ? { itemKey } : { itemKey, profileId };
      if (!isDownloadKeyRequest(payload)) {
        throw new Error(`${DOWNLOADS_CHANNELS.resume} received invalid request`);
      }
      const reply = await ipc.invoke(DOWNLOADS_CHANNELS.resume, payload);
      if (!isDownloadVoidResult(reply)) {
        throw new Error(`${DOWNLOADS_CHANNELS.resume} returned an unexpected reply`);
      }
      return reply;
    },

    async cancel(itemKey: string, profileId?: string): Promise<Result<void>> {
      const payload = profileId === undefined ? { itemKey } : { itemKey, profileId };
      if (!isDownloadKeyRequest(payload)) {
        throw new Error(`${DOWNLOADS_CHANNELS.cancel} received invalid request`);
      }
      const reply = await ipc.invoke(DOWNLOADS_CHANNELS.cancel, payload);
      if (!isDownloadVoidResult(reply)) {
        throw new Error(`${DOWNLOADS_CHANNELS.cancel} returned an unexpected reply`);
      }
      return reply;
    },

    async remove(itemKey: string, profileId?: string): Promise<Result<void>> {
      const payload = profileId === undefined ? { itemKey } : { itemKey, profileId };
      if (!isDownloadKeyRequest(payload)) {
        throw new Error(`${DOWNLOADS_CHANNELS.remove} received invalid request`);
      }
      const reply = await ipc.invoke(DOWNLOADS_CHANNELS.remove, payload);
      if (!isDownloadVoidResult(reply)) {
        throw new Error(`${DOWNLOADS_CHANNELS.remove} returned an unexpected reply`);
      }
      return reply;
    },

    async notifyOnlinePlaybackActive(active: boolean): Promise<void> {
      const payload = { active };
      if (!isDownloadOnlinePlaybackRequest(payload)) {
        throw new Error(`${DOWNLOADS_CHANNELS.notifyOnlinePlayback} received invalid payload`);
      }
      await ipc.invoke(DOWNLOADS_CHANNELS.notifyOnlinePlayback, payload);
    },

    onChanged(listener: (records: readonly DownloadRecord[]) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (!isDownloadRecordList(payload)) return;
        try {
          listener(payload);
        } catch {
          // Isolate renderer listener failures.
        }
      };
      ipc.on(DOWNLOADS_CHANNELS.changed, wrapped);
      return () => {
        ipc.removeListener(DOWNLOADS_CHANNELS.changed, wrapped);
      };
    },
  };

  return Object.freeze(bridge);
}
