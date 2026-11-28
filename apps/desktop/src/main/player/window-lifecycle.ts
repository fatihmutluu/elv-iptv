import type { PresenterKind } from '../../shared/player-ipc.ts';

/** Default post-first-paint idle delay (ms) before pre-warming a standby `elv-mpv` process. */
const DEFAULT_POST_PAINT_WARMUP_DELAY_MS = 1_500;

/** Minimal `BrowserWindow` surface used for window visibility `PowerBlocker` hooks. */
export interface VisibilityWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  on(event: 'minimize' | 'restore' | 'hide' | 'show', listener: () => void): unknown;
  removeListener(event: 'minimize' | 'restore' | 'hide' | 'show', listener: () => void): unknown;
}

/** Minimal `BrowserWindow` surface used for post-paint idle `elv-mpv` warm-up scheduling. */
export interface WarmUpWindowLike<TContents = unknown> {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  readonly webContents: TContents & {
    isDestroyed(): boolean;
    once(event: 'did-finish-load', listener: () => void): unknown;
    removeListener(event: 'did-finish-load', listener: () => void): unknown;
  };
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
}

/**
 * Builds `isWindowMinimized` and `onWindowVisibilityChange` hooks for `registerPlayerIpc`
 * backed by a window's `minimize`, `restore`, `hide`, and `show` events.
 */
export function createPlayerWindowVisibilityHooks<TOwner>(
  getWindowFromSender: (owner: TOwner) => VisibilityWindowLike | null | undefined,
): {
  isWindowMinimized(owner: TOwner): boolean;
  onWindowVisibilityChange(owner: TOwner, listener: (minimized: boolean) => void): () => void;
} {
  const isHiddenOrMinimized = (win: VisibilityWindowLike | null | undefined): boolean =>
    !win || win.isDestroyed() || win.isMinimized() || !win.isVisible();

  return {
    isWindowMinimized(owner) {
      return isHiddenOrMinimized(getWindowFromSender(owner));
    },
    onWindowVisibilityChange(owner, listener) {
      const win = getWindowFromSender(owner);
      if (!win || win.isDestroyed()) return () => undefined;
      const onHidden = (): void => listener(true);
      const onShown = (): void => {
        if (!win.isDestroyed()) listener(isHiddenOrMinimized(win));
      };
      win.on('minimize', onHidden);
      win.on('hide', onHidden);
      win.on('restore', onShown);
      win.on('show', onShown);
      return () => {
        if (win.isDestroyed()) return;
        win.removeListener('minimize', onHidden);
        win.removeListener('hide', onHidden);
        win.removeListener('restore', onShown);
        win.removeListener('show', onShown);
      };
    },
  };
}

/**
 * Combines window visibility hooks (`isWindowMinimized`, `onWindowVisibilityChange`) with standard
 * window-bound player IPC callbacks (`getDisplayId`, `onVideoAspectRatioChange`, `retargetOwner`).
 */
export function createPlayerWindowHostHooks<
  TOwner,
  TWin extends VisibilityWindowLike,
  TEngine extends { retargetWindow?(window: TWin): boolean },
>(deps: {
  readonly getWindow: (owner: TOwner) => TWin | null | undefined;
  readonly getDisplayId: (win: TWin) => string | undefined;
  readonly onAspectRatio: (win: TWin, aspectRatio: number | undefined) => void;
}): {
  isWindowMinimized(owner: TOwner): boolean;
  onWindowVisibilityChange(owner: TOwner, listener: (minimized: boolean) => void): () => void;
  getDisplayId(owner: TOwner): string | undefined;
  onVideoAspectRatioChange(owner: TOwner, aspectRatio: number | undefined): void;
  retargetOwner(engine: TEngine, nextOwner: TOwner): boolean;
} {
  const visibility = createPlayerWindowVisibilityHooks(deps.getWindow);
  const liveWindow = (owner: TOwner): TWin | undefined => {
    const win = deps.getWindow(owner);
    return win && !win.isDestroyed() ? win : undefined;
  };
  return {
    ...visibility,
    getDisplayId: (owner) => {
      const win = liveWindow(owner);
      return win ? deps.getDisplayId(win) : undefined;
    },
    onVideoAspectRatioChange: (owner, aspectRatio) => {
      const win = liveWindow(owner);
      if (win) deps.onAspectRatio(win, aspectRatio);
    },
    retargetOwner: (engine, nextOwner) => {
      const win = liveWindow(nextOwner);
      return Boolean(win && engine.retargetWindow?.(win) === true);
    },
  };
}

/**
 * Schedules a one-shot post-paint idle warm-up for a visible `'canvas'` main window so the first
 * video play skips `elv-mpv` cold spawn latency without spawning stray windows on non-canvas
 * presenters or interfering with gate benchmarks.
 */
export function schedulePostPaintMpvWarmUp<TContents>(
  window: WarmUpWindowLike<TContents>,
  opts: {
    readonly gate: boolean;
    readonly presenter: PresenterKind;
    readonly delayMs?: number;
    readonly onWarmUp: (contents: TContents) => void;
  },
): () => void {
  if (
    opts.gate ||
    opts.presenter !== 'canvas' ||
    window.isDestroyed() ||
    window.webContents.isDestroyed()
  ) {
    return () => undefined;
  }
  const delayMs = Math.max(0, opts.delayMs ?? DEFAULT_POST_PAINT_WARMUP_DELAY_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!window.isDestroyed()) {
      window.removeListener('closed', cancel);
      if (!window.webContents.isDestroyed()) {
        window.webContents.removeListener('did-finish-load', onLoad);
      }
    }
  };

  const onLoad = (): void => {
    if (cancelled || window.isDestroyed() || window.webContents.isDestroyed()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (
        cancelled ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        window.isMinimized() ||
        !window.isVisible()
      ) {
        return;
      }
      opts.onWarmUp(window.webContents);
    }, delayMs);
  };

  window.webContents.once('did-finish-load', onLoad);
  window.once('closed', cancel);
  return cancel;
}
