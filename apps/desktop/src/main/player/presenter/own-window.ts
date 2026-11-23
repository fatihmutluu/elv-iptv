import type { PlayerArea } from '../../../shared/player-ipc.ts';
import type { MpvClient } from '../mpv/client.ts';
import type { DisplayBounds, FullscreenMode, Rect } from './bounds.ts';
import { areaToScreen, resolveFullscreenRect } from './bounds.ts';
import { isAppWindowFullscreen, setAppWindowFullscreen } from './macos-spaces.ts';
import type { AppWindowLike, VideoPresenter } from './types.ts';
import { createSurfaceTracker } from './types.ts';

/** What the own-window presenter needs from Electron. */
export interface OwnWindowDeps {
  appWindow: AppWindowLike;
  /**
   * Screen DIPs to the units of mpv's `--geometry`: physical pixels on Windows (`screen.dipToScreenRect`),
   * work-area backing pixels on macOS (`macOwnWindowGeometry`).
   */
  toScreenPixels(rect: Rect): Rect;
  /** Optional macOS `NSScreen` index for multi-monitor setups (`--screen=<idx>`). */
  screenIndexOf?(rect: Rect): number | undefined;
  /** Optional display bounds/workArea lookup for notched macOS fullscreen safe-area sizing (`#269`). */
  displayBoundsOf?(rect: Rect): DisplayBounds;
  /** Fullscreen sizing policy on notched displays: `'safe-area'` (default) stays within `workArea`, `'desktop'` spans `bounds`. */
  fullscreenMode?: FullscreenMode;
  /** How long `prepare` waits for a first visible area before it uses the content bounds (default 1,000 ms). */
  firstAreaTimeoutMs?: number;
  /** Bounded window after fullscreen transitions during which non-essential fullscreen IPC is paused (default 400 ms). */
  fullscreenTransitionMs?: number;
  /** When `true`, prefers macOS borderless `simpleFullscreen` over native Space fullscreen (`#301`). */
  useSimpleFullscreen?(): boolean;
  /** Notified when `simpleFullscreen` toggles (Electron does not fire `enter-full-screen` for `setSimpleFullScreen`). */
  onFullscreenChange?(fullscreen: boolean): void;
}

const DEFAULT_FIRST_AREA_TIMEOUT_MS = 1000;
const DEFAULT_FULLSCREEN_TRANSITION_MS = 400;

/**
 * macOS presenter and the Windows fallback: mpv runs in its own window, following host window moves,
 * resizes, and fullscreen transitions bidirectionally (`#435`, `#269`). Each mpv process has its own
 * window, so each attach is a new surface.
 */
export function createOwnWindowPresenter(deps: OwnWindowDeps): VideoPresenter {
  const { appWindow } = deps;
  const surface = createSurfaceTracker();
  const transitionMs = deps.fullscreenTransitionMs ?? DEFAULT_FULLSCREEN_TRANSITION_MS;
  const fullscreenMode: FullscreenMode = deps.fullscreenMode ?? 'safe-area';
  let visibleArea: PlayerArea | undefined;
  let areaVisible = false;
  let fullscreenTransitioning = false;
  let transitionTimer: ReturnType<typeof setTimeout> | undefined;
  let client: MpvClient | undefined;
  let detachClient: (() => void) | undefined;
  let mpvFullscreen: boolean | undefined;
  let pendingMpvFullscreen: boolean | undefined;
  let pendingAppFullscreen: boolean | undefined;
  let disposed = false;
  const waiters = new Set<{ resolve(args: string[]): void; reject(error: Error): void }>();

  const computeGeometry = (area: PlayerArea): { spec: string; dip: Rect } => {
    const rawDip = areaToScreen(
      appWindow.getContentBounds(),
      area,
      appWindow.webContents.getZoomFactor(),
    );
    const dip =
      isAppWindowFullscreen(appWindow) && deps.displayBoundsOf
        ? resolveFullscreenRect(rawDip, deps.displayBoundsOf(rawDip), fullscreenMode)
        : rawDip;
    const px = deps.toScreenPixels(dip);
    const [x, y, w, h] = [px.x, px.y, px.width, px.height].map((n) => Math.round(n) + 0);
    return { spec: `${w}x${h}+${x}+${y}`, dip };
  };

  const geometry = (area: PlayerArea): string[] => {
    const { spec, dip } = computeGeometry(area);
    const screenIdx = deps.screenIndexOf?.(dip);
    const args = [`--geometry=${spec}`];
    if (screenIdx !== undefined && Number.isInteger(screenIdx) && screenIdx >= 0) {
      args.push(`--screen=${screenIdx}`);
    }
    args.push('--input-vo-keyboard=yes');
    return args;
  };

  const contentArea = (): PlayerArea | undefined => {
    if (appWindow.isDestroyed()) return undefined;
    const content = appWindow.getContentBounds();
    const zoom = appWindow.webContents.getZoomFactor();
    return {
      x: 0,
      y: 0,
      width: content.width / zoom,
      height: content.height / zoom,
      visible: true,
    };
  };

  const detach = (): void => {
    detachClient?.();
    detachClient = undefined;
    client = undefined;
    mpvFullscreen = undefined;
    pendingMpvFullscreen = undefined;
    pendingAppFullscreen = undefined;
  };

  const clearTransitionTimer = (): void => {
    if (transitionTimer !== undefined) {
      clearTimeout(transitionTimer);
      transitionTimer = undefined;
    }
  };

  const beginFullscreenTransition = (): void => {
    if (disposed) return;
    fullscreenTransitioning = true;
    clearTransitionTimer();
    transitionTimer = setTimeout(() => {
      transitionTimer = undefined;
      fullscreenTransitioning = false;
      syncGeometry();
    }, transitionMs);
  };

  const syncGeometry = (): void => {
    if (disposed || !client || !visibleArea || !areaVisible) return;
    if (
      appWindow.isDestroyed() ||
      appWindow.isMinimized?.() ||
      fullscreenTransitioning ||
      appWindow.isFullScreen?.() === true ||
      mpvFullscreen === true
    ) {
      return;
    }
    const { spec } = computeGeometry(visibleArea);
    client.command(['set_property', 'geometry', spec]).catch(() => undefined);
  };

  const handleHostFullscreen = (isFullScreen: boolean): void => {
    if (disposed) return;
    beginFullscreenTransition();
    if (pendingAppFullscreen === isFullScreen) {
      pendingAppFullscreen = undefined;
      return;
    }
    pendingAppFullscreen = undefined;
    if (!client) return;
    pendingMpvFullscreen = isFullScreen;
    mpvFullscreen = isFullScreen;
    client.command(['set_property', 'fullscreen', isFullScreen]).catch(() => undefined);
  };

  const onEnterFullScreen = (): void => handleHostFullscreen(true);
  const onLeaveFullScreen = (): void => handleHostFullscreen(false);

  if (typeof appWindow.on === 'function') {
    appWindow.on('move', syncGeometry);
    appWindow.on('resize', syncGeometry);
    appWindow.on('enter-full-screen', onEnterFullScreen);
    appWindow.on('leave-full-screen', onLeaveFullScreen);
  }

  return {
    kind: 'own-window',
    coversArea: false,
    prepare() {
      if (disposed) return Promise.reject(new Error('presenter disposed'));
      if (appWindow.isDestroyed()) return Promise.reject(new Error('app window is gone'));
      if (visibleArea) return Promise.resolve(geometry(visibleArea));
      return new Promise<string[]>((resolve, reject) => {
        const waiter = {
          resolve: (args: string[]) => {
            clearTimeout(timer);
            waiters.delete(waiter);
            resolve(args);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            waiters.delete(waiter);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          if (disposed) {
            waiter.reject(new Error('presenter disposed'));
            return;
          }
          const fallback = contentArea();
          if (!fallback) {
            waiter.reject(new Error('app window is gone'));
            return;
          }
          waiter.resolve(geometry(fallback));
        }, deps.firstAreaTimeoutMs ?? DEFAULT_FIRST_AREA_TIMEOUT_MS);
        waiters.add(waiter);
      });
    },
    attach(next) {
      if (disposed) return;
      detach();
      surface.gone();
      client = next;
      const fsId = next.observe('fullscreen');
      const offEvent = next.onEvent((event) => {
        if (disposed || client !== next) return;
        if (event.event !== 'property-change' || event['id'] !== fsId) return;
        if (typeof event['data'] !== 'boolean') return;
        const value = event['data'];
        const wasUnknown = mpvFullscreen === undefined;
        mpvFullscreen = value;
        if (pendingMpvFullscreen === value) {
          pendingMpvFullscreen = undefined;
          return;
        }
        pendingMpvFullscreen = undefined;
        if (wasUnknown && !value) {
          if (!appWindow.isDestroyed() && isAppWindowFullscreen(appWindow)) {
            if (appWindow.isSimpleFullScreen?.() === true) {
              if (visibleArea) {
                const { spec } = computeGeometry(visibleArea);
                next.command(['set_property', 'geometry', spec]).catch(() => undefined);
              }
            } else {
              pendingMpvFullscreen = true;
              mpvFullscreen = true;
              next.command(['set_property', 'fullscreen', true]).catch(() => undefined);
            }
          }
          return;
        }
        if (!appWindow.isDestroyed() && isAppWindowFullscreen(appWindow) !== value) {
          const useSimple = deps.useSimpleFullscreen?.() === true;
          const mode = setAppWindowFullscreen(appWindow, value, useSimple);
          if (mode === 'simple') {
            deps.onFullscreenChange?.(value);
          } else {
            pendingAppFullscreen = value;
          }
        }
      });
      const offClose = next.onClose(() => {
        if (client !== next) return;
        detach();
        surface.gone();
      });
      detachClient = () => {
        offEvent();
        offClose();
      };
      surface.created();
    },
    setArea(area) {
      if (disposed || appWindow.isDestroyed()) return;
      if (!area.visible) {
        areaVisible = false;
        return;
      }
      visibleArea = { ...area };
      areaVisible = true;
      for (const waiter of [...waiters]) waiter.resolve(geometry(visibleArea));
      syncGeometry();
    },
    toggleFullscreen() {
      if (disposed || fullscreenTransitioning) return;
      if (deps.useSimpleFullscreen?.() === true && !appWindow.isDestroyed()) {
        const next = !isAppWindowFullscreen(appWindow);
        const mode = setAppWindowFullscreen(appWindow, next, true);
        if (mode === 'simple') {
          deps.onFullscreenChange?.(next);
          if (client) {
            client.command(['set_property', 'border', next ? 'no' : 'yes']).catch(() => undefined);
            if (visibleArea) {
              const { spec } = computeGeometry(visibleArea);
              client.command(['set_property', 'geometry', spec]).catch(() => undefined);
            }
          }
          return;
        }
      }
      client?.command(['cycle', 'fullscreen']).catch(() => undefined);
    },
    onEvent: (listener) => surface.onEvent(listener),
    dispose() {
      if (disposed) return;
      disposed = true;
      fullscreenTransitioning = false;
      clearTransitionTimer();
      if (typeof appWindow.removeListener === 'function') {
        appWindow.removeListener('move', syncGeometry);
        appWindow.removeListener('resize', syncGeometry);
        appWindow.removeListener('enter-full-screen', onEnterFullScreen);
        appWindow.removeListener('leave-full-screen', onLeaveFullScreen);
      }
      for (const waiter of [...waiters]) waiter.reject(new Error('presenter disposed'));
      detach();
      surface.gone();
      surface.clear();
    },
  };
}
