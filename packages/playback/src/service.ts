import { type ElvError, elvError, type Result } from '@elv/domain';
import { positionAt } from './clock';
import { DEFAULT_PLAYBACK_CONFIG, type PlaybackConfig } from './config';
import {
  type AttemptToken,
  EMPTY_TRACKS,
  type EngineEvent,
  type PlayerEngine,
  type StreamRequest,
} from './engine';
import { createRecovery } from './recovery';
import type { LoadOverrides, RecoveryHooks, ServiceControl } from './seam';
import { createTrackPreferences } from './track-preferences';
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
  let state: PlaybackState = {
    status: { kind: 'idle' },
    attempt: 0,
    tracks: EMPTY_TRACKS,
    staleEventsDropped: 0,
  };
  let current: TuneRequest | undefined;
  let stream: StreamRequest | undefined;
  const trackPrefs = createTrackPreferences();
  let lastVodPositionMs: number | undefined;
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
    const pos = positionAt(anchor, now);
    if (current?.kind === 'vod') lastVodPositionMs = pos;
    update({ anchor: { ...anchor, positionMs: pos, atMs: now, rate: 0 } });
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
    if (current.kind === 'vod' && startMs !== undefined) lastVodPositionMs = startMs;
    trackPrefs.beginReload();
    const mergedOptions = trackPrefs.loadOptions(overrides.options);
    const hasOptions = Object.keys(mergedOptions).length > 0;
    loaded = true;
    mediaOpen = true;
    engine.load({
      attempt: state.attempt,
      url: stream.url,
      headers: stream.headers,
      kind: current.kind,
      ...(startMs === undefined ? {} : { startMs }),
      ...(hasOptions ? { options: mergedOptions } : {}),
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
    setStatus: (status) => {
      if (status.kind === 'recovering') trackPrefs.beginReload();
      update({ status });
    },
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
        if (
          current?.kind === 'vod' &&
          (state.status.kind === 'playing' || event.anchor.rate > 0 || event.anchor.positionMs > 0)
        ) {
          lastVodPositionMs = positionAt(event.anchor, clock.now());
        }
        update({ anchor: event.anchor });
        hooks.onClock?.(event.anchor);
        return;
      case 'tracks': {
        update({ tracks: event.tracks });
        const next = trackPrefs.reconcile(event.tracks);
        if (next.audioTrackId !== undefined) {
          engine.selectAudioTrack?.(state.attempt, next.audioTrackId);
        }
        if (next.subtitleTrackId !== undefined) {
          engine.selectSubtitleTrack?.(state.attempt, next.subtitleTrackId);
        }
        return;
      }
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
      tracks: EMPTY_TRACKS,
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
      trackPrefs.reset();
      lastVodPositionMs = request.kind === 'vod' ? request.startMs : undefined;
      return startTune(request);
    },
    retry() {
      if (disposed || current === undefined || state.status.kind === 'idle') return;
      if (state.status.kind === 'ended') {
        if (current.kind === 'vod') lastVodPositionMs = 0;
        startTune(current.kind === 'vod' ? { ...current, startMs: 0 } : current);
        return;
      }
      if (!loaded) {
        const resumeStartMs =
          current.kind === 'vod' ? (lastVodPositionMs ?? current.startMs) : current.startMs;
        startTune(resumeStartMs === undefined ? current : { ...current, startMs: resumeStartMs });
        return;
      }
      hooks.onReset?.();
      trackPrefs.beginReload();
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
      trackPrefs.reset();
      lastVodPositionMs = undefined;
      const { anchor: _anchor, ...rest } = state;
      state = { ...rest, status: { kind: 'idle' }, tracks: EMPTY_TRACKS };
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
      const reloadableVod =
        current?.kind === 'vod' &&
        (state.status.kind === 'recovering' || state.status.kind === 'ended');
      if (disposed || !Number.isFinite(positionMs) || (!loaded && !reloadableVod)) return;
      const durationMs = state.anchor?.durationMs;
      const clamped = Math.max(
        0,
        durationMs === undefined ? positionMs : Math.min(positionMs, durationMs),
      );
      const now = clock.now();
      update({
        anchor: {
          positionMs: clamped,
          atMs: now,
          rate: state.status.kind === 'playing' ? 1 : 0,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(state.anchor?.liveEdgeMs === undefined
            ? {}
            : { liveEdgeMs: state.anchor.liveEdgeMs }),
        },
      });
      if (current?.kind === 'vod') lastVodPositionMs = clamped;
      const attemptBefore = state.attempt;
      hooks.onSeek?.(clamped);
      if (state.attempt === attemptBefore && loaded) {
        engine.seek(state.attempt, clamped);
      }
    },
    selectAudioTrack(id) {
      if (disposed || current === undefined || state.status.kind === 'idle') return;
      trackPrefs.selectAudio(id, state.tracks, loaded);
      if (loaded) engine.selectAudioTrack?.(state.attempt, id);
    },
    selectSubtitleTrack(id) {
      if (disposed || current === undefined || state.status.kind === 'idle') return;
      trackPrefs.selectSubtitle(id, state.tracks, loaded);
      if (loaded) engine.selectSubtitleTrack?.(state.attempt, id);
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
