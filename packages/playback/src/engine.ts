/** Monotonic tune token; the service increments it per tune, retry rung and zap. */
export type AttemptToken = number;

/** Live streams have a moving edge; VOD has a fixed duration. */
export type MediaKind = 'live' | 'vod';

/** What an engine needs to open a stream. Built at play time; never persisted. */
export interface StreamRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

/** Engine choices for one load. */
export interface LoadOptions {
  /** Decode audio in software; recovery rung 4 asks for it after a `decoder` error when the engine can. */
  softwareAudio?: boolean;
  /** Preferred audio track ID to select once media tracks are available. */
  audioTrackId?: string;
  /** Preferred subtitle track ID to select, or `null` to disable subtitles explicitly. */
  subtitleTrackId?: string | null;
}

/** One selectable audio or embedded subtitle track reported by the engine. */
export interface TrackInfo {
  id: string;
  language?: string;
  label?: string;
  codec?: string;
  channels?: number;
  forced?: boolean;
  isDefault?: boolean;
}

/** Available audio and subtitle tracks for the open media, plus active selections (`null` = none / Off). */
export interface MediaTracks {
  readonly audio: readonly TrackInfo[];
  readonly subtitles: readonly TrackInfo[];
  readonly selectedAudioId: string | null;
  readonly selectedSubtitleId: string | null;
}

/** Canonical empty track snapshot before tracks arrive or after `tune`/`stop`. */
export const EMPTY_TRACKS: MediaTracks = Object.freeze({
  audio: Object.freeze([] as readonly TrackInfo[]),
  subtitles: Object.freeze([] as readonly TrackInfo[]),
  selectedAudioId: null,
  selectedSubtitleId: null,
});

/** Starts a new media, replacing the current one. */
export interface LoadCommand extends StreamRequest {
  attempt: AttemptToken;
  kind: MediaKind;
  startMs?: number;
  options?: LoadOptions;
}

/** Coarse engine playback state. */
export type EngineState = 'opening' | 'buffering' | 'ready' | 'playing' | 'paused' | 'ended';

/** Stable engine error codes; see the player core spec section 5.3. */
export type EngineErrorCode =
  | 'http-401'
  | 'http-403'
  | 'http-404'
  | 'http-429'
  | 'http-509'
  | 'http-other'
  | 'connection-limit'
  | 'network'
  | 'unsupported-format'
  | 'decoder'
  | 'drm'
  | 'surface-lost'
  | 'engine-wedged'
  | 'unknown';

/** An engine failure. `detail` is diagnostic only and must never contain credentials. */
export interface EngineError {
  code: EngineErrorCode;
  httpStatus?: number;
  detail?: string;
}

/** Position sample: the media was at `positionMs` when the JS clock read `atMs`. */
export interface ClockAnchor {
  positionMs: number;
  atMs: number;
  rate: number;
  durationMs?: number;
  liveEdgeMs?: number;
}

/** Every event echoes the token of the media or command it belongs to. */
export type EngineEvent = { attempt: AttemptToken } & (
  | { type: 'state'; state: EngineState }
  | { type: 'firstFrame'; atMs: number }
  | { type: 'clock'; anchor: ClockAnchor }
  | { type: 'tracks'; tracks: MediaTracks }
  | { type: 'stall'; phase: 'start' | 'end'; atMs: number }
  | { type: 'error'; error: EngineError }
  | { type: 'surface'; change: 'created' | 'destroyed' }
);

/** Flags the service and UI read to choose behavior. */
export interface EngineCapabilities {
  mpegTsOverHttp: boolean;
  hls: boolean;
  liveSeek: boolean;
  softwareAudioFallback: boolean;
  recreate: boolean;
  audioTrackSelection: boolean;
  subtitleTrackSelection: boolean;
}

/**
 * Port every native player engine implements.
 *
 * Contract:
 * - Commands are enqueue-and-return: they never block or throw; outcomes arrive as events.
 * - Token adoption: on a command with a newer token, the engine tags every later event of
 *   the current media with that token. `load` starts a new media; `retry`, `recreate` and
 *   the other commands keep the media and adopt the token.
 * - One media at a time: `load` replaces the current media and closes every connection of
 *   the previous one before the new media's first request opens.
 */
export interface PlayerEngine {
  readonly capabilities: EngineCapabilities;
  load(cmd: LoadCommand): void;
  retry(attempt: AttemptToken): void;
  play(attempt: AttemptToken): void;
  pause(attempt: AttemptToken): void;
  seek(attempt: AttemptToken, positionMs: number): void;
  selectAudioTrack?(attempt: AttemptToken, id: string): void;
  selectSubtitleTrack?(attempt: AttemptToken, id: string | null): void;
  stop(attempt: AttemptToken): void;
  /**
   * Releases and rebuilds the native player instance, keeping the view and the surface. The new
   * instance is idle: nothing plays until the caller sends a `load` (recovery rung 3 sends one).
   */
  recreate(attempt: AttemptToken): void;
  release(): void;
  /** Returns the unsubscribe function. */
  subscribe(listener: (event: EngineEvent) => void): () => void;
}
