import { type ElvError, elvError, type Result } from '@elv/domain';
import { positionAt } from './clock';
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
  const config: PlaybackConfig = {
    ...DEFAULT_PLAYBACK_CONFIG,
    ...(deps.config?.startTimeoutMs !== undefined && deps.config.liveStartTimeoutMs === undefined
      ? { liveStartTimeoutMs: deps.config.startTimeoutMs }
      : {}),
    ...deps.config,
  };
  const listeners = new Set<(state: PlaybackState) => void>();
  let state: PlaybackState = { status: { kind: 'idle' }, attempt: 0, staleEventsDropped: 0 };
  let current: TuneRequest | undefined;
  let stream: StreamRequest | undefined;
  let loaded = false;
  let mediaOpen = false;
  let held = false;
  let disposed = false;
  let startTimer: unknown;
  let resolveTimer: unknown;

  const notify = (): void => {
    for (const listener of [...listeners]) listener(state);
  };

  const update = (patch: Partial<PlaybackState>): void => {
    state = { ...state, ...patch };
    notify();
  };

  const freezeAnchor = (): void => {
    const { anchor } = state;
    if (anchor === undefined || anchor.rate === 0) return;
    const now = clock.now();
    update({ anchor: { ...anchor, positionMs: positionAt(anchor, now), atMs: now, rate: 0 } });
  };

  const startTimeoutMs = (): number =>
    current?.kind === 'live' ? config.liveStartTimeoutMs : config.startTimeoutMs;

  const clearStartTimeout = (): void => {
    if (startTimer !== undefined) timers.clearTimeout(startTimer);
    startTimer = undefined;
  };

  const clearResolveTimeout = (): void => {
    if (resolveTimer !== undefined) timers.clearTimeout(resolveTimer);
    resolveTimer = undefined;
  };

  const stopEngine = (): void => {
    clearStartTimeout();
    if (mediaOpen || loaded || state.status.kind === 'tuning') engine.stop(state.attempt);
    mediaOpen = false;
    loaded = false;
  };

  const fail = (error: ElvError): void => {
    hooks.onReset?.();
    stopEngine();
    freezeAnchor();
    update({ status: { kind: 'failed', error } });
  };

  const sendLoad = (overrides: LoadOverrides = {}): void => {
    if (overrides.stream !== undefined) stream = overrides.stream;
    if (current === undefined || stream === undefined) return;
    const startMs = overrides.startMs ?? current.startMs;
    loaded = true;
    mediaOpen = true;
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
    startTimeoutMs,
    nextAttempt: () => {
      update({ attempt: state.attempt + 1 });
      return state.attempt;
    },
    setStatus: (status) => update({ status }),
    freezeAnchor,
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
    if (IGNORED_IN.has(state.status.kind)) return;
    switch (event.type) {
      case 'firstFrame': {
        const now = clock.now();
        const floor = state.tuneAt ?? now;
        const at = event.atMs >= floor && event.atMs <= now ? event.atMs : now;
        update({ firstFrameAt: state.firstFrameAt ?? at });
        return;
      }
      case 'clock':
        update({ anchor: event.anchor });
        hooks.onClock?.(event.anchor);
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
        } else if (event.state === 'paused') {
          freezeAnchor();
          update({ status: { kind: 'paused' } });
        } else if (event.state === 'ended') {
          clearStartTimeout();
          freezeAnchor();
          update({ status: { kind: 'ended' } });
        } else if (state.status.kind === 'paused' || state.status.kind === 'ended') {
          update({ status: { kind: 'tuning' } });
        }
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
    notify();
    clearResolveTimeout();
    resolveTimer = timers.setTimeout(() => {
      resolveTimer = undefined;
      onResolved(token, { ok: false, error: elvError('network', 'timeout') });
    }, config.resolveTimeoutMs);
    new Promise<Result<StreamRequest>>((settle) => settle(request.resolve())).then(
      (result) => onResolved(token, result),
      () => onResolved(token, { ok: false, error: elvError('network', 'resolve-failed') }),
    );
    return token;
  };

  function onResolved(token: AttemptToken, result: Result<StreamRequest>): void {
    if (token === state.attempt) clearResolveTimeout();
    const { kind } = state.status;
    if (disposed || token !== state.attempt || (kind !== 'tuning' && kind !== 'limited')) return;
    if (!result.ok) {
      fail(result.error);
      return;
    }
    stream = result.value;
    if (held) return;
    control.armStartTimeout(startTimeoutMs());
    sendLoad();
  }

  return {
    tune(request) {
      if (disposed) return state.attempt;
      return startTune(request);
    },
    retry() {
      if (disposed || current === undefined || state.status.kind === 'idle') return;
      if (state.status.kind === 'ended') {
        startTune(current.kind === 'vod' ? { ...current, startMs: 0 } : current);
        return;
      }
      if (!loaded) {
        startTune(current);
        return;
      }
      hooks.onReset?.();
      const token = control.nextAttempt();
      update({ status: { kind: 'tuning' } });
      control.armStartTimeout(startTimeoutMs());
      engine.retry(token);
    },
    stop() {
      if (disposed || state.status.kind === 'idle') return;
      hooks.onReset?.();
      clearResolveTimeout();
      stopEngine();
      const { anchor: _anchor, ...rest } = state;
      state = { ...rest, status: { kind: 'idle' } };
      notify();
    },
    play() {
      if (disposed || (!loaded && state.status.kind !== 'paused')) return;
      const stopped = state.status.kind === 'paused' || state.status.kind === 'ended';
      const token = control.nextAttempt();
      if (stopped) update({ status: { kind: 'tuning' } });
      engine.play(token);
      if (stopped && startTimer === undefined) control.armStartTimeout(startTimeoutMs());
      hooks.onPlay?.();
    },
    pause() {
      if (disposed || (!loaded && state.status.kind !== 'recovering')) return;
      const token = control.nextAttempt();
      freezeAnchor();
      hooks.onPause?.();
      engine.pause(token);
    },
    seek(positionMs) {
      if (disposed || !loaded) return;
      hooks.onSeek?.(positionMs);
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
      clearResolveTimeout();
      unsubscribeEngine();
      if (mediaOpen) stopEngine();
      hooks.onDispose?.();
      listeners.clear();
    },
  };
}
