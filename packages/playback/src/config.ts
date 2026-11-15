/** Tunable timing of the playback service; defaults follow the player core spec sections 5.4 to 5.6. */
export interface PlaybackConfig {
  /** Live buffering longer than this starts the recovery ladder. */
  liveStallWindowMs: number;
  /** No `playing` this long after a live `load` counts as a failed start; a first frame alone is not enough. */
  liveStartTimeoutMs: number;
  /** No `playing` this long after a VOD `load` counts as a failed start; a first frame alone is not enough. */
  startTimeoutMs: number;
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
}

/** Spec defaults, frozen so no caller can change them for every service. */
export const DEFAULT_PLAYBACK_CONFIG: Readonly<PlaybackConfig> = Object.freeze({
  liveStallWindowMs: 4000,
  liveStartTimeoutMs: 4000,
  startTimeoutMs: 8000,
  rungTimeoutMs: 2000,
  ladderGapsMs: Object.freeze([0, 1000, 2000, 4000] as const),
  stableRestoreMs: 30000,
  limitBackoffMs: Object.freeze([2000, 4000, 8000, 15000]),
  limitTotalMs: 60000,
  vodReconnectWindowMs: 120000,
  resolveTimeoutMs: 5000,
});
