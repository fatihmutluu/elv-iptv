import type { ElvError, Result } from '@elv/domain';
import type { AttemptToken, ClockAnchor, MediaKind, StreamRequest } from './engine';

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
}

/** What the service is doing now. */
export type PlaybackStatus =
  | { kind: 'idle' }
  | { kind: 'tuning' }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'recovering'; rung: 1 | 2 | 3 | 4; nextAtMs: number }
  | { kind: 'limited'; nextAtMs: number }
  | { kind: 'failed'; error: ElvError };

/** Snapshot delivered to subscribers. Times are on the injected clock. */
export interface PlaybackState {
  status: PlaybackStatus;
  attempt: AttemptToken;
  item?: string;
  accountKey?: string;
  anchor?: ClockAnchor;
  tuneAt?: number;
  firstFrameAt?: number;
  staleEventsDropped: number;
}

/** Playback controller; the UI talks to this, never to the engine. */
export interface PlaybackService {
  /**
   * Supersedes the current tune at once and returns the new attempt token. During a connection-limit
   * backoff a tune of the same account keeps the `limited` status and loads when the backoff ends.
   */
  tune(request: TuneRequest): AttemptToken;
  /** Re-prepares loaded media, or tunes the last request again after a failure. */
  retry(): void;
  stop(): void;
  /** Resumes; recovery cut short by a pause restarts at rung 1 with the budget it had. */
  play(): void;
  /** Pauses; no recovery command is sent until `play`, and pending rungs are dropped. */
  pause(): void;
  /** Seeks; the stall watchdog stays disarmed until the engine reports `playing` again. */
  seek(positionMs: number): void;
  getState(): PlaybackState;
  /** Returns the unsubscribe function. */
  subscribe(listener: (state: PlaybackState) => void): () => void;
  /** Detaches from the engine and clears every timer; the caller still owns and releases the engine. */
  dispose(): void;
}
