import { type ElvError, elvError, type Result } from '@elv/domain';
import { createWorkingFormatCache } from './backoff';
import { isAtLiveEdge, positionAt } from './clock';
import type { PlaybackConfig } from './config';
import {
  type AttemptToken,
  EMPTY_TRACKS,
  type LoadOptions,
  type PlayerEngine,
  type StreamRequest,
} from './engine';
import { createRecovery } from './recovery';
import type { LoadOverrides, RecoveryHooks, ServiceControl } from './seam';
import { createSeekCoalescer } from './seek-coalescer';
import {
  buildOptimisticSeekAnchor,
  createEngineEventRouter,
  createStartTimeoutController,
  mergePlaybackConfig,
  nextTuneState,
  resolveSeekTarget,
} from './service-events';
import { createSpeedCoalescer, type SpeedCoalescer } from './speed-coalescer';
import { createPlaybackStateStore } from './state-store';
import { createTrackPreferences } from './track-preferences';
import type {
  PlaybackClock,
  PlaybackService,
  PlaybackState,
  PlaybackStatus,
  PlaybackTimers,
  TuneRequest,
} from './types';

const SPEED_BLOCKED = new Set<PlaybackStatus['kind']>(['idle', 'ended', 'recovering']);
const LIVE_TS_EDGE_MARGIN_MS = 3_000;
const LIVE_TS_AT_EDGE_WINDOW_MS = 4_000;

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
  let speedCoalescer!: SpeedCoalescer;
  const seekCoalescer = createSeekCoalescer(clock, timers, config.seekCoalesceMs, () =>
    speedCoalescer.flush(),
  );
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
  let speedAttempt: AttemptToken = 0;
  let scrubbingActive = false;
  let resolveTimer: unknown;

  const state = (): PlaybackState => store.getState();
  const startTimeoutMs = (): number =>
    current?.kind === 'live' ? config.liveStartTimeoutMs : config.startTimeoutMs;
  const startTimeout = createStartTimeoutController({
    clock,
    timers,
    config,
    currentRequest: () => current,
    getState: state,
    onTimeout: () => hooks.onStartTimeout?.(),
  });
  const clearStartTimeout = (): void => startTimeout.clear();
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

  const resetCoalescers = (): void => {
    seekCoalescer.reset();
    speedCoalescer.reset();
  };

  const clearScrubbing = (notifyEngine = true): void => {
    if (!scrubbingActive) return;
    scrubbingActive = false;
    if (notifyEngine && (mediaOpen || loaded)) engine.setScrubbing?.(state().attempt, false);
  };

  const stopEngine = (): void => {
    clearStartTimeout();
    resetCoalescers();
    clearScrubbing();
    if (mediaOpen || loaded || state().status.kind === 'tuning') engine.stop(state().attempt);
    mediaOpen = false;
    loaded = false;
  };

  const fail = (error: ElvError): void =>
    store.batch(() => {
      hooks.onReset?.();
      stopEngine();
      freezeAnchor();
      const { externalPlaybackActive: _ep, ...rest } = state();
      store.replace({ ...rest, status: { kind: 'failed', error } });
    });

  const sendLoad = (overrides: LoadOverrides = {}): boolean => {
    if (overrides.stream !== undefined) stream = overrides.stream;
    if (current === undefined || stream === undefined) return false;
    resetCoalescers();
    clearScrubbing(false);
    const startMs = overrides.startMs ?? current.startMs;
    if (current.kind === 'vod' && startMs !== undefined) lastVodPositionMs = startMs;
    trackPrefs.beginReload();
    const allowLegacyTls = current.allowLegacyTls ?? stream.allowLegacyTls;
    const baseOptions: LoadOptions = {
      ...(current.bufferPreset === undefined ? {} : { bufferPreset: current.bufferPreset }),
      ...(current.decoderMode === undefined ? {} : { decoderMode: current.decoderMode }),
      ...(current.preferHevcOverDolbyVision === undefined
        ? {}
        : { preferHevcOverDolbyVision: current.preferHevcOverDolbyVision }),
      ...(current.filterSdhSubtitles === undefined
        ? {}
        : { filterSdhSubtitles: current.filterSdhSubtitles }),
      ...(allowLegacyTls === undefined ? {} : { allowLegacyTls }),
      ...overrides.options,
    };
    const options = trackPrefs.loadOptions(
      Object.keys(baseOptions).length > 0 ? baseOptions : undefined,
    );
    const curState = state();
    if (
      curState.chapters !== undefined ||
      curState.droppedFrames !== undefined ||
      curState.videoInfo?.droppedFrames !== undefined
    ) {
      const { chapters: _c, droppedFrames: _df, videoInfo, ...rest } = curState;
      if (videoInfo !== undefined) {
        const { droppedFrames: _vdf, ...cleanVideoInfo } = videoInfo;
        store.replace({ ...rest, videoInfo: cleanVideoInfo });
      } else {
        store.replace(rest);
      }
    }
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

  const armStartTimeout = (ms: number): void => startTimeout.arm(ms);

  const nextAttempt = (): AttemptToken => {
    const next = state().attempt + 1;
    store.update({ attempt: next });
    return next;
  };

  const bumpSurfaceRecreationToken = (): number => {
    const next = state().surfaceRecreationToken + 1;
    store.update({ surfaceRecreationToken: next });
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
    bumpSurfaceRecreationToken,
    setStatus: (status) => {
      if (status.kind === 'recovering') {
        trackPrefs.beginReload();
        speedCoalescer.reset();
        clearScrubbing(false);
      }
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

  const speedAllowed = (st: PlaybackState): boolean =>
    !disposed && loaded && !SPEED_BLOCKED.has(st.status.kind);

  speedCoalescer = createSpeedCoalescer({
    timers,
    isSeekPending: () => seekCoalescer.isPending(),
    apply: (rate) => {
      const st = state();
      if (speedAllowed(st) && st.attempt === speedAttempt) engine.setSpeed?.(speedAttempt, rate);
    },
    settleMs: config.seekCoalesceMs,
  });

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
      onVodProgress: (bytes) => startTimeout.onProgress(bytes),
      onSeekSettled: () => speedCoalescer.flush(),
      onEnded: () => clearScrubbing(),
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
    resetCoalescers();
    clearScrubbing();
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

  const performSeek = (positionMs: number): void => {
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
      const prevAnchor = state().anchor;
      const optimisticBase = buildOptimisticSeekAnchor(clamped, now, statusKind, prevAnchor);
      const optimistic =
        prevAnchor?.isLiveTs === undefined
          ? optimisticBase
          : { ...optimisticBase, isLiveTs: prevAnchor.isLiveTs };
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
      resetCoalescers();
      clearScrubbing(false);
      const token = store.batch(() => {
        freezeAnchor();
        hooks.onReset?.();
        trackPrefs.beginReload();
        const next = nextAttempt();
        const { externalPlaybackActive: _ep, droppedFrames: _df, videoInfo, ...rest } = state();
        if (videoInfo !== undefined) {
          const { droppedFrames: _vdf, ...cleanVideoInfo } = videoInfo;
          store.replace({ ...rest, videoInfo: cleanVideoInfo, status: { kind: 'tuning' } });
        } else {
          store.replace({ ...rest, status: { kind: 'tuning' } });
        }
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
      const {
        anchor: _a,
        atLiveEdge: _l,
        videoInfo: _v,
        chapters: _c,
        droppedFrames: _df,
        externalPlaybackActive: _ep,
        ...rest
      } = state();
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
        if (wasPaused && state().status.kind === 'tuning' && !startTimeout.isArmed()) {
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
    seek: performSeek,
    jumpToLiveEdge() {
      const st = state();
      const statusKind = st.status.kind;
      const anchor = st.anchor;
      if (
        disposed ||
        !loaded ||
        current?.kind !== 'live' ||
        statusKind === 'idle' ||
        statusKind === 'ended' ||
        statusKind === 'failed' ||
        statusKind === 'limited' ||
        statusKind === 'recovering' ||
        anchor?.isLiveTs !== true
      ) {
        return false;
      }
      const liveEdgeMs = anchor.liveEdgeMs;
      if (
        liveEdgeMs === undefined ||
        !Number.isFinite(liveEdgeMs) ||
        liveEdgeMs <= LIVE_TS_EDGE_MARGIN_MS
      ) {
        return false;
      }
      const now = clock.now();
      const currentPos = positionAt(anchor, now);
      if (!Number.isFinite(currentPos) || liveEdgeMs - currentPos <= LIVE_TS_AT_EDGE_WINDOW_MS) {
        return false;
      }
      performSeek(Math.max(0, liveEdgeMs - LIVE_TS_EDGE_MARGIN_MS));
      return true;
    },
    setScrubbing(scrubbing) {
      if (disposed || current?.kind !== 'vod') return;
      if (!scrubbing) {
        clearScrubbing();
        return;
      }
      if (!loaded || scrubbingActive) return;
      scrubbingActive = true;
      engine.setScrubbing?.(state().attempt, true);
    },
    setSpeed(rate) {
      const st = state();
      if (!speedAllowed(st)) return;
      speedAttempt = st.attempt;
      speedCoalescer.request(rate);
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
      resetCoalescers();
      unsubscribeEngine();
      if (mediaOpen) stopEngine();
      hooks.onDispose?.();
      store.clearListeners();
    },
  };
}
