import {
  type ClockAnchor,
  formatLiveOffset,
  isBehindLiveEdge,
  positionAt,
  resolveLiveTimeShiftWindow,
} from '@elv/playback';
import type { PlayTarget } from '../ports/play-target';

const LIVE_TS_JUMP_LAG_MS = 15_000;

/** Optional visibility overrides for {@link shouldShowLiveJumpToLive}. */
export interface LiveJumpToLiveOptions {
  readonly jumpingToLive?: boolean;
}

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
  opts?: LiveJumpToLiveOptions,
): LiveTimeShiftSnapshot {
  const win = resolveLiveTimeShiftWindow(anchor, nowMs);
  if (win === null) {
    const showJump = shouldShowLiveJumpToLive(anchor, nowMs, isPaused, opts);
    return isPaused || showJump
      ? { ...UNSUPPORTED_SNAPSHOT, isPaused, showJumpToLive: showJump }
      : UNSUPPORTED_SNAPSHOT;
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
    showJumpToLive: opts?.jumpingToLive === true || isPaused || behind,
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
 * Returns `true` when `"Jump to live"` should appear on a live stream: ONLY when the stream
 * supports live seeking/time-shift (`resolveLiveTimeShiftWindow !== null` or raw MPEG-TS with
 * `liveEdgeMs > 15_000`) AND (`isPaused` or genuinely behind live edge or currently syncing).
 */
export function shouldShowLiveJumpToLive(
  anchor: ClockAnchor | undefined,
  nowMs: number,
  isPaused: boolean,
  opts?: LiveJumpToLiveOptions,
): boolean {
  if (anchor === undefined) return false;
  const jumping = opts?.jumpingToLive === true;
  if (resolveLiveTimeShiftWindow(anchor, nowMs) !== null) {
    return jumping || isPaused || isBehindLiveEdge(anchor, nowMs);
  }
  if (anchor.isLiveTs !== true) return false;
  const edge = anchor.liveEdgeMs;
  if (edge === undefined || !Number.isFinite(edge) || edge <= LIVE_TS_JUMP_LAG_MS) {
    return false;
  }
  if (jumping || isPaused) return true;
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
