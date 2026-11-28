import type { BrowserWindowConstructorOptions } from 'electron';
import { isAllowedReleasePageUrl } from '../../shared/updater-ipc.ts';

/** Minimal window contract used by {@link createReleasePageWindowController} (`F-13`). */
export interface ReleaseBrowserWindowLike {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<unknown>;
  focus(): void;
  show?(): void;
  close?(): void;
  on(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    on(
      event: 'will-navigate' | 'will-redirect',
      listener: (event: { preventDefault(): void }, url: string) => void,
    ): unknown;
  };
}

/**
 * Builds strict sandboxed Electron window options for viewing ELV IPTV's official GitHub Releases
 * page in-app without invoking OS `shell.openExternal` (`F-13`).
 */
export function buildReleaseWindowOptions(
  parent?: BrowserWindowConstructorOptions['parent'],
): BrowserWindowConstructorOptions {
  return {
    title: 'ELV IPTV — Releases',
    width: 1024,
    height: 680,
    minWidth: 640,
    minHeight: 420,
    autoHideMenuBar: true,
    backgroundColor: '#090A0E',
    ...(parent !== undefined ? { parent } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'updater-releases',
    },
  };
}

/**
 * Manages a single reusable, sandboxed in-app release page window locked strictly to official
 * ELV IPTV HTTPS GitHub Releases URLs (`isAllowedReleasePageUrl`).
 */
export function createReleasePageWindowController<TWin extends ReleaseBrowserWindowLike>(deps: {
  readonly createWindow: (options: BrowserWindowConstructorOptions) => TWin;
  readonly getParent?: () => BrowserWindowConstructorOptions['parent'];
}): {
  open(url: string): Promise<boolean>;
  close(): void;
} {
  let activeWindow: TWin | null = null;

  return {
    async open(rawUrl: string): Promise<boolean> {
      if (!isAllowedReleasePageUrl(rawUrl)) return false;
      const url = rawUrl.trim();
      if (activeWindow === null || activeWindow.isDestroyed()) {
        const win = deps.createWindow(buildReleaseWindowOptions(deps.getParent?.()));
        activeWindow = win;
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const guardNavigation = (event: { preventDefault(): void }, targetUrl: string): void => {
          if (!isAllowedReleasePageUrl(targetUrl)) {
            event.preventDefault();
          }
        };
        win.webContents.on('will-navigate', guardNavigation);
        win.webContents.on('will-redirect', guardNavigation);
        win.on('closed', () => {
          if (activeWindow === win) activeWindow = null;
        });
      }
      await activeWindow.loadURL(url);
      activeWindow.show?.();
      activeWindow.focus();
      return true;
    },

    close(): void {
      if (activeWindow !== null && !activeWindow.isDestroyed()) {
        activeWindow.close?.();
      }
      activeWindow = null;
    },
  };
}
