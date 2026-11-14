/** Tunable timing of the playback service; defaults follow the player core spec sections 5.4 to 5.6. */
export interface PlaybackConfig {
  /** Live buffering longer than this starts the recovery ladder. */
  liveStallWindowMs: number;
  /** No first frame this long after `load` counts as a failed start. */
  startTimeoutMs: number;
  /** Time each recovery rung gets to produce a frame. */
  rungTimeoutMs: number;
  /** Waits before rungs 1 to 4. */
  ladderGapsMs: readonly [number, number, number, number];
  /** Playing this long without trouble restores a full recovery budget. */
  stableRestoreMs: number;
  /** Waits between connection-limit attempts. */
  limitBackoffMs: readonly number[];
  /** Total time spent on connection-limit attempts before giving up. */
  limitTotalMs: number;
  /** VOD reconnect attempts stop after this window. */
  vodReconnectWindowMs: number;
}

/** Spec defaults. */
export const DEFAULT_PLAYBACK_CONFIG: PlaybackConfig = {
  liveStallWindowMs: 4000,
  startTimeoutMs: 8000,
  rungTimeoutMs: 4000,
  ladderGapsMs: [0, 1000, 2000, 4000],
  stableRestoreMs: 30000,
  limitBackoffMs: [2000, 4000, 8000, 15000],
  limitTotalMs: 60000,
  vodReconnectWindowMs: 120000,
};
