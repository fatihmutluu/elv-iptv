import type {
  AndroidDecoderMode,
  BufferPreset,
  DnsFamilyPreference,
  DrmClearKeyPair,
  DrmConfig,
  DrmScheme,
  NightModeDrcPreset,
  SubtitleStyleConfig,
} from '@elv/domain';
import type { DesktopAudioOutputConfig, DisplaySyncPolicy } from './display-sync';

export type { DrmClearKeyPair, DrmConfig, DrmScheme };

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
  /** Provider account key for connection-limit tracking and safe multi-source failover (`#157`). */
  readonly accountKey?: string;
  /** Maximum concurrent connections allowed by the stream's provider (`#157`, `#167`). */
  readonly maxConnections?: number;
  /** Catalog source identifier associated with this stream (`#157`, `#317`). */
  readonly sourceId?: string;
  /** Catalog channel key associated with this stream (`#157`, `#167`). */
  readonly channelKey?: string;
  /** Per-source DNS address-family preference (`#172`). */
  readonly dnsFamily?: DnsFamilyPreference;
  /** Per-source validated literal IP host override (`#172`). */
  readonly hostOverride?: string;
  /** Play-time DRM configuration resolved outside SQLite (`#272`). Never log or persist. */
  readonly drm?: DrmConfig;
}

/** An external sidecar subtitle track attached at tune time or live during playback (`#32`, `#308`). */
export interface ExternalSubtitleTrack {
  readonly id: string;
  readonly uri: string;
  readonly label?: string;
  readonly language?: string;
  readonly mimeType?: string;
  /** Optional headers scoped strictly to this subtitle request — NEVER inherits primary stream credentials (`#308`). */
  readonly headers?: Readonly<Record<string, string>>;
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
  /** Preferred secondary subtitle track ID to select, or `null` to disable secondary subtitles (`#402`). */
  readonly secondarySubtitleTrackId?: string | null;
  /** External sidecar subtitle tracks attached to this item, with strictly isolated headers (`#32`, `#308`). */
  readonly externalSubtitles?: readonly ExternalSubtitleTrack[];
  /** Live subtitle appearance configuration forwarded on load and recovery reloads (`#32`). */
  readonly subtitleStyle?: SubtitleStyleConfig;
  /** Per-source DNS address-family preference forwarded to the engine (`#172`). */
  readonly dnsFamily?: DnsFamilyPreference;
  /** Per-source validated literal IP host override forwarded to the engine (`#172`). */
  readonly hostOverride?: string;
  /** Display Auto Frame-Rate and HDR switching policy forwarded to the engine (`#116`, `#188`, `#199`, `#214`). */
  readonly displaySync?: DisplaySyncPolicy;
  /** Night-Mode dynamic range compression preset forwarded to the engine (`#115`). */
  readonly nightModeDrc?: NightModeDrcPreset;
  /** Desktop audio passthrough, exclusive output, AC3 encode, and channel layout config (`#213`). */
  readonly desktopAudioOutput?: DesktopAudioOutputConfig;
  /** Preferred multi-program MPEG-TS service/program ID to select on load (`#304`). */
  readonly programId?: string;
}

/** One selectable service/program inside a multi-program MPEG-TS transport stream (`#304`). */
export interface ProgramInfo {
  readonly id: string;
  readonly label: string;
  readonly serviceName?: string;
  readonly programNumber?: number;
}

/** One selectable audio or embedded/external subtitle track reported by the engine. */
export interface TrackInfo {
  id: string;
  language?: string;
  label?: string;
  codec?: string;
  channels?: number;
  forced?: boolean;
  isDefault?: boolean;
  /** Whether this track originated from a user-attached external sidecar file or URL (`#32`). */
  readonly external?: boolean;
  /** Optional multi-program MPEG-TS service/program ID this track belongs to (`#304`). */
  readonly programId?: string;
}

/** One selectable adaptive video rendition reported by the engine (`#59`). */
export interface VideoQualityOption {
  readonly id: string;
  readonly label: string;
  readonly width?: number;
  readonly height?: number;
  readonly bitrateBps?: number;
  readonly fps?: number;
  /** Optional multi-program MPEG-TS service/program ID this rendition belongs to (`#304`). */
  readonly programId?: string;
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
  /** Selectable services/programs when a multi-program MPEG-TS stream carries > 1 program (`#304`). */
  readonly programs?: readonly ProgramInfo[];
  /** Selected multi-program service/program ID, or `null` / `undefined` when not applicable (`#304`). */
  readonly selectedProgramId?: string | null;
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

/** Live read-ahead and back-buffer telemetry reported by the engine (`#350`). */
export interface BufferHealth {
  readonly bufferedAheadMs: number;
  readonly bufferedBehindMs: number;
  readonly diskCacheBytes?: number;
  readonly throttled?: boolean;
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
  /** Live VOD read-ahead and back-buffer telemetry reported by the engine (`#350`). */
  readonly bufferHealth?: BufferHealth;
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
  /** Engine supports attaching isolated external sidecar subtitle tracks (`#32`, `#308`). */
  readonly externalSubtitles?: boolean;
  /** Engine supports live subtitle appearance styling without restarting playback (`#32`). */
  readonly subtitleStyling?: boolean;
  /** Engine supports simultaneous dual subtitle rendering (`#402`). */
  readonly dualSubtitles?: boolean;
  /** Engine supports multi-program MPEG-TS service/program selection (`#304`). */
  readonly programSelection?: boolean;
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
  /** Attaches an external sidecar subtitle track to the active media without inheriting stream headers (`#32`, `#308`). */
  addExternalSubtitle?(attempt: AttemptToken, track: ExternalSubtitleTrack): void;
  /** Applies live subtitle appearance styling without restarting playback (`#32`). */
  setSubtitleStyle?(style: SubtitleStyleConfig): void;
  /** Applies a live Night-Mode DRC preset without restarting playback (`#115`). */
  setNightModeDrc?(preset: NightModeDrcPreset): void;
  /** Updates display Auto Frame-Rate and HDR switching policy live (`#116`, `#188`, `#199`, `#214`). */
  setDisplaySync?(policy: DisplaySyncPolicy): void;
  /** Updates desktop audio passthrough and channel layout output live (`#213`). */
  setDesktopAudioOutput?(config: DesktopAudioOutputConfig): void;
  /** Shifts audio timing relative to video in milliseconds (`[-30_000, 30_000]`, `#59`, `#203`, `#239`). */
  setAudioDelay?(attempt: AttemptToken, delayMs: number): void;
  /** Shifts subtitle cue timing in milliseconds (`[-30_000, 30_000]`, `#59`, `#203`, `#239`). */
  setSubtitleDelay?(attempt: AttemptToken, delayMs: number): void;
  /** Constrains or selects an adaptive video rendition ID, or `null` for automatic ABR (`#59`). */
  selectVideoQuality?(attempt: AttemptToken, id: string | null): void;
  /** Selects a service/program inside a multi-program MPEG-TS stream (`#304`). */
  selectProgram?(attempt: AttemptToken, id: string): void;
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
