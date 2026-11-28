import type { BrowserWindowConstructorOptions } from 'electron';
import type { PresenterKind } from '../shared/player-ipc.ts';
import type { Rect } from './window-bounds.ts';

/** Title shown in the window frame and the task bar. */
export const WINDOW_TITLE = 'ELV IPTV';

const DEFAULT_MIN_WIDTH = 800;
const DEFAULT_MIN_HEIGHT = 500;

const DEFAULT_MAX_CRASH_RELOADS = 3;
const DEFAULT_CRASH_WINDOW_MS = 60_000;

/** Minimal BrowserWindow surface used to recover from renderer process crashes (#257). */
export interface CrashRecoverableWindow {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<unknown>;
  readonly webContents: {
    isDestroyed(): boolean;
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: { reason: string }) => void,
    ): unknown;
  };
}

/**
 * Builds the BrowserWindow options with the renderer security baseline. In gate mode the preload gets
 * `--elv-gate-mode`, which is how the renderer learns that main (not just the page's query) asked for the gate.
 */
export function buildWindowOptions(
  preloadPath: string,
  opts: { gate?: boolean; bounds?: Rect; presenter?: PresenterKind } = {},
): BrowserWindowConstructorOptions {
  const additionalArguments: string[] = [];
  if (opts.gate) additionalArguments.push('--elv-gate-mode');
  if (opts.presenter !== undefined) additionalArguments.push(`--elv-presenter=${opts.presenter}`);
  return {
    title: WINDOW_TITLE,
    ...(opts.bounds
      ? {
          x: opts.bounds.x,
          y: opts.bounds.y,
          width: opts.bounds.width,
          height: opts.bounds.height,
        }
      : {
          width: 1280,
          height: 720,
        }),
    minWidth: DEFAULT_MIN_WIDTH,
    minHeight: DEFAULT_MIN_HEIGHT,
    backgroundColor: '#090A0E',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      ...(additionalArguments.length > 0 ? { additionalArguments } : {}),
    },
  };
}

/**
 * Reloads the app window when its renderer process crashes (`reason !== 'clean-exit'`), bounded to
 * `maxReloads` within `windowMs` so a startup crash loop stops cleanly. Skips gate mode completely.
 */
export function attachRendererCrashRecovery(
  window: CrashRecoverableWindow,
  opts: {
    gate: boolean;
    reloadUrl: string;
    maxReloads?: number;
    windowMs?: number;
    now?: () => number;
    log?: (line: string) => void;
  },
): void {
  if (opts.gate) return;
  const maxReloads = opts.maxReloads ?? DEFAULT_MAX_CRASH_RELOADS;
  const windowMs = opts.windowMs ?? DEFAULT_CRASH_WINDOW_MS;
  const now = opts.now ?? (() => performance.now());
  const recentReloads: number[] = [];

  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const t = now();
    while (recentReloads.length > 0 && t - (recentReloads[0] ?? 0) > windowMs) {
      recentReloads.shift();
    }
    if (recentReloads.length >= maxReloads) {
      opts.log?.(`renderer crashed repeatedly (${details.reason}); giving up recovery reload`);
      return;
    }
    recentReloads.push(t);
    void window.loadURL(opts.reloadUrl).catch(() => undefined);
  });
}
