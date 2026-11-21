import type { ClockAnchor } from './engine';
import type { PlaybackClock } from './types';

/** Default grace window (ms) behind `liveEdgeMs` that still counts as live (`#284`). */
export const LIVE_EDGE_TOLERANCE_MS = 5_000;

function readSystemMonotonicMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/**
 * Creates a strictly non-decreasing {@link PlaybackClock} defaulting to `performance.now()`
 * (falling back safely to `Date.now()` when absent) with a monotonic floor guard against
 * backwards wall-clock jumps (`#159`).
 */
export function createMonotonicClock(nowFn?: () => number): PlaybackClock {
  const source = nowFn ?? readSystemMonotonicMs;
  let floor: number | undefined;
  return {
    now(): number {
      const sample = source();
      if (!Number.isFinite(sample)) return floor ?? 0;
      if (floor === undefined || sample > floor) floor = sample;
      return floor;
    },
  };
}

/** Extrapolates the playback position at `nowMs`, clamped to `[0, durationMs]`. */
export function positionAt(anchor: ClockAnchor, nowMs: number): number {
  const raw = anchor.positionMs + (nowMs - anchor.atMs) * anchor.rate;
  const capped = anchor.durationMs === undefined ? raw : Math.min(raw, anchor.durationMs);
  return Math.max(0, capped);
}

/**
 * Returns whether `anchor` is within `toleranceMs` of `liveEdgeMs` at `nowMs`.
 * Unbounded live anchors (`liveEdgeMs === undefined`) count as at the live edge.
 */
export function isAtLiveEdge(
  anchor: ClockAnchor | undefined,
  nowMs: number,
  toleranceMs = LIVE_EDGE_TOLERANCE_MS,
): boolean {
  if (anchor === undefined) return false;
  if (anchor.liveEdgeMs === undefined) return true;
  const pos = positionAt(anchor, nowMs);
  const lag = anchor.liveEdgeMs - pos;
  return Number.isFinite(lag) && lag <= Math.max(0, toleranceMs);
}
