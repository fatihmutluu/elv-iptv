import type { BrowserWindowConstructorOptions, IpcMain, WebContents } from 'electron';
import { createDesktopUpdaterService } from './desktop-updater.ts';
import {
  createReleasePageWindowController,
  type ReleaseBrowserWindowLike,
} from './release-window.ts';
import { registerUpdaterIpc } from './updater-ipc.ts';

/** Collaborators required by {@link startDesktopUpdater}. */
export interface StartDesktopUpdaterDeps {
  readonly ipcMain: IpcMain;
  readonly currentVersion: string;
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly devOrigin: string | null;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => ReleaseBrowserWindowLike;
  readonly getParent?: () => BrowserWindowConstructorOptions['parent'];
  readonly getBroadcastTargets: () => readonly WebContents[];
  readonly beforeShutdown: () => Promise<void>;
  readonly shutdownCatalog: () => Promise<void>;
  readonly quitAndInstall: () => void;
  readonly log?: (line: string) => void;
}

/**
 * Instantiates the store-gated desktop auto-updater service (`F-13`) with a locked-down sandboxed
 * in-app releases window and registers its trusted-frame IPC handlers, returning the disposer for
 * `will-quit` teardown.
 */
export function startDesktopUpdater(deps: StartDesktopUpdaterDeps): () => void {
  const procFlags = process as NodeJS.Process & { windowsStore?: boolean; mas?: boolean };
  const releaseWindow = createReleasePageWindowController({
    createWindow: deps.createWindow,
    ...(deps.getParent !== undefined ? { getParent: deps.getParent } : {}),
  });
  const service = createDesktopUpdaterService({
    currentVersion: deps.currentVersion,
    env: {
      platform: deps.platform,
      isPackaged: deps.isPackaged,
      windowsStore: procFlags.windowsStore === true,
      mas: procFlags.mas === true,
      ...(process.env['APPIMAGE'] !== undefined ? { appImage: process.env['APPIMAGE'] } : {}),
    },
    beforeShutdown: deps.beforeShutdown,
    shutdownCatalog: deps.shutdownCatalog,
    quitAndInstall: deps.quitAndInstall,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  });
  const disposeIpc = registerUpdaterIpc({
    ipcMain: deps.ipcMain,
    service,
    openExternal: releaseWindow.open,
    getBroadcastTargets: deps.getBroadcastTargets,
    devOrigin: deps.devOrigin,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  });
  return () => {
    disposeIpc();
    releaseWindow.close();
  };
}
