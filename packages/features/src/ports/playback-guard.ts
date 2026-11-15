/** Port allowing source removal to stop playback when the active stream belongs to the removed source. */
export interface PlaybackGuard {
  stopIfUsingSource(sourceId: string): void | Promise<void>;
}

/** Default guard used when no playback session is mounted yet. */
export const noopPlaybackGuard: PlaybackGuard = {
  stopIfUsingSource: () => undefined,
};
