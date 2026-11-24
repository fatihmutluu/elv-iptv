import type { AndroidDecoderMode, BufferPreset } from '@elv/domain';

/** Monotonic tune token; the service increments it per tune, retry rung and zap. */
export type AttemptToken = number;

/** Live streams have a moving edge; VOD has a fixed duration. */
export type MediaKind = 'live' | 'vod';

/** What an engine needs to open a stream. Built at play time; never persisted. */
export interface StreamRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  /** Post-redirect effective stream URL observed by a resolver or probe, if known (`#287`). */
  finalUrl?: string;
  /** Inline backup stream requests associated with the primary stream (`#287`). */
  alternates?: readonly StreamRequest[];
  /** Opt-in legacy TLS (TLS 1.0/1.1) compatibility carried by the resolved stream (`#182`). */
  readonly allowLegacyTls?: boolean;
}

/** Engine choices for one load. */
export interface LoadOptions {
  /** Decode audio in software; recovery rung 4 asks for it after a `decoder` error when the engine can. */
  softwareAudio?: boolean;
  /** Prefer HEVC base-layer / Profile 8.1 decoding over Dolby Vision Profile 7 (`#189`). */
  preferHevcOverDolbyVision?: boolean;
  /** Strip SDH / hearing-impaired annotations from rendered text subtitles (`#310`). */
  filterSdhSubtitles?: boolean;
  /** Opt-in legacy TLS (TLS 1.0/1.1) compatibility for older servers (`#182`). */
  readonly allowLegacyTls?: boolean;
  /** User-configured buffer size preset forwarded to the native engine (`#147`). */
  bufferPreset?: BufferPreset;
  /** User-configured Android video decoder selection mode forwarded to Media3 (`#411`). */
  decoderMode?: AndroidDecoderMode;
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

/** One selectable adaptive video rendition reported by the engine (`#59`). */
export interface VideoQualityOption {
  readonly id: string;
  readonly label: string;
  readonly width?: number;
  readonly height?: number;
  readonly bitrateBps?: number;
  readonly fps?: number;
}

/** Available audio, subtitle, and adaptive video tracks for the open media (`null` = none / Off / Auto). */
export interface MediaTracks {
  readonly audio: readonly TrackInfo[];
  readonly subtitles: readonly TrackInfo[];
  readonly selectedAudioId: string | null;
  readonly selectedSubtitleId: string | null;
  /** Optional secondary subtitle track selection (`#239`, `#402`). */
  readonly selectedSecondarySubtitleId?: string | null;
  /** Selectable adaptive video renditions when the active stream offers multiple resolutions (`#59`). */
  readonly videoQualities?: readonly VideoQualityOption[];
  /** Selected video rendition ID, or `null` / `undefined` for automatic ABR (`#59`). */
  readonly selectedVideoQualityId?: string | null;
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
  /** Post-redirect effective stream URL observed by the engine before failing (`#287`). */
  finalUrl?: string;
}

/** Position sample: the media was at `positionMs` when the JS clock read `atMs`. */
export interface ClockAnchor {
  positionMs: number;
  atMs: number;
  rate: number;
  durationMs?: number;
  liveEdgeMs?: number;
  /** Earliest seekable timestamp (ms) in the active live time-shift window (`#28`). */
  readonly liveSeekableStartMs?: number;
  /** Whether bounded live time-shift seeking is currently available for this stream (`#28`). */
  readonly timeShiftSupported?: boolean;
  /** Whether the active live stream is raw MPEG-TS (eligible for live-edge jump, `#141`; never HLS/VOD). */
  isLiveTs?: boolean;
  /** Cumulative rendered/decoded video frames reported by the engine for black-screen detection (`#321`). */
  decodedVideoFrames?: number;
  /** Whether the active media declares a video track (distinguishes radio/audio-only from black screen). */
  hasVideoTrack?: boolean;
}

/** Dynamic range transfer classification of the active video stream (`#58`). */
export type StreamHdrKind = 'sdr' | 'hdr10' | 'hlg' | 'dv';

/** One chapter marker reported by the media container or engine (`#118`). */
export interface ChapterInfo {
  readonly id: string;
  readonly title?: string;
  readonly startMs: number;
  readonly endMs?: number;
}

/** Real decoded video stream telemetry emitted by native and desktop engines (`#58`, `#160`, `#332`). */
export interface StreamVideoInfo {
  readonly width?: number;
  readonly height?: number;
  /** Positive finite display aspect ratio (DAR), e.g. `16 / 9`, `2.39`, or `4 / 3` (`#332`). */
  readonly aspectRatio?: number;
  readonly fps?: number;
  readonly codec?: string;
  readonly hdr?: StreamHdrKind;
  readonly droppedFrames?: number;
}

/** Every event echoes the token of the media or command it belongs to. */
export type EngineEvent = { attempt: AttemptToken } & (
  | { type: 'state'; state: EngineState }
  | { type: 'firstFrame'; atMs: number }
  | { type: 'clock'; anchor: ClockAnchor }
  | { type: 'tracks'; tracks: MediaTracks }
  | { type: 'chapters'; chapters: readonly ChapterInfo[] }
  | { type: 'mediaInfo'; info: StreamVideoInfo }
  | { type: 'telemetry'; droppedFrames?: number }
  | { type: 'stall'; phase: 'start' | 'end'; atMs: number }
  | { type: 'progress'; bytesReceived?: number; atMs: number }
  | { type: 'error'; error: EngineError }
  | { type: 'externalPlayback'; active: boolean }
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
  /** Engine supports live audio A/V sync delay offset (`#59`, `#203`, `#239`). */
  audioDelay?: boolean;
  /** Engine supports live subtitle timing delay offset (`#59`, `#203`, `#239`). */
  subtitleDelay?: boolean;
  /** Engine supports adaptive video resolution/rendition selection (`#59`). */
  videoQualitySelection?: boolean;
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
  /** Jumps a live stream directly back to its default live edge when natively supported (`#28`). */
  jumpToLiveEdge?(attempt: AttemptToken): void;
  /** Toggles VOD scrubbing mode (e.g. Media3 `isScrubbingModeEnabled`, `#222`). */
  setScrubbing?(attempt: AttemptToken, scrubbing: boolean): void;
  setSpeed?(attempt: AttemptToken, rate: number): void;
  /** Toggles audio pitch preservation when playback speed differs from `1.0` (`#243`, `#264`). */
  setPitchLock?(attempt: AttemptToken, locked: boolean): void;
  selectAudioTrack?(attempt: AttemptToken, id: string): void;
  selectSubtitleTrack?(attempt: AttemptToken, id: string | null): void;
  /** Selects a secondary subtitle track, or `null` to disable (`#239`, `#402`). */
  selectSecondarySubtitleTrack?(attempt: AttemptToken, id: string | null): void;
  /** Shifts audio timing relative to video in milliseconds (`[-30_000, 30_000]`, `#59`, `#203`, `#239`). */
  setAudioDelay?(attempt: AttemptToken, delayMs: number): void;
  /** Shifts subtitle cue timing in milliseconds (`[-30_000, 30_000]`, `#59`, `#203`, `#239`). */
  setSubtitleDelay?(attempt: AttemptToken, delayMs: number): void;
  /** Constrains or selects an adaptive video rendition ID, or `null` for automatic ABR (`#59`). */
  selectVideoQuality?(attempt: AttemptToken, id: string | null): void;
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
