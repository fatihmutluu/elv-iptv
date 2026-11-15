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
import type { PlaybackState, PlaybackStatus, TuneRequest } from './types';

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
  now(): number;
  getState(): PlaybackState;
  /** The current tune, loaded or held. */
  request(): TuneRequest | undefined;
  /** Start timeout for the current tune (`liveStartTimeoutMs` for live, `startTimeoutMs` for VOD). */
  startTimeoutMs(): number;
  /** Takes a new token; later events of older tokens are dropped. */
  nextAttempt(): AttemptToken;
  setStatus(status: PlaybackStatus): void;
  /** Freezes `state.anchor` at `positionAt(anchor, now)` with `rate: 0`. */
  freezeAnchor(): void;
  /**
   * Ends a hold and sends `load` with the current token and the resolved stream; a tune still
   * resolving loads when its resolve settles.
   */
  load(overrides?: LoadOverrides): void;
  /** Sends `stop` for the open media and marks it unloaded. */
  stopMedia(): void;
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
  /** The user resumed; called after `play` is sent. */
  onPlay?(): void;
  onState?(state: EngineState): void;
  onClock?(anchor: ClockAnchor): void;
  onError?(error: EngineError): void;
  onStall?(phase: 'start' | 'end'): void;
  onStartTimeout?(): void;
  /** Every surface event, whatever its token: the surface belongs to the view, not the media. */
  onSurface?(change: 'created' | 'destroyed'): void;
  onDispose?(): void;
}
