/** Default post-touch suppression window for synthetic mouse/pointer hover events (ms). */
export const DEFAULT_TOUCH_HOVER_SUPPRESS_MS = 500;

/** Monotonic clock surface accepted by {@link createTouchHoverGuard}. */
export interface TouchHoverClock {
  now(): number;
}

/** Suppresses synthetic mouse/pointer hover events immediately following touch input (#139). */
export interface TouchHoverGuard {
  markTouch(): void;
  shouldAllowHover(pointerType?: string): boolean;
}

/**
 * Creates a pure monotonic-clock guard that rejects `'touch'` pointer events and suppresses
 * synthetic mouse-hover wake-ups for `suppressMs` (default 500 ms) after `markTouch()`.
 */
export function createTouchHoverGuard(
  clock: TouchHoverClock,
  suppressMs = DEFAULT_TOUCH_HOVER_SUPPRESS_MS,
): TouchHoverGuard {
  const windowMs = Number.isFinite(suppressMs) && suppressMs > 0 ? suppressMs : 0;
  let lastNow = Number.NEGATIVE_INFINITY;
  let lastTouchAt: number | undefined;

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
    shouldAllowHover(pointerType?: string): boolean {
      if (typeof pointerType === 'string' && pointerType.toLowerCase() === 'touch') return false;
      const now = monotonicNow();
      if (lastTouchAt === undefined) return true;
      return now - lastTouchAt >= windowMs;
    },
  };
}

function readPointerType(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as { pointerType?: unknown; nativeEvent?: { pointerType?: unknown } };
  if (typeof e.nativeEvent?.pointerType === 'string') return e.nativeEvent.pointerType;
  return typeof e.pointerType === 'string' ? e.pointerType : undefined;
}

/**
 * Builds passive RN/web root pointer/touch props that mark touch activity and forward hover moves
 * with normalized `pointerType` (returned as `Record<string, unknown>` for RN/web prop compatibility).
 */
export function buildTouchHoverProps(
  onTouch: () => void,
  onHover: (pointerType?: string) => void,
): Record<string, unknown> {
  return {
    onTouchStart: () => {
      onTouch();
    },
    onPointerMove: (event?: unknown) => {
      const pointerType = readPointerType(event);
      if (pointerType?.toLowerCase() === 'touch') onTouch();
      onHover(pointerType);
    },
    onMouseMove: (event?: unknown) => {
      onHover(readPointerType(event) ?? 'mouse');
    },
  };
}
