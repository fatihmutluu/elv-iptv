import { positionAt } from './clock';
import type { ClockAnchor } from './engine';

/** Default behind-live threshold (ms) above which a live stream is considered behind the live edge (`#28`). */
export const DEFAULT_LIVE_BEHIND_THRESHOLD_MS = 12_000;

const LIVE_TS_EDGE_MARGIN_MS = 1_000;
const LIVE_TS_AT_EDGE_WINDOW_MS = 15_000;

/** Resolved bounded live time-shift window in milliseconds (`#28`). */
export interface LiveTimeShiftWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly spanMs: number;
  readonly positionMs: number;
  readonly behindLiveMs: number;
}

const nonNegativeFinite = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Resolves the active bounded live time-shift window from `anchor` at `nowMs`, or returns `null`
 * when time-shift seeking is disabled or bounds are absent/invalid (`#28`).
 */
export function resolveLiveTimeShiftWindow(
  anchor: ClockAnchor | undefined,
  nowMs: number,
): LiveTimeShiftWindow | null {
  if (anchor === undefined || anchor.timeShiftSupported === false) return null;
  const endMs = nonNegativeFinite(anchor.liveEdgeMs);
  if (endMs === undefined || endMs <= 0) return null;

  let startMs: number | undefined;
  if (anchor.liveSeekableStartMs !== undefined) {
    startMs = nonNegativeFinite(anchor.liveSeekableStartMs);
    if (startMs === undefined) return null;
  } else if (anchor.timeShiftSupported === true) {
    startMs = 0;
  } else {
    return null;
  }

  if (endMs <= startMs) return null;

  const rawPos = positionAt(anchor, nowMs);
  const clampedPos = Math.min(endMs, Math.max(startMs, rawPos));
  const behindLiveMs = Math.max(0, endMs - clampedPos);
  return {
    startMs,
    endMs,
    spanMs: endMs - startMs,
    positionMs: clampedPos,
    behindLiveMs,
  };
}

/**
 * Clamps a live time-shift seek target strictly inside `[liveSeekableStartMs, liveEdgeMs]`,
 * returning `undefined` when `targetMs` is non-finite or no valid live time-shift window exists (`#28`).
 */
export function clampLiveSeekPosition(
  anchor: ClockAnchor | undefined,
  targetMs: number,
  nowMs?: number,
): number | undefined {
  if (!Number.isFinite(targetMs)) return undefined;
  const window = resolveLiveTimeShiftWindow(anchor, nowMs ?? anchor?.atMs ?? 0);
  if (window === null) return undefined;
  return Math.min(window.endMs, Math.max(window.startMs, targetMs));
}

/**
 * Returns `true` when `anchor` has a finite `liveEdgeMs` and its extrapolated playback position
 * at `nowMs` trails `liveEdgeMs` by strictly more than `thresholdMs` (default `12_000 ms`, `#28`).
 */
export function isBehindLiveEdge(
  anchor: ClockAnchor | undefined,
  nowMs: number,
  thresholdMs = DEFAULT_LIVE_BEHIND_THRESHOLD_MS,
): boolean {
  if (anchor === undefined) return false;
  const liveEdgeMs = nonNegativeFinite(anchor.liveEdgeMs);
  if (liveEdgeMs === undefined) return false;
  const pos = positionAt(anchor, nowMs);
  const behindMs = liveEdgeMs - pos;
  const safeThreshold = Number.isFinite(thresholdMs) ? Math.max(0, thresholdMs) : 0;
  return Number.isFinite(behindMs) && behindMs > safeThreshold;
}

/**
 * Resolves the target position for `jumpToLiveEdge`, returning `undefined` when the stream is not
 * eligible (non-seekable, insufficient live buffer, or already within live-edge threshold while playing).
 */
export function resolveJumpToLiveTarget(
  anchor: ClockAnchor | undefined,
  nowMs: number,
  wasPaused: boolean,
): { readonly targetMs: number; readonly liveEdgeMs: number } | undefined {
  if (anchor === undefined) return undefined;
  const liveEdgeMs = nonNegativeFinite(anchor.liveEdgeMs);
  if (liveEdgeMs === undefined) return undefined;
  if (resolveLiveTimeShiftWindow(anchor, nowMs) !== null) {
    if (!wasPaused && !isBehindLiveEdge(anchor, nowMs)) return undefined;
    return { targetMs: liveEdgeMs, liveEdgeMs };
  }
  if (anchor.isLiveTs !== true || liveEdgeMs <= LIVE_TS_AT_EDGE_WINDOW_MS) return undefined;
  const currentPos = positionAt(anchor, nowMs);
  if (
    !wasPaused &&
    (!Number.isFinite(currentPos) || liveEdgeMs - currentPos <= LIVE_TS_AT_EDGE_WINDOW_MS)
  ) {
    return undefined;
  }
  return { targetMs: Math.max(0, liveEdgeMs - LIVE_TS_EDGE_MARGIN_MS), liveEdgeMs };
}

/**
 * Formats a behind-live duration in milliseconds as a negative clock offset string such as
 * `"-02:14"` or `"-1:05:09"` (`#28`).
 */
export function formatLiveOffset(behindMs: number): string {
  const totalSeconds = Number.isFinite(behindMs) && behindMs > 0 ? Math.floor(behindMs / 1_000) : 0;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `-${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `-${pad(minutes)}:${pad(seconds)}`;
}
