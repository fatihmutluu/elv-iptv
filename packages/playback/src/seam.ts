import type { ElvError } from '@elv/domain';
import type { PlaybackConfig } from './config';
import type {
  AttemptToken,
  ClockAnchor,
  EngineError,
  EngineState,
  LoadOptions,
  PlayerEngine,
  StreamRequest,
} from './engine';
import type { StreamHealthScorer } from './stream-health-scorer';
import type { PlaybackState, PlaybackStatus, TuneRequest } from './types';

/** @internal Live stream container format eligible for pre-playback fallback. */
export type LiveContainerFormat = 'ts' | 'm3u8';

/** @internal Per-session working live container cache keyed by `accountKey`. */
export interface WorkingFormatCache {
  get(accountKey: string): LiveContainerFormat | undefined;
  set(accountKey: string, format: LiveContainerFormat): void;
  evict(accountKey: string): void;
  apply(accountKey: string, stream: StreamRequest): StreamRequest;
}

/** @internal How a recovery load differs from the tune's own stream and start position. */
export interface LoadOverrides {
  /** Replaces the tune's stream from now on (rung 4 switching to an alternate). */
  stream?: StreamRequest;
  startMs?: number;
  options?: LoadOptions;
}

/** @internal What the recovery logic may do to the service; not exported from the package. */
export interface ServiceControl {
  readonly engine: PlayerEngine;
  readonly config: PlaybackConfig;
  readonly formatCache?: WorkingFormatCache;
  readonly healthScorer?: StreamHealthScorer;
  readonly canAcquireAlternate?: (accountKey: string, maxConnections: number) => boolean;
  now(): number;
  getState(): PlaybackState;
  /** The current tune, loaded or held. */
  request(): TuneRequest | undefined;
  /** Latest resolved stream for the current tune, if already resolved. */
  stream?(): StreamRequest | undefined;
  /** Whether an open media is currently loaded on the engine. */
  isLoaded?(): boolean;
  /** Batches multiple synchronous state mutations into a single subscriber notification. */
  batch?<T>(fn: () => T): T;
  /** Start timeout for the current tune (`liveStartTimeoutMs` for live, `startTimeoutMs` for VOD). */
  startTimeoutMs(): number;
  /** Takes a new token; later events of older tokens are dropped. */
  nextAttempt(): AttemptToken;
  /** Increments `state.surfaceRecreationToken` when Rung 3 decoder recovery requests a fresh surface (`#144`). */
  bumpSurfaceRecreationToken?(): number;
  setStatus(status: PlaybackStatus): void;
  /** Freezes `state.anchor` at `positionAt(anchor, now)` with `rate: 0`. */
  freezeAnchor(): void;
  /**
   * Ends a hold and sends `load` with the current token and the resolved stream; returns `true`
   * when `engine.load` was dispatched immediately (`stream !== undefined`).
   */
  load(overrides?: LoadOverrides): boolean;
  /** Sends `stop` for the open media and marks it unloaded. */
  stopMedia(): void;
  /** Clears any gapless queued next-episode slot before premature-EOF recovery reloads the current item. */
  clearQueuedNext?(): void;
  /** Sets `failed` and stops the engine. */
  fail(error: ElvError): void;
  armStartTimeout(ms: number): void;
  clearStartTimeout(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** @internal Reactions the service calls; every hook is optional. */
export interface RecoveryHooks {
  /** A tune supersedes the current one; true holds its load, and keeps the status, until `load`. */
  onTune?(request: TuneRequest): boolean;
  /** Stop, a user retry or a failure: forget every pending step and budget. */
  onReset?(): void;
  onSeek?(positionMs: number): void;
  /** The user paused; called before `pause` is sent. */
  onPause?(): void;
  /** The user resumed; called before `play` is sent so stale-pause or deferred reloads run first. */
  onPlay?(): void;
  onState?(state: EngineState): void;
  /** Intercepts an unexpected live `ended` event; returns `true` when recovery initiated a reconnect. */
  onLiveEnded?(): boolean;
  /** Intercepts an unexpected mid-media VOD `ended` event; returns `true` when recovery initiated a reconnect. */
  onVodEnded?(): boolean;
  onClock?(anchor: ClockAnchor): void;
  onError?(error: EngineError): void;
  onStall?(phase: 'start' | 'end'): void;
  onExternalPlayback?(active: boolean): void;
  onProgress?(atMs: number, bytesReceived?: number): void;
  onStartTimeout?(): void;
  /** Every surface event, whatever its token: the surface belongs to the view, not the media. */
  onSurface?(change: 'created' | 'destroyed'): void;
  onDispose?(): void;
}
