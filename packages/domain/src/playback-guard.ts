/** Active playback session handle registered with a {@link PlaybackGuard}. */
export interface GuardedPlaybackSession {
  getSourceId(): string | undefined;
  stop(): void;
}

/** Port allowing source removal to synchronously stop playback when the active stream belongs to the removed source. */
export interface PlaybackGuard {
  stopIfUsingSource(sourceId: string): void | Promise<void>;
  registerSession?(session: GuardedPlaybackSession): () => void;
}

/** Default guard used when no playback session is mounted yet. */
export const noopPlaybackGuard: PlaybackGuard = {
  stopIfUsingSource: () => undefined,
  registerSession: () => () => undefined,
};

/**
 * Creates a synchronous {@link PlaybackGuard} that immediately stops any registered playback
 * session matching `sourceId` before invoking an optional UI teardown callback (`#67`).
 */
export function createPlaybackGuard(onStopSource?: (sourceId: string) => void): PlaybackGuard {
  const sessions = new Set<GuardedPlaybackSession>();
  return {
    stopIfUsingSource(sourceId) {
      for (const session of [...sessions]) {
        try {
          if (session.getSourceId() === sourceId) session.stop();
        } catch {
          // Best-effort session stop so peer sessions and source removal always proceed.
        }
      }
      onStopSource?.(sourceId);
    },
    registerSession(session) {
      sessions.add(session);
      return () => {
        sessions.delete(session);
      };
    },
  };
}
