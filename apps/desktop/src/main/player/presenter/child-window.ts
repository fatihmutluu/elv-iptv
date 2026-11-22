import type { PlayerArea } from '../../../shared/player-ipc.ts';
import type { MpvClient } from '../mpv/client.ts';
import { areaToScreen } from './bounds.ts';
import type { AppWindowEvent, AppWindowLike, VideoPresenter, VideoWindowLike } from './types.ts';
import { createSurfaceTracker } from './types.ts';

/** What the child-window presenter needs from Electron. */
export interface ChildWindowDeps {
  appWindow: AppWindowLike;
  /** Creates the hidden video window (`createVideoWindow(appWindow, BrowserWindow)` in the app). */
  createWindow(): VideoWindowLike;
  /** The HWND mpv draws into (`nativeHwnd`). */
  hwndOf(window: VideoWindowLike): number;
  /** Subscribes to display changes (scale factor, arrangement); returns the unsubscribe. */
  onDisplayChange?(listener: () => void): () => void;
}

const FOLLOWED: readonly AppWindowEvent[] = [
  'move',
  'resize',
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen',
  'always-on-top-changed',
  'minimize',
  'restore',
  'show',
  'hide',
];

interface SavedWindowState {
  maximized: boolean;
  alwaysOnTop: boolean;
}

/**
 * Windows presenter: mpv draws (`--wid`) into a frameless video window owned by the app window and kept on the player
 * area. The window is created once per presenter; respawns reuse its HWND. Fullscreen belongs to the app window.
 */
export function createChildWindowPresenter(deps: ChildWindowDeps): VideoPresenter {
  const { appWindow } = deps;
  const surface = createSurfaceTracker();
  let video: VideoWindowLike | undefined;
  let hwnd = 0;
  let area: PlayerArea | undefined;
  let disposed = false;
  let stopDisplay: (() => void) | undefined;
  let detachClient: (() => void) | undefined;
  let savedWindowState: SavedWindowState | undefined;

  const usable = (): VideoWindowLike | undefined =>
    !disposed && video && !video.isDestroyed() && !appWindow.isDestroyed() ? video : undefined;

  const restorePostFullscreen = (): void => {
    const saved = savedWindowState;
    if (!saved || appWindow.isDestroyed() || appWindow.isFullScreen()) return;
    savedWindowState = undefined;
    if (saved.maximized && appWindow.isMaximized?.() === false) {
      appWindow.maximize?.();
    }
    if (saved.alwaysOnTop !== (appWindow.isAlwaysOnTop?.() === true)) {
      appWindow.setAlwaysOnTop?.(saved.alwaysOnTop);
    }
  };

  let lastSyncedAlwaysOnTop: boolean | undefined;

  const syncVideoZOrder = (target: VideoWindowLike): void => {
    const pinned = appWindow.isAlwaysOnTop?.() === true;
    if (lastSyncedAlwaysOnTop !== pinned) {
      lastSyncedAlwaysOnTop = pinned;
      if (pinned) target.setAlwaysOnTop?.(true, 'floating', 1);
      else target.setAlwaysOnTop?.(false, 'normal');
    }
    if (pinned && target.isVisible()) target.moveTop?.();
  };

  const layout = (): void => {
    if (!disposed && !appWindow.isDestroyed() && !appWindow.isFullScreen()) {
      restorePostFullscreen();
    }
    const target = usable();
    if (!target) return;
    syncVideoZOrder(target);
    const show = area?.visible === true && appWindow.isVisible() && !appWindow.isMinimized();
    if (!area || !show) {
      if (target.isVisible()) target.hide();
      return;
    }
    target.setBounds(
      areaToScreen(appWindow.getContentBounds(), area, appWindow.webContents.getZoomFactor()),
    );
    if (!target.isVisible()) target.showInactive();
    if (appWindow.isAlwaysOnTop?.() === true) target.moveTop?.();
  };

  const onVideoFocus = (): void => {
    if (!disposed && !appWindow.isDestroyed()) appWindow.focus?.();
  };

  const unfollow = (): void => {
    for (const event of FOLLOWED) appWindow.removeListener(event, layout);
    if (video && !video.isDestroyed()) video.removeListener?.('focus', onVideoFocus);
    stopDisplay?.();
    stopDisplay = undefined;
  };

  const ensureWindow = (): VideoWindowLike => {
    if (video) return video;
    const created = deps.createWindow();
    let handle: number;
    try {
      handle = deps.hwndOf(created);
    } catch (error) {
      created.destroy();
      throw error;
    }
    video = created;
    hwnd = handle;
    created.on('focus', onVideoFocus);
    created.on('closed', () => {
      unfollow();
      surface.gone();
    });
    for (const event of FOLLOWED) appWindow.on(event, layout);
    stopDisplay = deps.onDisplayChange?.(layout);
    surface.created();
    layout();
    return created;
  };

  const toggleAppFullscreen = (): void => {
    if (disposed || appWindow.isDestroyed()) return;
    if (!appWindow.isFullScreen()) {
      savedWindowState = {
        maximized: appWindow.isMaximized?.() === true,
        alwaysOnTop: appWindow.isAlwaysOnTop?.() === true,
      };
      appWindow.setFullScreen(true);
      return;
    }
    appWindow.setFullScreen(false);
    restorePostFullscreen();
  };

  return {
    kind: 'child-window',
    coversArea: true,
    async prepare() {
      if (disposed) throw new Error('presenter disposed');
      const window = ensureWindow();
      if (window.isDestroyed()) throw new Error('video window is gone');
      return [`--wid=${hwnd}`, '--auto-window-resize=no', '--input-vo-keyboard=no'];
    },
    attach(client: MpvClient) {
      if (disposed) return;
      detachClient?.();
      const id = client.observe('fullscreen');
      const off = client.onEvent((e) => {
        if (e.event !== 'property-change' || e['id'] !== id || e['data'] !== true) return;
        client.command(['set_property', 'fullscreen', false]).catch(() => undefined);
        toggleAppFullscreen();
      });
      detachClient = off;
    },
    setArea(next) {
      if (disposed) return;
      area = { ...next };
      layout();
    },
    toggleFullscreen: toggleAppFullscreen,
    onEvent: (listener) => surface.onEvent(listener),
    dispose() {
      if (disposed) return;
      unfollow();
      detachClient?.();
      detachClient = undefined;
      savedWindowState = undefined;
      if (video && !video.isDestroyed()) video.destroy();
      surface.gone();
      disposed = true;
      surface.clear();
    },
  };
}
