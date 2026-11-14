import type { PlayerArea } from '../../../shared/player-ipc.ts';
import type { MpvClient } from '../mpv/client.ts';
import { areaToScreen } from './bounds.ts';
import type {
  AppWindowEvent,
  AppWindowLike,
  PresenterEvent,
  VideoPresenter,
  VideoWindowLike,
} from './types.ts';
import { emitSurface } from './types.ts';

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
  'minimize',
  'restore',
  'show',
  'hide',
];

/**
 * Windows presenter: mpv draws (`--wid`) into a frameless video window owned by the app window and kept on the player
 * area. The window is created once per presenter; respawns reuse its HWND. Fullscreen belongs to the app window.
 */
export function createChildWindowPresenter(deps: ChildWindowDeps): VideoPresenter {
  const { appWindow } = deps;
  const listeners = new Set<(event: PresenterEvent) => void>();
  let video: VideoWindowLike | undefined;
  let hwnd = 0;
  let area: PlayerArea | undefined;
  let surfaceLive = false;
  let disposed = false;
  let stopDisplay: (() => void) | undefined;
  let detachClient: (() => void) | undefined;

  const usable = (): VideoWindowLike | undefined =>
    !disposed && video && !video.isDestroyed() && !appWindow.isDestroyed() ? video : undefined;

  const layout = (): void => {
    const target = usable();
    if (!target) return;
    const show = area?.visible === true && appWindow.isVisible() && !appWindow.isMinimized();
    if (!area || !show) {
      if (target.isVisible()) target.hide();
      return;
    }
    target.setBounds(
      areaToScreen(appWindow.getContentBounds(), area, appWindow.webContents.getZoomFactor()),
    );
    if (!target.isVisible()) target.showInactive();
  };

  const surfaceGone = (): void => {
    if (!surfaceLive) return;
    surfaceLive = false;
    emitSurface(listeners, 'destroyed');
  };

  const unfollow = (): void => {
    for (const event of FOLLOWED) appWindow.removeListener(event, layout);
    stopDisplay?.();
    stopDisplay = undefined;
  };

  const ensureWindow = (): VideoWindowLike => {
    if (video) return video;
    const created = deps.createWindow();
    video = created;
    hwnd = deps.hwndOf(created);
    created.on('closed', () => {
      unfollow();
      surfaceGone();
    });
    for (const event of FOLLOWED) appWindow.on(event, layout);
    stopDisplay = deps.onDisplayChange?.(layout);
    surfaceLive = true;
    emitSurface(listeners, 'created');
    layout();
    return created;
  };

  const toggleAppFullscreen = (): void => {
    if (disposed || appWindow.isDestroyed()) return;
    appWindow.setFullScreen(!appWindow.isFullScreen());
  };

  return {
    kind: 'child-window',
    coversArea: true,
    prepare() {
      if (disposed) return Promise.reject(new Error('presenter disposed'));
      const window = ensureWindow();
      if (window.isDestroyed()) return Promise.reject(new Error('video window is gone'));
      return Promise.resolve([`--wid=${hwnd}`]);
    },
    attach(client: MpvClient) {
      if (disposed) return;
      detachClient?.();
      // mpv's own fullscreen (OSC button, default bindings) is turned back and given to the app window.
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
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      unfollow();
      detachClient?.();
      detachClient = undefined;
      if (video && !video.isDestroyed()) video.destroy();
      surfaceGone();
      disposed = true;
      listeners.clear();
    },
  };
}
