import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Rectangle in screen DIP coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Minimal connected display descriptor matching Electron's `Display.workArea`. */
export interface DisplayWorkArea {
  readonly workArea: Rect;
}

/** Persisted desktop main window geometry (`userData/window-state.json`, `#408`). */
export interface PersistedWindowState {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
}

/** Fallback sizing limits for {@link clampWindowBounds}. */
export interface WindowBoundsDefaults {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/** Minimal Electron `BrowserWindow` surface used by {@link createWindowBoundsController}. */
export interface BoundsWindowLike {
  getBounds(): Rect;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isMinimized(): boolean;
  isDestroyed(): boolean;
  on(event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'close', listener: () => void): unknown;
  removeListener(
    event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'close',
    listener: () => void,
  ): unknown;
}

/** Minimal Electron `screen` surface used by {@link createWindowBoundsController}. */
export interface BoundsScreenLike {
  getAllDisplays(): readonly DisplayWorkArea[];
  getPrimaryDisplay?(): DisplayWorkArea;
}

/** Handle returned by {@link createWindowBoundsController}. */
export interface WindowBoundsController {
  /** Immediately writes any pending state change to disk. */
  flush(): void;
  /** Flushes pending state and detaches all window listeners. */
  dispose(): void;
  /** Returns the latest tracked window state. */
  getState(): PersistedWindowState;
}

const DEFAULT_BOUNDS: WindowBoundsDefaults = {
  width: 1280,
  height: 720,
  minWidth: 800,
  minHeight: 500,
};

const DEFAULT_DEBOUNCE_MS = 500;
const MAX_STATE_FILE_BYTES = 16 * 1024;

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

const isValidWorkArea = (rect: Rect | undefined): rect is Rect =>
  rect !== undefined &&
  isFiniteNum(rect.x) &&
  isFiniteNum(rect.y) &&
  isFiniteNum(rect.width) &&
  isFiniteNum(rect.height) &&
  rect.width > 0 &&
  rect.height > 0;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function intersectionArea(a: Rect, b: Rect): number {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapX * overlapY;
}

function resolveDefaults(defaults?: Partial<WindowBoundsDefaults>): WindowBoundsDefaults {
  return {
    width: defaults?.width ?? DEFAULT_BOUNDS.width,
    height: defaults?.height ?? DEFAULT_BOUNDS.height,
    minWidth: defaults?.minWidth ?? DEFAULT_BOUNDS.minWidth,
    minHeight: defaults?.minHeight ?? DEFAULT_BOUNDS.minHeight,
  };
}

function centerOnWorkArea(
  workArea: Rect,
  defs: WindowBoundsDefaults,
  isMaximized: boolean,
): PersistedWindowState {
  const minW = Math.min(defs.minWidth, workArea.width);
  const minH = Math.min(defs.minHeight, workArea.height);
  const width = Math.round(clamp(defs.width, minW, workArea.width));
  const height = Math.round(clamp(defs.height, minH, workArea.height));
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  return { x, y, width, height, isMaximized };
}

/**
 * Validates and clamps a saved window state strictly inside a connected display's `workArea`.
 * Picks the display with the largest intersection area, falling back to the primary/first display
 * when disconnected or off-screen so the window never opens off-screen (`#408`).
 */
export function clampWindowBounds(
  saved: Partial<PersistedWindowState> | null | undefined,
  displays: readonly DisplayWorkArea[],
  defaults: Partial<WindowBoundsDefaults> = DEFAULT_BOUNDS,
): PersistedWindowState {
  const defs = resolveDefaults(defaults);
  const isMaximized = typeof saved?.isMaximized === 'boolean' ? saved.isMaximized : false;
  const validDisplays = displays.filter((d) => isValidWorkArea(d?.workArea));

  if (validDisplays.length === 0) {
    return {
      x: 0,
      y: 0,
      width: Math.round(Math.max(defs.minWidth, defs.width)),
      height: Math.round(Math.max(defs.minHeight, defs.height)),
      isMaximized,
    };
  }

  const primary = validDisplays[0] as DisplayWorkArea;
  const hasSavedRect =
    saved !== null &&
    saved !== undefined &&
    isFiniteNum(saved.x) &&
    isFiniteNum(saved.y) &&
    isFiniteNum(saved.width) &&
    isFiniteNum(saved.height) &&
    saved.width > 0 &&
    saved.height > 0;

  if (!hasSavedRect) {
    return centerOnWorkArea(primary.workArea, defs, isMaximized);
  }

  const savedRect: Rect = {
    x: saved.x as number,
    y: saved.y as number,
    width: saved.width as number,
    height: saved.height as number,
  };

  let target = primary;
  let bestArea = 0;
  for (const display of validDisplays) {
    const area = intersectionArea(savedRect, display.workArea);
    if (area > bestArea) {
      bestArea = area;
      target = display;
    }
  }

  const wa = target.workArea;
  const minW = Math.min(defs.minWidth, wa.width);
  const minH = Math.min(defs.minHeight, wa.height);
  const width = Math.round(clamp(savedRect.width, minW, wa.width));
  const height = Math.round(clamp(savedRect.height, minH, wa.height));
  const maxX = wa.x + wa.width - width;
  const maxY = wa.y + wa.height - height;
  const x = Math.round(clamp(savedRect.x, wa.x, maxX));
  const y = Math.round(clamp(savedRect.y, wa.y, maxY));

  return { x, y, width, height, isMaximized };
}

/** Collects connected displays with the primary display ordered first for deterministic fallback. */
export function orderedDisplays(screen: BoundsScreenLike): readonly DisplayWorkArea[] {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay?.();
  if (!primary) return all;
  const rest = all.filter(
    (d) =>
      d !== primary &&
      (d.workArea.x !== primary.workArea.x ||
        d.workArea.y !== primary.workArea.y ||
        d.workArea.width !== primary.workArea.width ||
        d.workArea.height !== primary.workArea.height),
  );
  return [primary, ...rest];
}

function parseSavedState(raw: string): Partial<PersistedWindowState> | null {
  if (raw.length === 0 || raw.length > MAX_STATE_FILE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (
    !isFiniteNum(rec['x']) ||
    !isFiniteNum(rec['y']) ||
    !isFiniteNum(rec['width']) ||
    !isFiniteNum(rec['height']) ||
    (rec['width'] as number) <= 0 ||
    (rec['height'] as number) <= 0
  ) {
    return null;
  }
  return {
    x: rec['x'] as number,
    y: rec['y'] as number,
    width: rec['width'] as number,
    height: rec['height'] as number,
    isMaximized: typeof rec['isMaximized'] === 'boolean' ? (rec['isMaximized'] as boolean) : false,
  };
}

/** Loads persisted window bounds from `filePath`, clamping to `displays` and falling back on missing/corrupt JSON. */
export function loadWindowState(
  filePath: string,
  displays: readonly DisplayWorkArea[],
  defaults?: Partial<WindowBoundsDefaults>,
): PersistedWindowState {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return clampWindowBounds(parseSavedState(raw), displays, defaults);
  } catch {
    return clampWindowBounds(null, displays, defaults);
  }
}

function writeAtomicJson(filePath: string, state: PersistedWindowState): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(state), 'utf8');
    renameSync(tmpPath, filePath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * Tracks a window's normal (unmaximized, non-fullscreen, non-minimized) bounds and persists
 * `{ x, y, width, height, isMaximized }` atomically with a 500 ms debounce plus immediate flush on close.
 */
export function createWindowBoundsController(
  window: BoundsWindowLike,
  filePath: string,
  screen: BoundsScreenLike,
  opts?: {
    debounceMs?: number;
    initialState?: PersistedWindowState;
  },
): WindowBoundsController {
  const debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const fallback = opts?.initialState ?? clampWindowBounds(null, orderedDisplays(screen));
  let lastNormalBounds: Rect = {
    x: fallback.x,
    y: fallback.y,
    width: fallback.width,
    height: fallback.height,
  };
  let isMaximized = fallback.isMaximized;
  let dirty = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const isNormal = (): boolean =>
    !window.isDestroyed() &&
    !window.isMaximized() &&
    !window.isFullScreen() &&
    !window.isMinimized();

  if (opts?.initialState === undefined && isNormal()) {
    const current = window.getBounds();
    if (isValidWorkArea(current)) {
      lastNormalBounds = {
        x: Math.round(current.x),
        y: Math.round(current.y),
        width: Math.round(current.width),
        height: Math.round(current.height),
      };
    }
  }

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const currentState = (): PersistedWindowState => ({
    x: lastNormalBounds.x,
    y: lastNormalBounds.y,
    width: lastNormalBounds.width,
    height: lastNormalBounds.height,
    isMaximized,
  });

  const flush = (): void => {
    clearTimer();
    if (!dirty) return;
    dirty = false;
    writeAtomicJson(filePath, currentState());
  };

  const scheduleWrite = (): void => {
    if (disposed) return;
    dirty = true;
    clearTimer();
    timer = setTimeout(flush, debounceMs);
  };

  const captureNormalBounds = (): void => {
    if (!isNormal()) return;
    const next = window.getBounds();
    if (!isValidWorkArea(next)) return;
    lastNormalBounds = {
      x: Math.round(next.x),
      y: Math.round(next.y),
      width: Math.round(next.width),
      height: Math.round(next.height),
    };
    isMaximized = false;
    scheduleWrite();
  };

  const onMaximize = (): void => {
    if (window.isDestroyed()) return;
    isMaximized = true;
    scheduleWrite();
  };

  const onUnmaximize = (): void => {
    if (window.isDestroyed()) return;
    isMaximized = false;
    if (isNormal()) {
      const next = window.getBounds();
      if (isValidWorkArea(next)) {
        lastNormalBounds = {
          x: Math.round(next.x),
          y: Math.round(next.y),
          width: Math.round(next.width),
          height: Math.round(next.height),
        };
      }
    }
    scheduleWrite();
  };

  const onClose = (): void => {
    flush();
  };

  window.on('resize', captureNormalBounds);
  window.on('move', captureNormalBounds);
  window.on('maximize', onMaximize);
  window.on('unmaximize', onUnmaximize);
  window.on('close', onClose);

  return {
    flush,
    getState: currentState,
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      if (!window.isDestroyed()) {
        window.removeListener('resize', captureNormalBounds);
        window.removeListener('move', captureNormalBounds);
        window.removeListener('maximize', onMaximize);
        window.removeListener('unmaximize', onUnmaximize);
        window.removeListener('close', onClose);
      }
    },
  };
}
