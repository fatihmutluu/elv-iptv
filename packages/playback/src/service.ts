import { type ElvError, elvError, type Result } from '@elv/domain';
import { DEFAULT_PLAYBACK_CONFIG, type PlaybackConfig } from './config';
import type {
  AttemptToken,
  ClockAnchor,
  EngineError,
  EngineEvent,
  MediaKind,
  PlayerEngine,
  StreamRequest,
} from './engine';
import { toPlaybackError } from './errors';

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
  accountKey: string;
  kind: MediaKind;
  resolve: () => Promise<Result<StreamRequest>>;
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
  /** Supersedes the current tune at once and returns the new attempt token. */
  tune(request: TuneRequest): AttemptToken;
  /** Re-prepares loaded media, or tunes the last request again after a failure. */
  retry(): void;
  stop(): void;
  play(): void;
  pause(): void;
  seek(positionMs: number): void;
  getState(): PlaybackState;
  /** Returns the unsubscribe function. */
  subscribe(listener: (state: PlaybackState) => void): () => void;
  dispose(): void;
}

/** @internal Surface the recovery logic uses to drive the service; not exported from the package. */
interface ServiceControl {
  readonly engine: PlayerEngine;
  readonly config: PlaybackConfig;
  now(): number;
  getState(): PlaybackState;
  currentAttempt(): AttemptToken;
  /** Takes a new token for a retry rung; later events of older tokens are dropped. */
  nextAttempt(): AttemptToken;
  setStatus(status: PlaybackStatus): void;
  /** Sets `failed` and stops the engine. */
  fail(error: ElvError): void;
  armStartTimeout(ms: number): void;
  clearStartTimeout(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * @internal Reactions to current-token events, and to every surface event whatever its token
 * (the surface belongs to the view, not the media). Without hooks, an error or start timeout fails the tune.
 */
export interface RecoveryHooks {
  onError?(error: EngineError): void;
  onStall?(phase: 'start' | 'end'): void;
  onStartTimeout?(): void;
  onSurface?(change: 'created' | 'destroyed'): void;
  onDispose?(): void;
}

/** Dependencies of {@link createPlaybackService}. */
export interface PlaybackServiceDeps {
  engine: PlayerEngine;
  clock: PlaybackClock;
  timers: PlaybackTimers;
  config?: Partial<PlaybackConfig>;
  /** @internal Builds the recovery ladder and watchdog; not part of the public API. */
  recovery?: (control: ServiceControl) => RecoveryHooks;
}

/** Creates the playback service over one engine. */
export function createPlaybackService(deps: PlaybackServiceDeps): PlaybackService {
  const { engine, clock, timers } = deps;
  const config: PlaybackConfig = { ...DEFAULT_PLAYBACK_CONFIG, ...deps.config };
  const listeners = new Set<(state: PlaybackState) => void>();
  let state: PlaybackState = { status: { kind: 'idle' }, attempt: 0, staleEventsDropped: 0 };
  let lastRequest: TuneRequest | undefined;
  let loaded = false;
  let disposed = false;
  let startTimer: unknown;

  const update = (patch: Partial<PlaybackState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  };

  const clearStartTimeout = (): void => {
    if (startTimer !== undefined) timers.clearTimeout(startTimer);
    startTimer = undefined;
  };

  const stopEngine = (): void => {
    clearStartTimeout();
    if (loaded || state.status.kind === 'tuning') engine.stop(state.attempt);
    loaded = false;
  };

  const fail = (error: ElvError): void => {
    stopEngine();
    update({ status: { kind: 'failed', error } });
  };

  const control: ServiceControl = {
    engine,
    config,
    now: () => clock.now(),
    getState: () => state,
    currentAttempt: () => state.attempt,
    nextAttempt: () => {
      update({ attempt: state.attempt + 1 });
      return state.attempt;
    },
    setStatus: (status) => update({ status }),
    fail,
    armStartTimeout: (ms) => {
      clearStartTimeout();
      const token = state.attempt;
      startTimer = timers.setTimeout(() => {
        startTimer = undefined;
        if (token === state.attempt) onStartTimeout();
      }, ms);
    },
    clearStartTimeout,
    setTimer: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimer: (handle) => timers.clearTimeout(handle),
  };

  const hooks: RecoveryHooks | undefined = deps.recovery?.(control);

  function onStartTimeout(): void {
    if (hooks) hooks.onStartTimeout?.();
    else fail(toPlaybackError({ code: 'network' }));
  }

  const onEvent = (event: EngineEvent): void => {
    if (event.type === 'surface') {
      hooks?.onSurface?.(event.change);
      return;
    }
    if (event.attempt !== state.attempt) {
      state = { ...state, staleEventsDropped: state.staleEventsDropped + 1 };
      return;
    }
    if (state.status.kind === 'idle' || state.status.kind === 'failed') return;
    switch (event.type) {
      case 'firstFrame':
        clearStartTimeout();
        update({ firstFrameAt: clock.now() });
        return;
      case 'clock':
        update({ anchor: event.anchor });
        return;
      case 'stall':
        hooks?.onStall?.(event.phase);
        return;
      case 'error':
        if (hooks) hooks.onError?.(event.error);
        else fail(toPlaybackError(event.error));
        return;
      case 'state':
        if (event.state === 'playing') update({ status: { kind: 'playing' } });
        else if (event.state === 'paused') update({ status: { kind: 'paused' } });
        else if (event.state === 'ended') update({ status: { kind: 'idle' } });
    }
  };

  const unsubscribeEngine = engine.subscribe(onEvent);

  const startTune = (request: TuneRequest): AttemptToken => {
    clearStartTimeout();
    lastRequest = request;
    loaded = false;
    const token = state.attempt + 1;
    const { anchor: _anchor, firstFrameAt: _firstFrameAt, ...kept } = state;
    state = {
      ...kept,
      status: { kind: 'tuning' },
      attempt: token,
      item: request.item,
      accountKey: request.accountKey,
      tuneAt: clock.now(),
    };
    update({});
    new Promise<Result<StreamRequest>>((settle) => settle(request.resolve())).then(
      (result) => onResolved(token, request, result),
      () => onResolved(token, request, { ok: false, error: elvError('network', 'resolve-failed') }),
    );
    return token;
  };

  function onResolved(
    token: AttemptToken,
    request: TuneRequest,
    result: Result<StreamRequest>,
  ): void {
    if (disposed || token !== state.attempt || state.status.kind !== 'tuning') return;
    if (!result.ok) {
      fail(result.error);
      return;
    }
    loaded = true;
    control.armStartTimeout(config.startTimeoutMs);
    engine.load({
      attempt: token,
      url: result.value.url,
      headers: result.value.headers,
      kind: request.kind,
      ...(request.startMs === undefined ? {} : { startMs: request.startMs }),
    });
  }

  return {
    tune(request) {
      if (disposed) return state.attempt;
      return startTune(request);
    },
    retry() {
      if (disposed || lastRequest === undefined || state.status.kind === 'idle') return;
      if (!loaded) {
        startTune(lastRequest);
        return;
      }
      const token = control.nextAttempt();
      update({ status: { kind: 'tuning' } });
      control.armStartTimeout(config.startTimeoutMs);
      engine.retry(token);
    },
    stop() {
      if (disposed || state.status.kind === 'idle') return;
      stopEngine();
      update({ status: { kind: 'idle' } });
    },
    play() {
      if (!disposed && loaded) engine.play(state.attempt);
    },
    pause() {
      if (!disposed && loaded) engine.pause(state.attempt);
    },
    seek(positionMs) {
      if (!disposed && loaded) engine.seek(state.attempt, positionMs);
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearStartTimeout();
      unsubscribeEngine();
      hooks?.onDispose?.();
      listeners.clear();
    },
  };
}
