import { BrowserWindow, screen } from 'electron';
import type { PresenterKind } from '../../../shared/player-ipc.ts';
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
    // macOS geometry units and origin are measured in track B (Task 16).
    toScreenPixels: (rect) =>
      platform === 'win32' ? screen.dipToScreenRect(appWindow, rect) : rect,
  });
}
