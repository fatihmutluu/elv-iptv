import type {
  AndroidDecoderMode,
  BufferPreset,
  DnsFamilyPreference,
  ElvError,
  Result,
  SubtitleStyleConfig,
} from '@elv/domain';
import type {
  AttemptToken,
  ChapterInfo,
  ClockAnchor,
  ExternalSubtitleTrack,
  MediaKind,
  MediaTracks,
  StreamRequest,
  StreamVideoInfo,
} from './engine';

/** Time source, injected so tests control it. */
export interface PlaybackClock {
  now(): number;
}

/** Timer source, injected so tests control it. */
export interface PlaybackTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What to play. `resolve` builds the stream request at play time so credentials stay out of the catalog. */
export interface TuneRequest {
  item: string;
  /** Source the stream belongs to; a provider connection limit holds zaps within one account. */
  accountKey: string;
  kind: MediaKind;
  resolve: () => Promise<Result<StreamRequest>>;
  /** Other ways to play the same item, tried in order by recovery rung 4. */
  alternates?: readonly (() => Promise<Result<StreamRequest>>)[];
  startMs?: number;
  /** User-selected playback buffer preset forwarded on load and recovery reloads (`#147`). */
  bufferPreset?: BufferPreset;
  /** User-selected Android video decoder mode forwarded on load and recovery reloads (`#411`). */
  decoderMode?: AndroidDecoderMode;
  /** Prefer HEVC base-layer over Dolby Vision when decoding (`#124`, `#189`). */
  preferHevcOverDolbyVision?: boolean;
  /** Strip SDH annotations from rendered text subtitles (`#310`). */
  filterSdhSubtitles?: boolean;
  /** Opt-in legacy TLS (TLS 1.0/1.1) compatibility forwarded on load and recovery reloads (`#182`). */
  readonly allowLegacyTls?: boolean;
  /** External sidecar subtitle tracks attached at tune time (`#32`, `#308`). */
  readonly externalSubtitles?: readonly ExternalSubtitleTrack[];
  /** Live subtitle appearance styling forwarded on load and reloads (`#32`). */
  readonly subtitleStyle?: SubtitleStyleConfig;
  /** Optional default per-source DNS address-family preference (`#172`). */
  readonly dnsFamily?: DnsFamilyPreference;
  /** Optional default per-source validated literal IP host override (`#172`). */
  readonly hostOverride?: string;
}

/** What the service is doing now. */
export type PlaybackStatus =
  | { kind: 'idle' }
  | { kind: 'tuning' }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'ended' }
  | { kind: 'recovering'; rung: 1 | 2 | 3 | 4; nextAtMs: number }
  | { kind: 'limited'; nextAtMs: number }
  | { kind: 'failed'; error: ElvError };

/** Snapshot delivered to subscribers. Times are on the injected clock. */
export interface PlaybackState {
  status: PlaybackStatus;
  attempt: AttemptToken;
  tracks: MediaTracks;
  /** Decoded video metadata reported by the engine for the active media (`#58`). */
  readonly videoInfo?: StreamVideoInfo;
  /** Chapter markers reported for the active media (`#118`). */
  readonly chapters?: readonly ChapterInfo[];
  /** Cumulative dropped video frames reported for the active media (`#160`). */
  readonly droppedFrames?: number;
  item?: string;
  accountKey?: string;
  anchor?: ClockAnchor;
  /** Whether a live stream is currently within the live-edge grace window (`#284`). */
  atLiveEdge?: boolean;
  tuneAt?: number;
  firstFrameAt?: number;
  staleEventsDropped: number;
  /** Monotonic token incremented only on Rung 3 decoder-error recreate to request a fresh native surface (`#144`). */
  readonly surfaceRecreationToken: number;
  /** Whether playback is currently routed to an external receiver such as AirPlay (`#234`). */
  readonly externalPlaybackActive?: boolean;
  /** Live audio sync delay offset in milliseconds (`[-30_000, 30_000]`, `#59`). */
  readonly audioDelayMs?: number;
  /** Live subtitle sync delay offset in milliseconds (`[-30_000, 30_000]`, `#59`). */
  readonly subtitleDelayMs?: number;
  /** Selected adaptive video rendition ID, or `null` for automatic ABR (`#59`). */
  readonly selectedVideoQualityId?: string | null;
  /** External sidecar subtitle tracks attached to the active item (`#32`, `#308`). */
  readonly externalSubtitles?: readonly ExternalSubtitleTrack[];
  /** Active live subtitle appearance configuration (`#32`). */
  readonly subtitleStyle?: SubtitleStyleConfig;
}

/** Playback controller; the UI talks to this, never to the engine. */
export interface PlaybackService {
  /**
   * Supersedes the current tune at once and returns the new attempt token. During a connection-limit
   * backoff a tune of the same account keeps the `limited` status and loads when the backoff ends.
   */
  tune(request: TuneRequest): AttemptToken;
  /**
   * Adopts a gaplessly queued target (e.g. mpv `append-play` next episode, `#205`) without
   * stopping/reloading or bumping `attempt`, so watch-progress writes, controls, recovery reloads,
   * and replays target the newly active item.
   */
  adoptQueuedTarget(request: TuneRequest, stream?: StreamRequest): void;
  /** Re-prepares loaded media, replays ended VOD from 0, or tunes the last request again after a failure. */
  retry(): void;
  stop(): void;
  /** Resumes with a fresh attempt token; recovery cut short by a pause continues with the budget it had. */
  play(): void;
  /** Pauses with a fresh attempt token; no recovery command is sent until `play`, and pending rungs are dropped. */
  pause(): void;
  /** Seeks; disarms the stall watchdog and any active VOD reconnect backoff, and updates `anchor` immediately. */
  seek(positionMs: number): void;
  /** Seeks relative to the current extrapolated position (clamped to VOD duration or live time-shift window, `#28`). */
  seekBy?(deltaMs: number): void;
  /**
   * Jumps a lagging live stream back to the live edge (`#141`, `#28`):
   * - When `timeShiftSupported === true` and behind by `> 2 s`, seeks directly to `liveEdgeMs` (or calls `engine.jumpToLiveEdge`).
   * - When `isLiveTs === true` (without bounded time-shift) and behind by `> 4 s`, seeks to `Math.max(0, liveEdgeMs - 3_000)`.
   * Strictly a no-op returning `false` for VOD, missing `liveEdgeMs`, or streams already at the live edge.
   */
  jumpToLiveEdge(): boolean;
  /** Toggles VOD scrubbing mode on the underlying engine when supported (`#222`). */
  setScrubbing?(scrubbing: boolean): void;
  /** Sets playback speed (clamped to `[0.25, 4.0]`), coalescing across active seeks and in-flight transitions. */
  setSpeed(rate: number): void;
  /** Selects an audio track in place and remembers the choice across recovery reloads of the current item. */
  selectAudioTrack(id: string): void;
  /** Selects a subtitle track in place (`null` turns subtitles off) and remembers the choice across reloads. */
  selectSubtitleTrack(id: string | null): void;
  /** Selects a secondary subtitle track in place (`null` disables secondary subtitles, `#239`, `#402`). */
  selectSecondarySubtitleTrack(id: string | null): void;
  /**
   * Validates, deduplicates, and attaches an external sidecar subtitle track to the active item (`#32`, `#308`).
   * Returns `true` when accepted, or `false` when idle/disposed, invalid, or duplicate by `id`/`uri`.
   */
  addExternalSubtitle(track: ExternalSubtitleTrack): boolean;
  /** Updates live subtitle appearance styling without restarting playback and persists across reloads (`#32`). */
  setSubtitleStyle(style: SubtitleStyleConfig): void;
  /** Sets live audio sync delay offset in milliseconds, clamped to `[-30_000, 30_000]` (`#59`). */
  setAudioDelay(delayMs: number): void;
  /** Sets live subtitle timing delay offset in milliseconds, clamped to `[-30_000, 30_000]` (`#59`). */
  setSubtitleDelay(delayMs: number): void;
  /** Selects an adaptive video rendition ID, or `null` for automatic ABR (`#59`). */
  selectVideoQuality(id: string | null): void;
  getState(): PlaybackState;
  /** Returns the unsubscribe function. */
  subscribe(listener: (state: PlaybackState) => void): () => void;
  /** Stops any open media, detaches from the engine and clears every timer; the caller releases the engine. */
  dispose(): void;
}
