import { clampZoomLevel, WINDOW_CHANNELS, ZOOM_LEVEL_STEP } from '../shared/window-ipc.ts';

/** Minimal Electron `before-input-event` event object carrying `preventDefault`. */
export interface BeforeInputEventLike {
  preventDefault(): void;
}

/** Minimal Electron `Input` descriptor received on `before-input-event`. */
export interface BeforeInputDetailsLike {
  readonly type?: string;
  readonly key?: string;
  readonly code?: string;
  readonly control?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/** Minimal `WebContents` surface required by {@link attachWindowZoomAndReloadGuard}. */
interface WindowZoomWebContentsLike {
  isDestroyed(): boolean;
  setZoomLevel?(level: number): void;
  send?(channel: string, ...args: unknown[]): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Minimal `BrowserWindow` surface required by {@link attachWindowZoomAndReloadGuard}. */
export interface WindowZoomWindowLike {
  isDestroyed(): boolean;
  readonly webContents: WindowZoomWebContentsLike;
}

/** Options accepted by {@link attachWindowZoomAndReloadGuard}. */
export interface AttachWindowZoomOptions {
  readonly isPackaged: boolean;
  readonly platform?: NodeJS.Platform;
  getZoomLevel(): number;
  onSetZoomLevel(next: number): number | undefined;
}

function hasPrimaryModifier(input: BeforeInputDetailsLike, platform: NodeJS.Platform): boolean {
  if (input.alt === true) return false;
  return platform === 'darwin'
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
}

function isReloadShortcut(input: BeforeInputDetailsLike, platform: NodeJS.Platform): boolean {
  const key = input.key ?? '';
  const code = input.code ?? '';
  if (key === 'F5' || code === 'F5') return true;
  if (!hasPrimaryModifier(input, platform)) return false;
  return key === 'r' || key === 'R' || code === 'KeyR';
}

function resolveZoomAction(
  input: BeforeInputDetailsLike,
  platform: NodeJS.Platform,
): 'in' | 'out' | 'reset' | null {
  if (!hasPrimaryModifier(input, platform)) return null;
  const key = input.key ?? '';
  const code = input.code ?? '';
  if (key === '+' || key === '=' || code === 'NumpadAdd') return 'in';
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return 'out';
  if (input.shift !== true && (key === '0' || code === 'Digit0' || code === 'Numpad0')) {
    return 'reset';
  }
  return null;
}

/**
 * Attaches persisted UI zoom shortcuts (`Ctrl/Cmd` + `+`/`-`/`0`), re-applies persisted zoom on
 * `dom-ready` and `did-finish-load`, and suppresses accidental reload shortcuts (`Ctrl/Cmd+R`,
 * `Ctrl/Cmd+Shift+R`, `F5`) in packaged builds so live streams are never interrupted.
 */
export function attachWindowZoomAndReloadGuard(
  win: WindowZoomWindowLike,
  opts: AttachWindowZoomOptions,
): () => void {
  const platform = opts.platform ?? process.platform;

  const applyPersistedZoom = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.setZoomLevel?.(clampZoomLevel(opts.getZoomLevel()));
  };

  const onBeforeInputEvent = (rawEvent: unknown, rawInput: unknown): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const event = rawEvent as BeforeInputEventLike | null;
    const input = rawInput as BeforeInputDetailsLike | null;
    if (!event || !input || input.type !== 'keyDown') return;

    if (opts.isPackaged && isReloadShortcut(input, platform)) {
      event.preventDefault();
      return;
    }

    const action = resolveZoomAction(input, platform);
    if (action === null) return;

    event.preventDefault();
    const current = clampZoomLevel(opts.getZoomLevel());
    const target =
      action === 'reset'
        ? 0
        : clampZoomLevel(current + (action === 'in' ? ZOOM_LEVEL_STEP : -ZOOM_LEVEL_STEP));
    const persisted = opts.onSetZoomLevel(target);
    const finalLevel = typeof persisted === 'number' ? clampZoomLevel(persisted) : target;
    win.webContents.setZoomLevel?.(finalLevel);
    win.webContents.send?.(WINDOW_CHANNELS.zoomLevelChanged, finalLevel);
  };

  win.webContents.on('before-input-event', onBeforeInputEvent);
  win.webContents.on('did-finish-load', applyPersistedZoom);
  win.webContents.on('dom-ready', applyPersistedZoom);

  return () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.removeListener?.('before-input-event', onBeforeInputEvent);
    win.webContents.removeListener?.('did-finish-load', applyPersistedZoom);
    win.webContents.removeListener?.('dom-ready', applyPersistedZoom);
  };
}
