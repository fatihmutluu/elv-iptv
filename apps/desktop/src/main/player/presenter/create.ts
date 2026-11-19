import { BrowserWindow, screen } from 'electron';
import type { PresenterKind } from '../../../shared/player-ipc.ts';
import { macOwnWindowGeometry } from './bounds.ts';
import { createChildWindowPresenter } from './child-window.ts';
import { createOwnWindowPresenter } from './own-window.ts';
import type { VideoPresenter } from './types.ts';
import { createVideoWindow, nativeHwnd } from './video-window-options.ts';

/** Builds the presenter of `kind` for an app window with Electron's real windows and screen. */
export function createPresenter(
  kind: PresenterKind,
  appWindow: BrowserWindow,
  platform: NodeJS.Platform,
): VideoPresenter {
  if (kind === 'child-window') {
    return createChildWindowPresenter({
      appWindow,
      createWindow: () => createVideoWindow(appWindow, BrowserWindow),
      hwndOf: nativeHwnd,
      onDisplayChange: (listener) => {
        screen.on('display-metrics-changed', listener);
        screen.on('display-added', listener);
        screen.on('display-removed', listener);
        return () => {
          screen.removeListener('display-metrics-changed', listener);
          screen.removeListener('display-added', listener);
          screen.removeListener('display-removed', listener);
        };
      },
    });
  }
  return createOwnWindowPresenter({
    appWindow,
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
