import type { PlayerArea, PresenterKind } from '../../../shared/player-ipc.ts';
import type { MpvClient } from '../mpv/client.ts';
import type { Rect } from './bounds.ts';

/** The video surface appeared or went away (one `created` per player screen for the child window). */
export type PresenterEvent = { type: 'surface'; change: 'created' | 'destroyed' };

/** Puts mpv's picture on screen; the engine and the status line only ever talk to this interface. */
export interface VideoPresenter {
  readonly kind: PresenterKind;
  /** True when the video covers the player area, so nothing in the DOM can draw over it. */
  readonly coversArea: boolean;
  /** The mpv arguments for the next spawn (`--wid=<uint32>` or `--geometry=<W>x<H>+<X>+<Y>`). */
  prepare(): Promise<readonly string[]>;
  /** Called after each spawn with the new process's client. */
  attach(client: MpvClient): void;
  /** The latest player area from the renderer. */
  setArea(area: PlayerArea): void;
  /** Child window: the app window's fullscreen; own window: mpv's. */
  toggleFullscreen(): void;
  onEvent(listener: (event: PresenterEvent) => void): () => void;
  /** Destroys what the presenter created; later calls do nothing and `prepare` rejects. */
  dispose(): void;
}

/** App window events that move, resize, hide or show the content area. */
export type AppWindowEvent =
  | 'move'
  | 'resize'
  | 'maximize'
  | 'unmaximize'
  | 'enter-full-screen'
  | 'leave-full-screen'
  | 'minimize'
  | 'restore'
  | 'show'
  | 'hide';

/** The part of the app's `BrowserWindow` a presenter uses. */
export interface AppWindowLike {
  getContentBounds(): Rect;
  readonly webContents: { getZoomFactor(): number };
  isMinimized(): boolean;
  isMaximized?(): boolean;
  maximize?(): void;
  isAlwaysOnTop?(): boolean;
  setAlwaysOnTop?(flag: boolean): void;
  isVisible(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  isDestroyed(): boolean;
  on(event: AppWindowEvent, listener: () => void): unknown;
  removeListener(event: AppWindowEvent, listener: () => void): unknown;
}

/** The part of the video `BrowserWindow` the child-window presenter uses. */
export interface VideoWindowLike {
  setBounds(bounds: Rect): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  getNativeWindowHandle(): Buffer;
  on(event: 'closed', listener: () => void): unknown;
}

/** A presenter's surface bookkeeping: `created` once per live surface, `destroyed` once when it goes. */
export interface SurfaceTracker {
  created(): void;
  /** Emits `destroyed` if a surface is live; otherwise does nothing. */
  gone(): void;
  onEvent(listener: (event: PresenterEvent) => void): () => void;
  /** Drops every listener (on dispose). */
  clear(): void;
}

/** Creates a tracker whose listeners are isolated: one that throws must not keep the others from the event. */
export function createSurfaceTracker(): SurfaceTracker {
  const listeners = new Set<(event: PresenterEvent) => void>();
  let live = false;
  const emit = (change: PresenterEvent['change']): void => {
    for (const listener of [...listeners]) {
      try {
        listener({ type: 'surface', change });
      } catch {
        // a listener bug is the listener's problem
      }
    }
  };
  return {
    created() {
      live = true;
      emit('created');
    },
    gone() {
      if (!live) return;
      live = false;
      emit('destroyed');
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
  };
}
