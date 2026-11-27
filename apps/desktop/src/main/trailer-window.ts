import type { BrowserWindowConstructorOptions } from 'electron';
import { isAllowedExternalTrailerUrl } from '../shared/window-ipc.ts';

/** Minimal window contract used by {@link createTrailerWindowController} (`#512`). */
export interface TrailerBrowserWindowLike {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<unknown>;
  focus(): void;
  show?(): void;
  on(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    on(
      event: 'will-navigate',
      listener: (event: { preventDefault(): void }, url: string) => void,
    ): unknown;
  };
}

/** Builds strict sandboxed Electron window options for an in-app YouTube trailer window (`#512`). */
export function buildTrailerWindowOptions(
  parent?: BrowserWindowConstructorOptions['parent'],
): BrowserWindowConstructorOptions {
  return {
    title: 'ELV IPTV — Trailer',
    width: 1024,
    height: 600,
    minWidth: 640,
    minHeight: 390,
    autoHideMenuBar: true,
    backgroundColor: '#090A0E',
    ...(parent !== undefined ? { parent } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'trailer',
    },
  };
}

/**
 * Manages a single reusable, sandboxed in-app trailer window locked strictly to HTTPS YouTube URLs.
 * Avoids `shell.openExternal` while letting desktop users watch YouTube trailers cleanly in-app (`#512`).
 */
export function createTrailerWindowController<TWin extends TrailerBrowserWindowLike>(deps: {
  readonly createWindow: (options: BrowserWindowConstructorOptions) => TWin;
  readonly getParent?: () => BrowserWindowConstructorOptions['parent'];
}): {
  open(url: string): Promise<boolean>;
} {
  let activeWindow: TWin | null = null;

  return {
    async open(rawUrl: string): Promise<boolean> {
      if (!isAllowedExternalTrailerUrl(rawUrl)) return false;
      const url = rawUrl.trim();
      if (activeWindow === null || activeWindow.isDestroyed()) {
        const win = deps.createWindow(buildTrailerWindowOptions(deps.getParent?.()));
        activeWindow = win;
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (event, targetUrl) => {
          if (!isAllowedExternalTrailerUrl(targetUrl)) {
            event.preventDefault();
          }
        });
        win.on('closed', () => {
          if (activeWindow === win) activeWindow = null;
        });
      }
      await activeWindow.loadURL(url);
      activeWindow.show?.();
      activeWindow.focus();
      return true;
    },
  };
}
