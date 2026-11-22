import { LIVE_EDGE_TOLERANCE_MS } from './clock';

/** Tunable timing of the playback service; defaults follow the player core spec sections 5.4 to 5.6. */
export interface PlaybackConfig {
  /** Live buffering longer than this starts the recovery ladder. */
  liveStallWindowMs: number;
  /** No `playing` this long after a live `load` counts as a failed start; a first frame alone is not enough. */
  liveStartTimeoutMs: number;
  /** No `playing` this long after a VOD `load` counts as a failed start; a first frame alone is not enough. */
  startTimeoutMs: number;
  /** Hard ceiling for VOD start timeout extensions while transfer progress keeps arriving (`#314`). */
  vodStartMaxTimeoutMs: number;
  /** Advancing video playback with zero decoded frames for this long triggers decoder recovery (`#321`). */
  zeroFrameWindowMs: number;
  /** Maximum mid-stream stall window deferrals while network progress is actively arriving (`#321`). */
  maxStallDeferrals: number;
  /** Time each recovery rung gets to reach `playing`. */
  rungTimeoutMs: number;
  /** Waits before rungs 1 to 4 on fast-failing errors; silent timeouts escalate immediately. */
  ladderGapsMs: readonly [number, number, number, number];
  /** Playing this long without trouble restores a full recovery budget. */
  stableRestoreMs: number;
  /** Waits between connection-limit attempts. */
  limitBackoffMs: readonly number[];
  /** Total time spent on connection-limit attempts before giving up. */
  limitTotalMs: number;
  /** VOD reconnect attempts stop after this window. */
  vodReconnectWindowMs: number;
  /**
   * A tune whose `resolve` has not settled after this long fails with `network`/`timeout` instead of staying in
   * `tuning`. Resolving is local work (a stored template and a secret-store read), so the bound only catches a hang.
   */
  resolveTimeoutMs: number;
  /** Coalescing window for rapid `service.seek()` calls after an immediate leading dispatch. */
  seekCoalesceMs: number;
  /** Maximum settle window after a seek before a still-stalled stream escalates into recovery. */
  seekSettleTimeoutMs: number;
  /** Pausing a playing live stream at least this long triggers a clean live-edge reload on `play()`. */
  liveStalePauseMs: number;
  /** Grace window behind `liveEdgeMs` that still reports `atLiveEdge: true` (`#284`). */
  liveEdgeToleranceMs: number;
}

/** Spec defaults, frozen so no caller can change them for every service. */
export const DEFAULT_PLAYBACK_CONFIG: Readonly<PlaybackConfig> = Object.freeze({
  liveStallWindowMs: 4000,
  liveStartTimeoutMs: 5000,
  startTimeoutMs: 8000,
  vodStartMaxTimeoutMs: 30000,
  zeroFrameWindowMs: 4000,
  maxStallDeferrals: 3,
  rungTimeoutMs: 2000,
  ladderGapsMs: Object.freeze([0, 1000, 2000, 4000] as const),
  stableRestoreMs: 30000,
  limitBackoffMs: Object.freeze([2000, 4000, 8000, 15000]),
  limitTotalMs: 60000,
  vodReconnectWindowMs: 120000,
  resolveTimeoutMs: 5000,
  seekCoalesceMs: 80,
  seekSettleTimeoutMs: 12000,
  liveStalePauseMs: 20000,
  liveEdgeToleranceMs: LIVE_EDGE_TOLERANCE_MS,
});
