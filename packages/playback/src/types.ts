import type { AndroidDecoderMode, BufferPreset, ElvError, Result } from '@elv/domain';
import type {
  AttemptToken,
  ClockAnchor,
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
}

/** Playback controller; the UI talks to this, never to the engine. */
export interface PlaybackService {
  /**
   * Supersedes the current tune at once and returns the new attempt token. During a connection-limit
   * backoff a tune of the same account keeps the `limited` status and loads when the backoff ends.
   */
  tune(request: TuneRequest): AttemptToken;
  /** Re-prepares loaded media, replays ended VOD from 0, or tunes the last request again after a failure. */
  retry(): void;
  stop(): void;
  /** Resumes with a fresh attempt token; recovery cut short by a pause continues with the budget it had. */
  play(): void;
  /** Pauses with a fresh attempt token; no recovery command is sent until `play`, and pending rungs are dropped. */
  pause(): void;
  /** Seeks; disarms the stall watchdog and any active VOD reconnect backoff, and updates `anchor` immediately. */
  seek(positionMs: number): void;
  /**
   * Seeks a lagging live MPEG-TS stream to `Math.max(0, liveEdgeMs - 3_000)` (`#141`).
   * Strictly a no-op returning `false` for HLS, VOD, missing `liveEdgeMs`, or streams already within 4 s of live edge.
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
  getState(): PlaybackState;
  /** Returns the unsubscribe function. */
  subscribe(listener: (state: PlaybackState) => void): () => void;
  /** Stops any open media, detaches from the engine and clears every timer; the caller releases the engine. */
  dispose(): void;
}
