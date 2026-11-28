import {
  type DesktopUpdateState,
  isAllowedReleasePageUrl,
  UPDATER_CHANNELS,
} from '../../shared/updater-ipc.ts';
import { isAllowedDevNavigation } from '../dev-server.ts';
import { isAllowedAppNavigation } from '../security.ts';
import { assertTrustedSenderFrame, type TrustedSenderEventLike } from '../trusted-sender.ts';
import type { DesktopUpdaterService } from './desktop-updater.ts';

interface SenderWebContentsLike {
  isDestroyed?(): boolean;
  getURL?(): string;
  send?(channel: string, ...args: unknown[]): void;
}

interface UpdaterIpcEventLike extends TrustedSenderEventLike {
  readonly sender?: SenderWebContentsLike;
}

type UpdaterIpcHandler = (event: UpdaterIpcEventLike, ...args: unknown[]) => unknown;

/** Minimal `ipcMain` surface used by {@link registerUpdaterIpc}. */
interface UpdaterIpcMainLike {
  handle(channel: string, listener: UpdaterIpcHandler): void;
  removeHandler(channel: string): void;
}

/** Collaborators injected into {@link registerUpdaterIpc}. */
export interface RegisterUpdaterIpcDeps {
  readonly ipcMain: UpdaterIpcMainLike;
  readonly service: DesktopUpdaterService;
  readonly openExternal: (url: string) => Promise<boolean | void> | boolean | void;
  readonly getBroadcastTargets?: () => readonly SenderWebContentsLike[];
  readonly devOrigin?: string | null;
  readonly log?: (line: string) => void;
}

/**
 * Registers Electron IPC handlers for the store-gated desktop auto-updater (`F-13`), enforcing
 * trusted sender frames on every handler, strict HTTPS GitHub releases allowlisting on
 * `openExternal`, and trusted-window-only state broadcasts. Returns a clean disposer.
 */
export function registerUpdaterIpc(deps: RegisterUpdaterIpcDeps): () => void {
  const { ipcMain, service, openExternal, devOrigin, log } = deps;

  const assertTrusted = (event: UpdaterIpcEventLike, channel: string): void => {
    assertTrustedSenderFrame(event, channel, devOrigin, log);
  };

  const broadcastState = (nextState: DesktopUpdateState): void => {
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
        target.send?.(UPDATER_CHANNELS.stateChanged, nextState);
      } catch {
        // Ignore racing window teardown.
      }
    }
  };

  const unsubscribe = service.subscribe(broadcastState);

  ipcMain.handle(UPDATER_CHANNELS.getState, async (event): Promise<DesktopUpdateState> => {
    assertTrusted(event, UPDATER_CHANNELS.getState);
    return service.getState();
  });

  ipcMain.handle(UPDATER_CHANNELS.check, async (event): Promise<DesktopUpdateState> => {
    assertTrusted(event, UPDATER_CHANNELS.check);
    return service.checkForUpdates();
  });

  ipcMain.handle(UPDATER_CHANNELS.download, async (event): Promise<DesktopUpdateState> => {
    assertTrusted(event, UPDATER_CHANNELS.download);
    return service.downloadUpdate();
  });

  ipcMain.handle(UPDATER_CHANNELS.install, async (event): Promise<void> => {
    assertTrusted(event, UPDATER_CHANNELS.install);
    await service.installUpdate();
  });

  ipcMain.handle(UPDATER_CHANNELS.openReleasePage, async (event): Promise<boolean> => {
    assertTrusted(event, UPDATER_CHANNELS.openReleasePage);
    if (service.support === 'unsupported') return false;
    const candidateUrl = service.getManualDownloadUrl() ?? service.getState().manualDownloadUrl;
    if (!isAllowedReleasePageUrl(candidateUrl)) {
      log?.(`updater ipc: blocked disallowed ${UPDATER_CHANNELS.openReleasePage} URL`);
      return false;
    }
    try {
      const opened = await openExternal(candidateUrl);
      return opened !== false;
    } catch {
      return false;
    }
  });

  const channels: readonly string[] = [
    UPDATER_CHANNELS.getState,
    UPDATER_CHANNELS.check,
    UPDATER_CHANNELS.download,
    UPDATER_CHANNELS.install,
    UPDATER_CHANNELS.openReleasePage,
  ];

  return () => {
    unsubscribe();
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
    }
  };
}
