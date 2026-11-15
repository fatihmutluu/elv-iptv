import type { PlayerArea } from '../../../shared/player-ipc.ts';
import type { MpvClient } from '../mpv/client.ts';
import type { Rect } from './bounds.ts';
import { areaToScreen } from './bounds.ts';
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
  /** How long `prepare` waits for a first visible area before it uses the content bounds (default 1,000 ms). */
  firstAreaTimeoutMs?: number;
}

const DEFAULT_FIRST_AREA_TIMEOUT_MS = 1000;

/**
 * macOS presenter and the Windows fallback: mpv shows its own window, placed over the player area when it first
 * shows and then left to the user. Each mpv process has its own window, so each attach is a new surface.
 */
export function createOwnWindowPresenter(deps: OwnWindowDeps): VideoPresenter {
  const { appWindow } = deps;
  const surface = createSurfaceTracker();
  let visibleArea: PlayerArea | undefined;
  let client: MpvClient | undefined;
  let detachClient: (() => void) | undefined;
  let disposed = false;
  const waiters = new Set<{ resolve(args: string[]): void; reject(error: Error): void }>();

  const geometry = (area: PlayerArea): string[] => {
    const dip = areaToScreen(
      appWindow.getContentBounds(),
      area,
      appWindow.webContents.getZoomFactor(),
    );
    const px = deps.toScreenPixels(dip);
    const [x, y, w, h] = [px.x, px.y, px.width, px.height].map((n) => Math.round(n) + 0);
    return [`--geometry=${w}x${h}+${x}+${y}`];
  };

  const contentArea = (): PlayerArea => {
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
  };

  return {
    kind: 'own-window',
    coversArea: false,
    prepare() {
      if (disposed) return Promise.reject(new Error('presenter disposed'));
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
        const timer = setTimeout(
          () => waiter.resolve(geometry(contentArea())),
          deps.firstAreaTimeoutMs ?? DEFAULT_FIRST_AREA_TIMEOUT_MS,
        );
        waiters.add(waiter);
      });
    },
    attach(next) {
      if (disposed) return;
      detach();
      surface.gone();
      client = next;
      const offClose = next.onClose(() => {
        if (client !== next) return;
        detach();
        surface.gone();
      });
      detachClient = offClose;
      surface.created();
    },
    setArea(area) {
      if (disposed || !area.visible) return;
      visibleArea = { ...area };
      for (const waiter of [...waiters]) waiter.resolve(geometry(visibleArea));
    },
    toggleFullscreen() {
      client?.command(['cycle', 'fullscreen']).catch(() => undefined);
    },
    onEvent: (listener) => surface.onEvent(listener),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const waiter of [...waiters]) waiter.reject(new Error('presenter disposed'));
      detach();
      surface.gone();
      surface.clear();
    },
  };
}
