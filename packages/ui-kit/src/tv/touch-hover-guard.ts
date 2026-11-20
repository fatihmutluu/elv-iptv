/** Suppresses synthetic mouse hover events synthesized shortly after touch input on hybrid devices (#139). */
export interface TouchHoverGuard {
  /** Records the timestamp (ms) of a recent touch interaction. */
  recordTouch(nowMs: number): void;
  /** Returns `true` while `nowMs` falls within the post-touch hover suppression window. */
  shouldIgnoreHover(nowMs: number): boolean;
  /** Clears any recorded touch timestamp. */
  reset(): void;
}

/**
 * Creates a pure timestamp-based guard that ignores synthetic hover events for `windowMs` milliseconds after a touch.
 * Non-monotonic timestamps (`nowMs < lastTouchMs`) reset the guard and return `false`; `windowMs <= 0` disables
 * suppression and always returns `false`.
 */
export function createTouchHoverGuard(windowMs = 600): TouchHoverGuard {
  const effectiveWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;
  let lastTouchMs: number | null = null;

  return {
    recordTouch(nowMs) {
      if (!Number.isFinite(nowMs)) return;
      lastTouchMs = nowMs;
    },
    shouldIgnoreHover(nowMs) {
      if (effectiveWindowMs === 0 || lastTouchMs === null || !Number.isFinite(nowMs)) {
        return false;
      }
      if (nowMs < lastTouchMs) {
        lastTouchMs = null;
        return false;
      }
      if (nowMs - lastTouchMs < effectiveWindowMs) {
        return true;
      }
      lastTouchMs = null;
      return false;
    },
    reset() {
      lastTouchMs = null;
    },
  };
}
