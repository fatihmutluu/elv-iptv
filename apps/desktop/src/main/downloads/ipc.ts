import type { DownloadRecord, Result } from '@elv/domain';
import {
  DOWNLOADS_CHANNELS,
  isDownloadEnqueueRequest,
  isDownloadKeyRequest,
  isDownloadListRequest,
  isDownloadOnlinePlaybackRequest,
} from '../../shared/downloads-ipc.ts';
import { isAllowedDevNavigation } from '../dev-server.ts';
import { isAllowedAppNavigation } from '../security.ts';
import type { DesktopDownloadManager } from './download-manager.ts';

interface SenderFrameLike {
  readonly url?: string;
  readonly top?: unknown;
}

interface SenderWebContentsLike {
  isDestroyed?(): boolean;
  getURL?(): string;
  send?(channel: string, ...args: unknown[]): void;
}

interface DownloadsIpcEventLike {
  readonly sender?: SenderWebContentsLike;
  readonly senderFrame?: SenderFrameLike | null;
}

type DownloadsIpcHandler = (event: DownloadsIpcEventLike, ...args: unknown[]) => unknown;

/** Minimal `ipcMain` surface used by {@link registerDownloadsIpc}. */
export interface DownloadsIpcMainLike {
  handle(channel: string, listener: DownloadsIpcHandler): void;
  removeHandler(channel: string): void;
}

/** Collaborators injected into {@link registerDownloadsIpc}. */
export interface RegisterDownloadsIpcDeps {
  readonly ipcMain: DownloadsIpcMainLike;
  readonly manager: DesktopDownloadManager;
  readonly getBroadcastTargets?: () => readonly SenderWebContentsLike[];
  readonly devOrigin?: string | null;
  readonly log?: (line: string) => void;
}

/**
 * Verifies an IPC event originated from the top-level trusted `app://elv` (or dev) frame.
 * Fails closed when `event.senderFrame` is missing or `null`.
 */
function isTrustedDownloadsIpcEvent(
  event: DownloadsIpcEventLike,
  devOrigin?: string | null,
): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame === undefined) return false;
  if (frame.top !== undefined && frame.top !== frame) return false;
  const url = typeof frame.url === 'string' ? frame.url : '';
  if (url.length === 0) return false;
  if (isAllowedAppNavigation(url)) return true;
  if (devOrigin !== null && devOrigin !== undefined && devOrigin.length > 0) {
    return isAllowedDevNavigation(url, devOrigin);
  }
  return false;
}

/**
 * Registers Electron IPC handlers for the offline VOD download manager and broadcasts
 * throttled state/progress snapshots to trusted app windows. Returns the disposer.
 */
export function registerDownloadsIpc(deps: RegisterDownloadsIpcDeps): () => void {
  const { ipcMain, manager, devOrigin, log } = deps;

  const assertTrusted = (event: DownloadsIpcEventLike, channel: string): void => {
    if (!isTrustedDownloadsIpcEvent(event, devOrigin)) {
      log?.(`downloads ipc: rejected untrusted sender on ${channel}`);
      throw new Error(`untrusted sender for ${channel}`);
    }
  };

  const broadcastChanged = (records: readonly DownloadRecord[]): void => {
    const targets = deps.getBroadcastTargets?.() ?? [];
    for (const target of targets) {
      if (target.isDestroyed?.()) continue;
      const url = target.getURL?.() ?? '';
      const allowed =
        isAllowedAppNavigation(url) ||
        (devOrigin !== null &&
          devOrigin !== undefined &&
          devOrigin.length > 0 &&
          isAllowedDevNavigation(url, devOrigin));
      if (!allowed) continue;
      try {
        target.send?.(DOWNLOADS_CHANNELS.changed, records);
      } catch {
        // Ignore racing window teardown.
      }
    }
  };

  const unsubscribe = manager.subscribe(broadcastChanged);

  ipcMain.handle(
    DOWNLOADS_CHANNELS.list,
    async (event, raw): Promise<readonly DownloadRecord[]> => {
      assertTrusted(event, DOWNLOADS_CHANNELS.list);
      if (!isDownloadListRequest(raw)) {
        log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.list} payload`);
        throw new Error(`invalid ${DOWNLOADS_CHANNELS.list} payload`);
      }
      return manager.list(raw?.profileId);
    },
  );

  ipcMain.handle(DOWNLOADS_CHANNELS.get, async (event, raw): Promise<DownloadRecord | null> => {
    assertTrusted(event, DOWNLOADS_CHANNELS.get);
    if (!isDownloadKeyRequest(raw)) {
      log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.get} payload`);
      throw new Error(`invalid ${DOWNLOADS_CHANNELS.get} payload`);
    }
    return manager.get(raw.itemKey, raw.profileId);
  });

  ipcMain.handle(
    DOWNLOADS_CHANNELS.enqueue,
    async (event, raw): Promise<Result<DownloadRecord>> => {
      assertTrusted(event, DOWNLOADS_CHANNELS.enqueue);
      if (!isDownloadEnqueueRequest(raw)) {
        log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.enqueue} payload`);
        throw new Error(`invalid ${DOWNLOADS_CHANNELS.enqueue} payload`);
      }
      return manager.enqueue(raw);
    },
  );

  ipcMain.handle(DOWNLOADS_CHANNELS.pause, async (event, raw): Promise<Result<void>> => {
    assertTrusted(event, DOWNLOADS_CHANNELS.pause);
    if (!isDownloadKeyRequest(raw)) {
      log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.pause} payload`);
      throw new Error(`invalid ${DOWNLOADS_CHANNELS.pause} payload`);
    }
    return manager.pause(raw.itemKey, raw.profileId);
  });

  ipcMain.handle(DOWNLOADS_CHANNELS.resume, async (event, raw): Promise<Result<void>> => {
    assertTrusted(event, DOWNLOADS_CHANNELS.resume);
    if (!isDownloadKeyRequest(raw)) {
      log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.resume} payload`);
      throw new Error(`invalid ${DOWNLOADS_CHANNELS.resume} payload`);
    }
    return manager.resume(raw.itemKey, raw.profileId);
  });

  ipcMain.handle(DOWNLOADS_CHANNELS.cancel, async (event, raw): Promise<Result<void>> => {
    assertTrusted(event, DOWNLOADS_CHANNELS.cancel);
    if (!isDownloadKeyRequest(raw)) {
      log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.cancel} payload`);
      throw new Error(`invalid ${DOWNLOADS_CHANNELS.cancel} payload`);
    }
    return manager.cancel(raw.itemKey, raw.profileId);
  });

  ipcMain.handle(DOWNLOADS_CHANNELS.remove, async (event, raw): Promise<Result<void>> => {
    assertTrusted(event, DOWNLOADS_CHANNELS.remove);
    if (!isDownloadKeyRequest(raw)) {
      log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.remove} payload`);
      throw new Error(`invalid ${DOWNLOADS_CHANNELS.remove} payload`);
    }
    return manager.remove(raw.itemKey, raw.profileId);
  });

  ipcMain.handle(DOWNLOADS_CHANNELS.notifyOnlinePlayback, async (event, raw): Promise<void> => {
    assertTrusted(event, DOWNLOADS_CHANNELS.notifyOnlinePlayback);
    if (!isDownloadOnlinePlaybackRequest(raw)) {
      log?.(`downloads ipc: dropped invalid ${DOWNLOADS_CHANNELS.notifyOnlinePlayback} payload`);
      throw new Error(`invalid ${DOWNLOADS_CHANNELS.notifyOnlinePlayback} payload`);
    }
    await manager.notifyOnlinePlaybackActive(raw.active);
  });

  const channels: readonly string[] = [
    DOWNLOADS_CHANNELS.list,
    DOWNLOADS_CHANNELS.get,
    DOWNLOADS_CHANNELS.enqueue,
    DOWNLOADS_CHANNELS.pause,
    DOWNLOADS_CHANNELS.resume,
    DOWNLOADS_CHANNELS.cancel,
    DOWNLOADS_CHANNELS.remove,
    DOWNLOADS_CHANNELS.notifyOnlinePlayback,
  ];

  return () => {
    unsubscribe();
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
    }
  };
}
