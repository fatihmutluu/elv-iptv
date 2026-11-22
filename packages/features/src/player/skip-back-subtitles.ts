import type { MediaTracks, PlaybackTimers } from '@elv/playback';

/** Default duration (`15 000 ms`) temporary subtitles remain active after a backward seek (`#114`). */
export const SKIP_BACK_SUBTITLES_WINDOW_MS = 15_000;

/** Configuration for {@link createSkipBackSubtitlesController}. */
export interface SkipBackSubtitlesOptions {
  /** Timer source (direct object or getter returning the current injected timers). */
  readonly timers: PlaybackTimers | (() => PlaybackTimers);
  /** Duration in milliseconds before automatically turning temporary subtitles back off. */
  readonly windowMs?: number;
  /** Invoked to activate a temporary subtitle track or restore subtitles to `null` (Off). */
  readonly onSelectSubtitle: (id: string | null) => void;
}

/** Input passed when a backward seek happens on a VOD item. */
interface SkipBackSeekContext {
  /** Persisted user preference (`autoSubtitlesOnSkipBack`). */
  readonly enabled: boolean;
  /** Active stream audio/subtitle tracks snapshot. */
  readonly tracks: MediaTracks;
  /** Optional preferred subtitle track id to activate when available. */
  readonly preferredTrackId?: string | null;
}

/** Pure state machine managing temporary auto-subtitles after backward VOD seeks (`#114`). */
export interface SkipBackSubtitlesController {
  /** Handles a backward seek; returns `true` if a temporary subtitle window is now active. */
  onBackwardSeek(ctx: SkipBackSeekContext): boolean;
  /** Cancels any pending auto-restore without reverting the user's explicit subtitle choice. */
  onManualSubtitleChange(): void;
  /** Whether a temporary skip-back subtitle window is currently armed. */
  isActive(): boolean;
  /** Clears timers and state (e.g. when switching playback items). */
  reset(): void;
  /** Releases active timers on teardown. */
  dispose(): void;
}

/**
 * Creates a pure controller that temporarily turns subtitles on for `windowMs` (default 15 s)
 * when the user rewinds while subtitles are off, extending on repeat rewinds and never overriding
 * subtitles the user enabled manually (`#114`).
 */
export function createSkipBackSubtitlesController(
  options: SkipBackSubtitlesOptions,
): SkipBackSubtitlesController {
  const { timers, onSelectSubtitle } = options;
  const windowMs =
    options.windowMs !== undefined && Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : SKIP_BACK_SUBTITLES_WINDOW_MS;

  let active = false;
  let handle: unknown;

  const getTimers = (): PlaybackTimers => (typeof timers === 'function' ? timers() : timers);

  const clearPendingTimer = (): void => {
    if (handle !== undefined) {
      getTimers().clearTimeout(handle);
      handle = undefined;
    }
  };

  const armTimer = (): void => {
    clearPendingTimer();
    handle = getTimers().setTimeout(() => {
      handle = undefined;
      if (!active) return;
      active = false;
      onSelectSubtitle(null);
    }, windowMs);
  };

  const cancel = (): void => {
    clearPendingTimer();
    active = false;
  };

  return {
    onBackwardSeek({ enabled, tracks, preferredTrackId }): boolean {
      if (!enabled || tracks.subtitles.length === 0) return false;
      if (active) {
        armTimer();
        return true;
      }
      if (tracks.selectedSubtitleId !== null) return false;

      const chosen =
        (preferredTrackId != null
          ? tracks.subtitles.find((t) => t.id === preferredTrackId)
          : undefined) ?? tracks.subtitles[0];
      if (chosen === undefined) return false;

      active = true;
      onSelectSubtitle(chosen.id);
      armTimer();
      return true;
    },
    onManualSubtitleChange: cancel,
    isActive: () => active,
    reset: cancel,
    dispose: cancel,
  };
}
