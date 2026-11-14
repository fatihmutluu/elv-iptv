import { type ElvError, elvError, type Result } from '@elv/domain';
import { DEFAULT_PLAYBACK_CONFIG, type PlaybackConfig } from './config';
import type { AttemptToken, EngineEvent, PlayerEngine, StreamRequest } from './engine';
import { createRecovery } from './recovery';
import type { LoadOverrides, RecoveryHooks, ServiceControl } from './seam';
import type {
  PlaybackClock,
  PlaybackService,
  PlaybackState,
  PlaybackStatus,
  PlaybackTimers,
  TuneRequest,
} from './types';

const IGNORED_IN: ReadonlySet<PlaybackStatus['kind']> = new Set(['idle', 'failed', 'limited']);

/** Dependencies of {@link createPlaybackService}. */
export interface PlaybackServiceDeps {
  engine: PlayerEngine;
  clock: PlaybackClock;
  timers: PlaybackTimers;
  config?: Partial<PlaybackConfig>;
}

/**
 * Creates the playback service over one engine, with the recovery ladder, the stall watchdog and the
 * provider connection-limit path (player core spec sections 5.4 and 5.5).
 */
export function createPlaybackService(deps: PlaybackServiceDeps): PlaybackService {
  return createPlaybackServiceWith(deps, createRecovery);
}

/** @internal {@link createPlaybackService} with another recovery, for tests of the seam. */
export function createPlaybackServiceWith(
  deps: PlaybackServiceDeps,
  recovery: (control: ServiceControl) => RecoveryHooks,
): PlaybackService {
  const { engine, clock, timers } = deps;
  const config: PlaybackConfig = { ...DEFAULT_PLAYBACK_CONFIG, ...deps.config };
  const listeners = new Set<(state: PlaybackState) => void>();
  let state: PlaybackState = { status: { kind: 'idle' }, attempt: 0, staleEventsDropped: 0 };
  let current: TuneRequest | undefined;
  let stream: StreamRequest | undefined;
  let loaded = false;
  let held = false;
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
    hooks.onReset?.();
    stopEngine();
    update({ status: { kind: 'failed', error } });
  };

  const sendLoad = (overrides: LoadOverrides = {}): void => {
    if (overrides.stream !== undefined) stream = overrides.stream;
    if (current === undefined || stream === undefined) return;
    const startMs = overrides.startMs ?? current.startMs;
    loaded = true;
    engine.load({
      attempt: state.attempt,
      url: stream.url,
      headers: stream.headers,
      kind: current.kind,
      ...(startMs === undefined ? {} : { startMs }),
      ...(overrides.options === undefined ? {} : { options: overrides.options }),
    });
  };

  const control: ServiceControl = {
    engine,
    config,
    now: () => clock.now(),
    getState: () => state,
    request: () => current,
    nextAttempt: () => {
      update({ attempt: state.attempt + 1 });
      return state.attempt;
    },
    setStatus: (status) => update({ status }),
    load: (overrides) => {
      held = false;
      sendLoad(overrides);
    },
    stopMedia: stopEngine,
    fail,
    armStartTimeout: (ms) => {
      clearStartTimeout();
      const token = state.attempt;
      startTimer = timers.setTimeout(() => {
        startTimer = undefined;
        if (token === state.attempt) hooks.onStartTimeout?.();
      }, ms);
    },
    clearStartTimeout,
    setTimer: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimer: (handle) => timers.clearTimeout(handle),
  };

  const hooks: RecoveryHooks = recovery(control);

  const onEvent = (event: EngineEvent): void => {
    if (event.type === 'surface') {
      hooks.onSurface?.(event.change);
      return;
    }
    if (event.attempt !== state.attempt) {
      state = { ...state, staleEventsDropped: state.staleEventsDropped + 1 };
      return;
    }
    // While limited the media is stopped; its queued events still carry the current token.
    if (IGNORED_IN.has(state.status.kind)) return;
    switch (event.type) {
      case 'firstFrame':
        update({ firstFrameAt: clock.now() });
        return;
      case 'clock':
        update({ anchor: event.anchor });
        return;
      case 'stall':
        hooks.onStall?.(event.phase);
        return;
      case 'error':
        hooks.onError?.(event.error);
        return;
      case 'state':
        if (event.state === 'playing') {
          clearStartTimeout();
          update({ status: { kind: 'playing' } });
        } else if (event.state === 'paused') update({ status: { kind: 'paused' } });
        else if (event.state === 'ended') update({ status: { kind: 'idle' } });
        hooks.onState?.(event.state);
    }
  };

  const unsubscribeEngine = engine.subscribe(onEvent);

  const startTune = (request: TuneRequest): AttemptToken => {
    clearStartTimeout();
    held = hooks.onTune?.(request) ?? false;
    current = request;
    stream = undefined;
    loaded = false;
    const token = state.attempt + 1;
    const { anchor: _anchor, firstFrameAt: _firstFrameAt, ...kept } = state;
    state = {
      ...kept,
      status: held ? state.status : { kind: 'tuning' },
      attempt: token,
      item: request.item,
      accountKey: request.accountKey,
      tuneAt: clock.now(),
    };
    update({});
    new Promise<Result<StreamRequest>>((settle) => settle(request.resolve())).then(
      (result) => onResolved(token, result),
      () => onResolved(token, { ok: false, error: elvError('network', 'resolve-failed') }),
    );
    return token;
  };

  function onResolved(token: AttemptToken, result: Result<StreamRequest>): void {
    const { kind } = state.status;
    if (disposed || token !== state.attempt || (kind !== 'tuning' && kind !== 'limited')) return;
    if (!result.ok) {
      fail(result.error);
      return;
    }
    stream = result.value;
    if (held) return;
    control.armStartTimeout(config.startTimeoutMs);
    sendLoad();
  }

  return {
    tune(request) {
      if (disposed) return state.attempt;
      return startTune(request);
    },
    retry() {
      if (disposed || current === undefined || state.status.kind === 'idle') return;
      if (!loaded) {
        startTune(current);
        return;
      }
      hooks.onReset?.();
      const token = control.nextAttempt();
      update({ status: { kind: 'tuning' } });
      control.armStartTimeout(config.startTimeoutMs);
      engine.retry(token);
    },
    stop() {
      if (disposed || state.status.kind === 'idle') return;
      hooks.onReset?.();
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
      if (disposed || !loaded) return;
      hooks.onSeek?.();
      engine.seek(state.attempt, positionMs);
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
      hooks.onDispose?.();
      listeners.clear();
    },
  };
}
