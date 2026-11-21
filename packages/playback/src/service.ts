import { type ElvError, elvError, type Result } from '@elv/domain';
import { createWorkingFormatCache } from './backoff';
import { isAtLiveEdge, positionAt } from './clock';
import type { PlaybackConfig } from './config';
import { type AttemptToken, EMPTY_TRACKS, type PlayerEngine, type StreamRequest } from './engine';
import { createRecovery } from './recovery';
import type { LoadOverrides, RecoveryHooks, ServiceControl } from './seam';
import { createSeekCoalescer } from './seek-coalescer';
import {
  buildOptimisticSeekAnchor,
  createEngineEventRouter,
  mergePlaybackConfig,
  nextTuneState,
  resolveSeekTarget,
} from './service-events';
import { createPlaybackStateStore } from './state-store';
import { createTrackPreferences } from './track-preferences';
import type {
  PlaybackClock,
  PlaybackService,
  PlaybackState,
  PlaybackTimers,
  TuneRequest,
} from './types';

/** Dependencies of {@link createPlaybackService}. */
export interface PlaybackServiceDeps {
  engine: PlayerEngine;
  clock: PlaybackClock;
  timers: PlaybackTimers;
  config?: Partial<PlaybackConfig>;
}

/** Creates the playback service over one engine (player core spec sections 5.4 and 5.5). */
export function createPlaybackService(deps: PlaybackServiceDeps): PlaybackService {
  return createPlaybackServiceWith(deps, createRecovery);
}

/** @internal {@link createPlaybackService} with another recovery, for tests of the seam. */
export function createPlaybackServiceWith(
  deps: PlaybackServiceDeps,
  recovery: (control: ServiceControl) => RecoveryHooks,
): PlaybackService {
  const { engine, clock, timers } = deps;
  const config = mergePlaybackConfig(deps.config);
  const store = createPlaybackStateStore();
  const seekCoalescer = createSeekCoalescer(clock, timers, config.seekCoalesceMs);
  const formatCache = createWorkingFormatCache();
  const trackPrefs = createTrackPreferences();

  let current: TuneRequest | undefined;
  let stream: StreamRequest | undefined;
  let lastVodPositionMs: number | undefined;
  let loaded = false;
  let mediaOpen = false;
  let held = false;
  let disposed = false;
  let loadSeq = 0;
  let startTimer: unknown;
  let resolveTimer: unknown;

  const state = (): PlaybackState => store.getState();
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

  const freezeAnchor = (): void => {
    const { anchor } = state();
    if (anchor === undefined || anchor.rate === 0) return;
    const now = clock.now();
    const pos = positionAt(anchor, now);
    if (current?.kind === 'vod') lastVodPositionMs = pos;
    const frozen = { ...anchor, positionMs: pos, atMs: now, rate: 0 };
    store.update({
      anchor: frozen,
      ...(current?.kind === 'live'
        ? { atLiveEdge: isAtLiveEdge(frozen, now, config.liveEdgeToleranceMs) }
        : {}),
    });
  };

  const stopEngine = (): void => {
    clearStartTimeout();
    seekCoalescer.reset();
    if (mediaOpen || loaded || state().status.kind === 'tuning') engine.stop(state().attempt);
    mediaOpen = false;
    loaded = false;
  };

  const fail = (error: ElvError): void =>
    store.batch(() => {
      hooks.onReset?.();
      stopEngine();
      freezeAnchor();
      store.update({ status: { kind: 'failed', error } });
    });

  const sendLoad = (overrides: LoadOverrides = {}): boolean => {
    if (overrides.stream !== undefined) stream = overrides.stream;
    if (current === undefined || stream === undefined) return false;
    seekCoalescer.reset();
    const startMs = overrides.startMs ?? current.startMs;
    if (current.kind === 'vod' && startMs !== undefined) lastVodPositionMs = startMs;
    trackPrefs.beginReload();
    const options = trackPrefs.loadOptions(overrides.options);
    loaded = true;
    mediaOpen = true;
    loadSeq += 1;
    engine.load({
      attempt: state().attempt,
      url: stream.url,
      headers: stream.headers,
      kind: current.kind,
      ...(startMs === undefined ? {} : { startMs }),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    });
    return true;
  };

  const armStartTimeout = (ms: number): void => {
    clearStartTimeout();
    const token = state().attempt;
    startTimer = timers.setTimeout(() => {
      startTimer = undefined;
      if (token === state().attempt) hooks.onStartTimeout?.();
    }, ms);
  };

  const nextAttempt = (): AttemptToken => {
    const next = state().attempt + 1;
    store.update({ attempt: next });
    return next;
  };

  const control: ServiceControl = {
    engine,
    config,
    formatCache,
    now: () => clock.now(),
    getState: state,
    request: () => current,
    stream: () => stream,
    isLoaded: () => loaded,
    batch: (fn) => store.batch(fn),
    startTimeoutMs,
    nextAttempt,
    setStatus: (status) => {
      if (status.kind === 'recovering') trackPrefs.beginReload();
      store.update({ status });
    },
    freezeAnchor,
    load: (overrides) => {
      held = false;
      return sendLoad(overrides);
    },
    stopMedia: stopEngine,
    fail,
    armStartTimeout,
    clearStartTimeout,
    setTimer: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimer: (handle) => timers.clearTimeout(handle),
  };

  const hooks: RecoveryHooks = recovery(control);
  const unsubscribeEngine = engine.subscribe(
    createEngineEventRouter({
      engine,
      clock,
      store,
      seekCoalescer,
      hooks,
      liveEdgeToleranceMs: config.liveEdgeToleranceMs,
      reconcileTracks: (t) => trackPrefs.reconcile(t),
      currentRequest: () => current,
      setLastVodPosition: (ms) => {
        lastVodPositionMs = ms;
      },
      freezeAnchor,
      clearStartTimeout,
    }),
  );

  function onResolved(token: AttemptToken, result: Result<StreamRequest>): void {
    if (token === state().attempt) clearResolveTimeout();
    const { kind } = state().status;
    if (disposed || token !== state().attempt || (kind !== 'tuning' && kind !== 'limited')) return;
    if (!result.ok) {
      fail(result.error);
      return;
    }
    stream =
      current?.kind === 'live' ? formatCache.apply(current.accountKey, result.value) : result.value;
    if (held) return;
    armStartTimeout(startTimeoutMs());
    sendLoad();
  }

  const startTune = (request: TuneRequest): AttemptToken => {
    clearStartTimeout();
    seekCoalescer.reset();
    held = hooks.onTune?.(request) ?? false;
    current = request;
    stream = undefined;
    loaded = false;
    const prev = state();
    const token = prev.attempt + 1;
    store.replace(nextTuneState(prev, token, request, held, clock.now()));
    clearResolveTimeout();
    resolveTimer = timers.setTimeout(() => {
      resolveTimer = undefined;
      onResolved(token, { ok: false, error: elvError('network', 'timeout') });
    }, config.resolveTimeoutMs);
    new Promise<Result<StreamRequest>>((settle) => settle(request.resolve())).then(
      (res) => onResolved(token, res),
      () => onResolved(token, { ok: false, error: elvError('network', 'resolve-failed') }),
    );
    return token;
  };

  const replayFromZero = (req: TuneRequest): void => {
    if (req.kind === 'vod') lastVodPositionMs = 0;
    startTune(req.kind === 'vod' ? { ...req, startMs: 0 } : req);
  };

  return {
    tune(request) {
      if (disposed) return state().attempt;
      trackPrefs.reset();
      lastVodPositionMs = request.kind === 'vod' ? request.startMs : undefined;
      return startTune(request);
    },
    retry() {
      if (disposed || current === undefined || state().status.kind === 'idle') return;
      if (state().status.kind === 'ended') {
        replayFromZero(current);
        return;
      }
      if (!loaded) {
        const resumeMs =
          current.kind === 'vod' ? (lastVodPositionMs ?? current.startMs) : current.startMs;
        startTune(resumeMs === undefined ? current : { ...current, startMs: resumeMs });
        return;
      }
      seekCoalescer.reset();
      const token = store.batch(() => {
        freezeAnchor();
        hooks.onReset?.();
        trackPrefs.beginReload();
        const next = nextAttempt();
        store.update({ status: { kind: 'tuning' } });
        return next;
      });
      armStartTimeout(startTimeoutMs());
      engine.retry(token);
    },
    stop() {
      if (disposed || state().status.kind === 'idle') return;
      hooks.onReset?.();
      clearResolveTimeout();
      stopEngine();
      trackPrefs.reset();
      lastVodPositionMs = undefined;
      const { anchor: _a, atLiveEdge: _l, ...rest } = state();
      store.replace({ ...rest, status: { kind: 'idle' }, tracks: EMPTY_TRACKS });
    },
    play() {
      if (disposed || current === undefined) return;
      const kind = state().status.kind;
      if (kind === 'ended') {
        replayFromZero(current);
        return;
      }
      if (!loaded && kind !== 'paused') return;
      store.batch(() => {
        const wasPaused = kind === 'paused';
        const token = nextAttempt();
        const loadsBefore = loadSeq;
        hooks.onPlay?.();
        if (!loaded || state().attempt !== token || loadSeq !== loadsBefore) return;
        if (wasPaused && state().status.kind === 'paused')
          store.update({ status: { kind: 'tuning' } });
        engine.play(token);
        if (wasPaused && state().status.kind === 'tuning' && startTimer === undefined) {
          armStartTimeout(startTimeoutMs());
        }
      });
    },
    pause() {
      if (disposed || (!loaded && state().status.kind !== 'recovering')) return;
      seekCoalescer.reset();
      store.batch(() => {
        const wasLoaded = loaded;
        const token = nextAttempt();
        freezeAnchor();
        hooks.onPause?.();
        if (wasLoaded && loaded) engine.pause(token);
      });
    },
    seek(positionMs) {
      const statusKind = state().status.kind;
      const reloadableVod =
        current?.kind === 'vod' && (statusKind === 'recovering' || statusKind === 'ended');
      if (disposed || !Number.isFinite(positionMs) || (!loaded && !reloadableVod)) return;
      const clamped = resolveSeekTarget(
        positionMs,
        current?.kind === 'vod',
        statusKind,
        state().anchor?.durationMs,
      );
      if (clamped === undefined) return;
      store.batch(() => {
        const now = clock.now();
        const optimistic = buildOptimisticSeekAnchor(clamped, now, statusKind, state().anchor);
        store.update({
          anchor: optimistic,
          ...(current?.kind === 'live'
            ? { atLiveEdge: isAtLiveEdge(optimistic, now, config.liveEdgeToleranceMs) }
            : {}),
        });
        if (current?.kind === 'vod') lastVodPositionMs = clamped;
        const attemptBefore = state().attempt;
        hooks.onSeek?.(clamped);
        if (state().attempt === attemptBefore && loaded) {
          const seekAttempt = state().attempt;
          seekCoalescer.request(clamped, (targetMs) => {
            if (!disposed && loaded && state().attempt === seekAttempt) {
              engine.seek(seekAttempt, targetMs);
            }
          });
        }
      });
    },
    selectAudioTrack(id) {
      if (disposed || current === undefined || state().status.kind === 'idle') return;
      trackPrefs.selectAudio(id, state().tracks, loaded);
      if (loaded) engine.selectAudioTrack?.(state().attempt, id);
    },
    selectSubtitleTrack(id) {
      if (disposed || current === undefined || state().status.kind === 'idle') return;
      trackPrefs.selectSubtitle(id, state().tracks, loaded);
      if (loaded) engine.selectSubtitleTrack?.(state().attempt, id);
    },
    getState: state,
    subscribe: (listener) => store.subscribe(listener),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearStartTimeout();
      clearResolveTimeout();
      seekCoalescer.reset();
      unsubscribeEngine();
      if (mediaOpen) stopEngine();
      hooks.onDispose?.();
      store.clearListeners();
    },
  };
}
