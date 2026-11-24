import {
  type ClockAnchor,
  formatLiveOffset,
  isBehindLiveEdge,
  positionAt,
  resolveLiveTimeShiftWindow,
} from '@elv/playback';
import type { PlayTarget } from '../ports/play-target';

const LIVE_TS_JUMP_MIN_EDGE_MS = 3_000;
const LIVE_TS_JUMP_LAG_MS = 4_000;

/** View-model snapshot for the Cinema Quietude bounded live time-shift bar (`#28`). */
export interface LiveTimeShiftSnapshot {
  readonly supported: boolean;
  readonly startMs: number;
  readonly endMs: number;
  readonly spanMs: number;
  readonly positionMs: number;
  readonly behindLiveMs: number;
  readonly fillPercent: number;
  readonly isPaused: boolean;
  readonly isBehindLive: boolean;
  readonly offsetText: string;
  readonly showJumpToLive: boolean;
}

const UNSUPPORTED_SNAPSHOT: LiveTimeShiftSnapshot = {
  supported: false,
  startMs: 0,
  endMs: 0,
  spanMs: 0,
  positionMs: 0,
  behindLiveMs: 0,
  fillPercent: 100,
  isPaused: false,
  isBehindLive: false,
  offsetText: '-00:00',
  showJumpToLive: false,
};

/**
 * Derives a bounded live time-shift snapshot from `anchor` at `nowMs` (`#28`).
 * Returns `supported: false` when live time-shift seeking is unavailable or bounds are invalid.
 */
export function readLiveTimeShiftSnapshot(
  anchor: ClockAnchor | undefined,
  nowMs: number,
  isPaused: boolean,
): LiveTimeShiftSnapshot {
  const win = resolveLiveTimeShiftWindow(anchor, nowMs);
  if (win === null) {
    return isPaused ? { ...UNSUPPORTED_SNAPSHOT, isPaused: true } : UNSUPPORTED_SNAPSHOT;
  }
  const rawRatio = win.spanMs > 0 ? (win.positionMs - win.startMs) / win.spanMs : 1;
  const fillPercent = Math.round(Math.max(0, Math.min(1, rawRatio)) * 1000) / 10;
  const behind = isBehindLiveEdge(anchor, nowMs);
  return {
    supported: true,
    startMs: win.startMs,
    endMs: win.endMs,
    spanMs: win.spanMs,
    positionMs: win.positionMs,
    behindLiveMs: win.behindLiveMs,
    fillPercent,
    isPaused,
    isBehindLive: behind,
    offsetText: formatLiveOffset(win.behindLiveMs),
    showJumpToLive: isPaused || behind,
  };
}

/** Structural equality check for {@link LiveTimeShiftSnapshot} inside `usePlaybackTicker`. */
export function sameLiveTimeShiftSnapshot(
  a: LiveTimeShiftSnapshot,
  b: LiveTimeShiftSnapshot,
): boolean {
  return (
    a.supported === b.supported &&
    a.fillPercent === b.fillPercent &&
    a.isPaused === b.isPaused &&
    a.isBehindLive === b.isBehindLive &&
    a.offsetText === b.offsetText &&
    a.showJumpToLive === b.showJumpToLive
  );
}

/** Maps a normalized `[0, 1]` scrubber ratio into `[startMs, endMs]` of the active live window. */
export function computeLiveTimeShiftTargetMs(
  anchor: ClockAnchor | undefined,
  nowMs: number,
  ratio: number,
): number | undefined {
  if (!Number.isFinite(ratio)) return undefined;
  const win = resolveLiveTimeShiftWindow(anchor, nowMs);
  if (win === null) return undefined;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(win.startMs + clamped * win.spanMs);
}

/**
 * Returns `true` when `"Jump to live"` should appear on a live stream: either bounded time-shift
 * is active while paused / behind live edge (`#28`), or a raw MPEG-TS stream lags > 4 s (`#141`).
 */
export function shouldShowLiveJumpToLive(
  anchor: ClockAnchor | undefined,
  nowMs: number,
  isPaused: boolean,
): boolean {
  if (anchor === undefined) return false;
  if (resolveLiveTimeShiftWindow(anchor, nowMs) !== null) {
    return isPaused || isBehindLiveEdge(anchor, nowMs);
  }
  if (anchor.isLiveTs !== true) return false;
  const edge = anchor.liveEdgeMs;
  if (edge === undefined || !Number.isFinite(edge) || edge <= LIVE_TS_JUMP_MIN_EDGE_MS) {
    return false;
  }
  const pos = positionAt(anchor, nowMs);
  return Number.isFinite(pos) && edge - pos > LIVE_TS_JUMP_LAG_MS;
}

/** Stable identity key distinguishing catch-up archive playback from live playback of the same channel. */
export function targetIdentityKey(
  target: Pick<PlayTarget, 'itemKey' | 'kind' | 'catchup'>,
): string {
  return target.catchup !== undefined
    ? `${target.itemKey}|catchup:${target.catchup.startMs}`
    : `${target.itemKey}|${target.kind}`;
}
