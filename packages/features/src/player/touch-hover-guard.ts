/** Default post-touch suppression window for synthetic mouse/pointer hover events (ms). */
export const DEFAULT_TOUCH_HOVER_SUPPRESS_MS = 500;

/** Default minimum pointer travel (px) required before hover activity wakes a hidden OSD (#421). */
export const DEFAULT_POINTER_DEADZONE_PX = 10;

/** Monotonic clock surface accepted by {@link createTouchHoverGuard}. */
export interface TouchHoverClock {
  now(): number;
}

/** Pointer coordinate pair extracted from mouse/pointer move events. */
export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/** Suppresses synthetic mouse/pointer hover events immediately following touch input (#139) and pointer jitter (#421). */
export interface TouchHoverGuard {
  markTouch(): void;
  shouldAllowHover(pointerType?: string, point?: PointerPoint): boolean;
}

/**
 * Creates a pure monotonic-clock guard that rejects `'touch'` pointer events, suppresses
 * synthetic mouse-hover wake-ups for `suppressMs` (default 500 ms) after `markTouch()`, and
 * ignores pointer micro-jitter under `deadzonePx` (default 10 px) relative to the last accepted point.
 */
export function createTouchHoverGuard(
  clock: TouchHoverClock,
  suppressMs = DEFAULT_TOUCH_HOVER_SUPPRESS_MS,
  deadzonePx = DEFAULT_POINTER_DEADZONE_PX,
): TouchHoverGuard {
  const windowMs = Number.isFinite(suppressMs) && suppressMs > 0 ? suppressMs : 0;
  const minMovePx = Number.isFinite(deadzonePx) && deadzonePx > 0 ? deadzonePx : 0;
  let lastNow = Number.NEGATIVE_INFINITY;
  let lastTouchAt: number | undefined;
  let lastPointer: PointerPoint | null = null;

  const monotonicNow = (): number => {
    const raw = clock.now();
    const safe = Number.isFinite(raw) ? raw : lastNow === Number.NEGATIVE_INFINITY ? 0 : lastNow;
    if (safe > lastNow) lastNow = safe;
    return lastNow;
  };

  return {
    markTouch(): void {
      lastTouchAt = monotonicNow();
    },
    shouldAllowHover(pointerType?: string, point?: PointerPoint): boolean {
      if (typeof pointerType === 'string' && pointerType.toLowerCase() === 'touch') return false;
      const now = monotonicNow();
      if (lastTouchAt !== undefined && now - lastTouchAt < windowMs) return false;
      if (
        minMovePx > 0 &&
        point !== undefined &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
      ) {
        if (lastPointer === null) {
          lastPointer = { x: point.x, y: point.y };
          return true;
        }
        if (Math.hypot(point.x - lastPointer.x, point.y - lastPointer.y) < minMovePx) {
          return false;
        }
        lastPointer = { x: point.x, y: point.y };
      }
      return true;
    },
  };
}

function readPointerType(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as { pointerType?: unknown; nativeEvent?: { pointerType?: unknown } };
  if (typeof e.nativeEvent?.pointerType === 'string') return e.nativeEvent.pointerType;
  return typeof e.pointerType === 'string' ? e.pointerType : undefined;
}

function readPointerPoint(event: unknown): PointerPoint | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as {
    clientX?: unknown;
    clientY?: unknown;
    nativeEvent?: { clientX?: unknown; clientY?: unknown };
  };
  const x = typeof e.nativeEvent?.clientX === 'number' ? e.nativeEvent.clientX : e.clientX;
  const y = typeof e.nativeEvent?.clientY === 'number' ? e.nativeEvent.clientY : e.clientY;
  if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
    return { x, y };
  }
  return undefined;
}

/**
 * Builds passive RN/web root pointer/touch props that mark touch activity and forward hover moves
 * with normalized `pointerType` and optional pointer coordinates.
 */
export function buildTouchHoverProps(
  onTouch: () => void,
  onHover: (pointerType?: string, point?: PointerPoint) => void,
): Record<string, unknown> {
  const emitHover = (pointerType: string | undefined, event: unknown): void => {
    const point = readPointerPoint(event);
    if (point !== undefined) onHover(pointerType, point);
    else onHover(pointerType);
  };
  return {
    onTouchStart: () => {
      onTouch();
    },
    onPointerMove: (event?: unknown) => {
      const pointerType = readPointerType(event);
      if (pointerType?.toLowerCase() === 'touch') onTouch();
      emitHover(pointerType, event);
    },
    onMouseMove: (event?: unknown) => {
      emitHover(readPointerType(event) ?? 'mouse', event);
    },
  };
}
