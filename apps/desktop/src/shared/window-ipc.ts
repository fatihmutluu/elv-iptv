import type { PopoutDockPayload, PopoutLaunchPayload } from './popout-ipc.ts';

export {
  isPopoutDockPayload,
  isPopoutLaunchPayload,
  type PopoutDockPayload,
  type PopoutLaunchPayload,
  sanitizePopoutDockPayload,
  sanitizePopoutLaunchPayload,
} from './popout-ipc.ts';

/** IPC channels exposed by main for desktop window, tray, and popout controls (`#408`, `#332`, `#158`). */
export const WINDOW_CHANNELS = Object.freeze({
  setAlwaysOnTop: 'window:set-always-on-top',
  getAlwaysOnTop: 'window:get-always-on-top',
  alwaysOnTopChanged: 'window:always-on-top-changed',
  setAspectRatioLock: 'window:set-aspect-ratio-lock',
  setMinimizeToTray: 'window:set-minimize-to-tray',
  windowRestored: 'window:restored',
  hiddenToTray: 'window:hidden-to-tray',
  openPopout: 'window:open-popout',
  closePopout: 'window:close-popout',
  getPopoutPayload: 'window:get-popout-payload',
  popoutPayload: 'window:popout-payload',
  dockPopout: 'window:dock-popout',
  popoutDocked: 'window:popout-docked',
  openExternalUrl: 'window:open-external-url',
  getZoomLevel: 'window:get-zoom-level',
  setZoomLevel: 'window:set-zoom-level',
  zoomLevelChanged: 'window:zoom-level-changed',
} as const);

/** Minimum persisted desktop UI zoom level (Electron `webContents.setZoomLevel` units). */
export const MIN_WINDOW_ZOOM_LEVEL = -3;

/** Maximum persisted desktop UI zoom level (Electron `webContents.setZoomLevel` units). */
export const MAX_WINDOW_ZOOM_LEVEL = 4;

/** Discrete step applied by `Ctrl/Cmd +` and `Ctrl/Cmd -` desktop zoom shortcuts. */
export const ZOOM_LEVEL_STEP = 0.5;

/** Clamps a finite zoom level into `[-3, 4]` rounded to the nearest `0.5` step (non-finite -> `0`). */
export function clampZoomLevel(level: number): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 0;
  const clamped = Math.min(MAX_WINDOW_ZOOM_LEVEL, Math.max(MIN_WINDOW_ZOOM_LEVEL, level));
  const stepped = Math.round(clamped / ZOOM_LEVEL_STEP) * ZOOM_LEVEL_STEP;
  return stepped === 0 ? 0 : stepped;
}

/** Validates a finite zoom level payload within `[MIN_WINDOW_ZOOM_LEVEL, MAX_WINDOW_ZOOM_LEVEL]`. */
export function isZoomLevel(x: unknown): x is number {
  return (
    typeof x === 'number' &&
    Number.isFinite(x) &&
    x >= MIN_WINDOW_ZOOM_LEVEL &&
    x <= MAX_WINDOW_ZOOM_LEVEL
  );
}

/** Localized context menu labels for the desktop system tray (`#158`). */
export interface TrayLabels {
  readonly restore: string;
  readonly quit: string;
}

const MAX_TRAY_LABEL_LENGTH = 128;

function isBoundedTrayLabel(x: unknown): x is string {
  if (typeof x !== 'string') return false;
  const trimmed = x.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TRAY_LABEL_LENGTH) return false;
  return !/[\r\n\0]/.test(trimmed);
}

/** Validates the optional localized tray labels sent over `window:set-minimize-to-tray` (`#158`). */
export function isTrayLabels(x: unknown): x is TrayLabels {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const record = x as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.every((k) => k === 'restore' || k === 'quit')) return false;
  return isBoundedTrayLabel(record.restore) && isBoundedTrayLabel(record.quit);
}

/** Returns a trimmed copy of validated {@link TrayLabels}. */
export function sanitizeTrayLabels(labels: TrayLabels): TrayLabels {
  return {
    restore: labels.restore.trim(),
    quit: labels.quit.trim(),
  };
}

/** Frozen `window.elv.window` bridge exposed by the Electron preload (`#408`, `#332`, `#158`). */
export interface WindowBridge {
  setAlwaysOnTop(enabled: boolean): Promise<boolean>;
  getAlwaysOnTop(): Promise<boolean>;
  onAlwaysOnTopChanged(listener: (enabled: boolean) => void): () => void;
  setAspectRatioLock(enabled: boolean): Promise<boolean>;
  setMinimizeToTray(enabled: boolean, labels?: TrayLabels): Promise<boolean>;
  openPopout(payload: PopoutLaunchPayload): Promise<boolean>;
  closePopout(): Promise<void>;
  getPopoutPayload(): Promise<PopoutLaunchPayload | null>;
  onPopoutPayload(listener: (payload: PopoutLaunchPayload) => void): () => void;
  dockPopout(payload: PopoutDockPayload): Promise<void>;
  onPopoutDocked(listener: (payload: PopoutDockPayload) => void): () => void;
  onWindowRestored(listener: () => void): () => void;
  onHiddenToTray(listener: () => void): () => void;
  openExternalUrl?(url: string): Promise<boolean>;
  getZoomLevel?(): Promise<number>;
  setZoomLevel?(level: number): Promise<number>;
  onZoomLevelChanged?(listener: (level: number) => void): () => void;
}

const ALLOWED_EXTERNAL_TRAILER_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

/** Validates that a requested external URL is a clean HTTPS YouTube URL without credentials or custom ports (`#512`). */
export function isAllowedExternalTrailerUrl(x: unknown): x is string {
  if (typeof x !== 'string') return false;
  const trimmed = x.trim();
  if (trimmed.length === 0 || trimmed.length > 512 || /[\s\0]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      ALLOWED_EXTERNAL_TRAILER_HOSTS.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Validates the boolean payload sent over `window:set-always-on-top` and `window:always-on-top-changed`. */
export function isAlwaysOnTopFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

/** Validates the boolean payload sent over `window:set-aspect-ratio-lock` (`#332`). */
export function isAspectRatioLockFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

/** Validates the boolean payload sent over `window:set-minimize-to-tray` (`#158`). */
export function isMinimizeToTrayFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}
