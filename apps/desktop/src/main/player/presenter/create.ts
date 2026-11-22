import { createServer } from 'node:net';
import { BrowserWindow, screen, sharedTexture } from 'electron';
import type { PresenterKind } from '../../../shared/player-ipc.ts';
import { type FullscreenMode, macOwnWindowGeometry } from './bounds.ts';
import { createCanvasPresenter } from './canvas.ts';
import { createChildWindowPresenter } from './child-window.ts';
import { createOwnWindowPresenter } from './own-window.ts';
import type { VideoPresenter } from './types.ts';
import { createVideoWindow, nativeHwnd } from './video-window-options.ts';

function subscribeDisplayChanges(listener: () => void): () => void {
  screen.on('display-metrics-changed', listener);
  screen.on('display-added', listener);
  screen.on('display-removed', listener);
  return () => {
    screen.removeListener('display-metrics-changed', listener);
    screen.removeListener('display-added', listener);
    screen.removeListener('display-removed', listener);
  };
}

/** Optional per-presenter configuration passed to `createPresenter`. */
export interface CreatePresenterOptions {
  fullscreenMode?: FullscreenMode;
  engineId?: string;
}

/** Builds the presenter of `kind` for an app window with Electron's real windows and screen. */
export function createPresenter(
  kind: PresenterKind,
  appWindow: BrowserWindow,
  platform: NodeJS.Platform,
  opts?: CreatePresenterOptions,
): VideoPresenter {
  if (kind === 'canvas') {
    return createCanvasPresenter({
      appWindow,
      engineId: opts?.engineId ?? '',
      sharedTexture,
      getMainFrame: () =>
        appWindow.isDestroyed() || appWindow.webContents.isDestroyed()
          ? null
          : appWindow.webContents.mainFrame,
      getScaleFactor: () => {
        if (appWindow.isDestroyed()) return 1;
        const display = screen.getDisplayMatching(appWindow.getContentBounds());
        return display.scaleFactor > 0 ? display.scaleFactor : 1;
      },
      createPipeServer: () => createServer(),
      onDisplayChange: subscribeDisplayChanges,
    });
  }
  if (kind === 'child-window') {
    return createChildWindowPresenter({
      appWindow,
      createWindow: () => createVideoWindow(appWindow, BrowserWindow),
      hwndOf: nativeHwnd,
      onDisplayChange: subscribeDisplayChanges,
    });
  }
  return createOwnWindowPresenter({
    appWindow,
    ...(opts?.fullscreenMode !== undefined ? { fullscreenMode: opts.fullscreenMode } : {}),
    toScreenPixels: (rect) => {
      if (platform === 'win32') return screen.dipToScreenRect(appWindow, rect);
      if (platform === 'darwin') {
        const display = screen.getDisplayMatching(rect);
        return macOwnWindowGeometry(rect, display.workArea, display.scaleFactor);
      }
      return rect;
    },
    ...(platform === 'darwin'
      ? {
          displayBoundsOf: (rect) => {
            const display = screen.getDisplayMatching(rect);
            return {
              bounds: display.bounds ?? display.workArea,
              workArea: display.workArea,
            };
          },
          screenIndexOf: (rect) => {
            const displays = screen.getAllDisplays();
            if (displays.length <= 1) return undefined;
            const target = screen.getDisplayMatching(rect);
            const idx = displays.findIndex((d) => d.id === target.id);
            return idx >= 0 ? idx : undefined;
          },
        }
      : {}),
  });
}
