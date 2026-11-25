import { normalizeSubtitleStyle } from '@elv/domain';
import {
  type AttemptToken,
  clampLiveSeekPosition,
  clampPlaybackSpeed,
  clampSyncDelayMs,
  EMPTY_TRACKS,
  type EngineEvent,
  type ExternalSubtitleTrack,
  isAtLiveEdge,
  LIVE_EDGE_TOLERANCE_MS,
  normalizeExternalSubtitleTrack,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackState,
  type PlaybackTimers,
  type PlayerEngine,
  positionAt,
  resolveLiveTimeShiftWindow,
  type StreamVideoInfo,
  toPlaybackError,
} from '@elv/playback';
import type { PlayTarget } from '../ports/play-target';

/** Options for {@link createAdoptedPlaybackService}. */
export interface AdoptedPlaybackServiceParams {
  readonly engine: PlayerEngine;
  readonly clock: PlaybackClock;
  readonly timers: PlaybackTimers;
  readonly target: PlayTarget;
  readonly createDelegateService: () => PlaybackService;
}

function mergeVideoInfo(
  prev: StreamVideoInfo | undefined,
  incoming: StreamVideoInfo,
): StreamVideoInfo {
  return {
    ...(prev ?? {}),
    ...incoming,
  };
}

/**
 * Wraps an already-playing cross-window adopted {@link PlayerEngine} (`Wave P3`) in a full
 * {@link PlaybackService} interface without invoking `tune()` or `engine.load()`.
 *
 * Synchronizes `activeAttempt` from incoming engine events so transport, track, sync, and seek
 * commands match the donor window's live stream, and seamlessly upgrades to a standard
 * `PlaybackService` if the user later tunes a new target or reloads.
 */
export function createAdoptedPlaybackService({
  engine,
  clock,
  target,
  createDelegateService,
}: AdoptedPlaybackServiceParams): PlaybackService {
  const listeners = new Set<(state: PlaybackState) => void>();
  let delegate: PlaybackService | null = null;
  let unsubscribeDelegate: (() => void) | null = null;
  let disposed = false;
  let activeAttempt: AttemptToken = 1;
  let currentKind: 'live' | 'vod' = target.kind;
  let currentStartPositionMs: number | undefined = target.startPositionMs;
  let externalSubtitles: readonly ExternalSubtitleTrack[] = Object.freeze([]);

  let state: PlaybackState = {
    status: { kind: 'playing' },
    attempt: activeAttempt,
    tracks: EMPTY_TRACKS,
    item: target.itemKey,
    accountKey: target.accountKey ?? target.sourceId,
    staleEventsDropped: 0,
    surfaceRecreationToken: 0,
    audioDelayMs: 0,
    subtitleDelayMs: 0,
    selectedVideoQualityId: null,
  };

  const emit = (next: PlaybackState): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      listener(next);
    }
  };

  const updateState = (patch: Partial<PlaybackState>): void => {
    state = { ...state, ...patch };
    emit(state);
  };

  const freezeAnchor = (): void => {
    if (state.anchor === undefined || state.anchor.rate === 0) return;
    const now = clock.now();
    const pos = positionAt(state.anchor, now);
    const frozen = { ...state.anchor, positionMs: pos, atMs: now, rate: 0 };
    state = {
      ...state,
      anchor: frozen,
      ...(currentKind === 'live'
        ? { atLiveEdge: isAtLiveEdge(frozen, now, LIVE_EDGE_TOLERANCE_MS) }
        : {}),
    };
  };

  const handleEngineEvent = (event: EngineEvent): void => {
    if (disposed || delegate !== null) return;
    if (event.type === 'surface') return;
    activeAttempt = event.attempt;
    if (state.attempt !== activeAttempt) {
      state = { ...state, attempt: activeAttempt };
    }
    switch (event.type) {
      case 'clock': {
        const now = clock.now();
        updateState({
          anchor: event.anchor,
          ...(currentKind === 'live'
            ? { atLiveEdge: isAtLiveEdge(event.anchor, now, LIVE_EDGE_TOLERANCE_MS) }
            : {}),
        });
        return;
      }
      case 'tracks': {
        updateState({
          tracks: event.tracks,
          ...(event.tracks.selectedVideoQualityId !== undefined
            ? { selectedVideoQualityId: event.tracks.selectedVideoQualityId }
            : {}),
        });
        return;
      }
      case 'mediaInfo': {
        const droppedFrames =
          event.info.droppedFrames !== undefined &&
          Number.isFinite(event.info.droppedFrames) &&
          event.info.droppedFrames >= 0
            ? Math.floor(event.info.droppedFrames)
            : undefined;
        updateState({
          videoInfo: mergeVideoInfo(state.videoInfo, event.info),
          ...(droppedFrames !== undefined ? { droppedFrames } : {}),
        });
        return;
      }
      case 'chapters': {
        updateState({ chapters: event.chapters });
        return;
      }
      case 'telemetry': {
        const rawDropped = event.droppedFrames;
        if (rawDropped !== undefined && Number.isFinite(rawDropped) && rawDropped >= 0) {
          const dropped = Math.floor(rawDropped);
          updateState({
            droppedFrames: dropped,
            ...(state.videoInfo !== undefined
              ? { videoInfo: { ...state.videoInfo, droppedFrames: dropped } }
              : {}),
          });
        }
        return;
      }
      case 'externalPlayback': {
        updateState({ externalPlaybackActive: event.active });
        return;
      }
      case 'error': {
        freezeAnchor();
        updateState({ status: { kind: 'failed', error: toPlaybackError(event.error) } });
        return;
      }
      case 'state': {
        if (event.state === 'playing') {
          updateState({ status: { kind: 'playing' } });
        } else if (event.state === 'paused') {
          freezeAnchor();
          updateState({ status: { kind: 'paused' } });
        } else if (event.state === 'ended') {
          freezeAnchor();
          updateState({ status: { kind: 'ended' } });
        } else if (state.status.kind === 'paused' || state.status.kind === 'ended') {
          updateState({ status: { kind: 'tuning' } });
        }
        return;
      }
      default:
        return;
    }
  };

  let unsubscribeEngine: (() => void) | null = engine.subscribe(handleEngineEvent);

  const upgradeToDelegate = (): PlaybackService => {
    if (delegate !== null) return delegate;
    unsubscribeEngine?.();
    unsubscribeEngine = null;
    const nextDelegate = createDelegateService();
    delegate = nextDelegate;
    unsubscribeDelegate = nextDelegate.subscribe((next) => emit(next));
    return nextDelegate;
  };

  const performSeek = (positionMs: number): void => {
    if (disposed || !Number.isFinite(positionMs)) return;
    if (delegate !== null) {
      delegate.seek(positionMs);
      return;
    }
    const now = clock.now();
    const prev = state.anchor;
    const duration = prev?.durationMs;
    const clamped =
      currentKind === 'live' && prev !== undefined
        ? (clampLiveSeekPosition(prev, positionMs, now) ?? Math.max(0, positionMs))
        : Math.max(
            0,
            duration !== undefined && duration > 0 ? Math.min(positionMs, duration) : positionMs,
          );
    const optimistic = {
      ...(prev ?? {}),
      positionMs: clamped,
      atMs: now,
      rate: state.status.kind === 'playing' ? 1 : 0,
    };
    updateState({
      anchor: optimistic,
      ...(currentKind === 'live'
        ? { atLiveEdge: isAtLiveEdge(optimistic, now, LIVE_EDGE_TOLERANCE_MS) }
        : {}),
    });
    engine.seek(activeAttempt, clamped);
  };

  const normalizeExternalSubtitles = (
    list: readonly ExternalSubtitleTrack[] | undefined,
  ): readonly ExternalSubtitleTrack[] => {
    if (list === undefined || list.length === 0) return Object.freeze([]);
    const out: ExternalSubtitleTrack[] = [];
    for (const track of list) {
      const clean = normalizeExternalSubtitleTrack(track);
      if (clean === null) continue;
      if (out.some((e) => e.id === clean.id || e.uri === clean.uri)) continue;
      out.push(clean);
    }
    return Object.freeze(out);
  };

  return {
    tune(request) {
      if (disposed) return state.attempt;
      return upgradeToDelegate().tune(request);
    },
    adoptQueuedTarget(request, stream) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.adoptQueuedTarget(request, stream);
        return;
      }
      currentKind = request.kind;
      currentStartPositionMs = request.startMs;
      externalSubtitles = normalizeExternalSubtitles(request.externalSubtitles);
      const nextSubtitleStyle =
        request.subtitleStyle !== undefined
          ? normalizeSubtitleStyle(request.subtitleStyle)
          : state.subtitleStyle;
      const {
        anchor: _a,
        atLiveEdge: _l,
        firstFrameAt: _f,
        videoInfo: _v,
        chapters: _c,
        droppedFrames: _df,
        externalSubtitles: _es,
        subtitleStyle: _ss,
        ...rest
      } = state;
      state = {
        ...rest,
        attempt: activeAttempt,
        tracks: EMPTY_TRACKS,
        audioDelayMs: 0,
        subtitleDelayMs: 0,
        selectedVideoQualityId: null,
        item: request.item,
        accountKey: request.accountKey,
        tuneAt: clock.now(),
        ...(externalSubtitles.length > 0 ? { externalSubtitles } : {}),
        ...(nextSubtitleStyle !== undefined ? { subtitleStyle: nextSubtitleStyle } : {}),
      };
      emit(state);
    },
    retry() {
      if (disposed) return;
      if (delegate !== null) {
        delegate.retry();
        return;
      }
      updateState({ status: { kind: 'tuning' } });
      engine.retry(activeAttempt);
    },
    stop() {
      if (disposed) return;
      if (delegate !== null) {
        delegate.stop();
        return;
      }
      engine.stop(activeAttempt);
      const {
        anchor: _a,
        atLiveEdge: _l,
        videoInfo: _v,
        chapters: _c,
        droppedFrames: _df,
        externalPlaybackActive: _ep,
        externalSubtitles: _es,
        ...rest
      } = state;
      state = {
        ...rest,
        status: { kind: 'idle' },
        tracks: EMPTY_TRACKS,
        audioDelayMs: 0,
        subtitleDelayMs: 0,
        selectedVideoQualityId: null,
      };
      emit(state);
    },
    play() {
      if (disposed) return;
      if (delegate !== null) {
        delegate.play();
        return;
      }
      updateState({ status: { kind: 'playing' } });
      engine.play(activeAttempt);
    },
    pause() {
      if (disposed) return;
      if (delegate !== null) {
        delegate.pause();
        return;
      }
      freezeAnchor();
      updateState({ status: { kind: 'paused' } });
      engine.pause(activeAttempt);
    },
    seek: performSeek,
    seekBy(deltaMs) {
      if (disposed || !Number.isFinite(deltaMs)) return;
      if (delegate !== null) {
        delegate.seekBy?.(deltaMs);
        return;
      }
      const now = clock.now();
      if (currentKind === 'live') {
        const win = resolveLiveTimeShiftWindow(state.anchor, now);
        if (win === null) return;
        const targetMs = clampLiveSeekPosition(state.anchor, win.positionMs + deltaMs, now);
        if (targetMs !== undefined) performSeek(targetMs);
        return;
      }
      const basePos =
        state.anchor !== undefined ? positionAt(state.anchor, now) : (currentStartPositionMs ?? 0);
      performSeek(basePos + deltaMs);
    },
    jumpToLiveEdge() {
      if (disposed) return false;
      if (delegate !== null) return delegate.jumpToLiveEdge();
      const liveEdgeMs = state.anchor?.liveEdgeMs;
      if (currentKind !== 'live' || liveEdgeMs === undefined) return false;
      if (engine.jumpToLiveEdge !== undefined) {
        engine.jumpToLiveEdge(activeAttempt);
        updateState({ atLiveEdge: true });
        return true;
      }
      performSeek(liveEdgeMs);
      return true;
    },
    setScrubbing(scrubbing) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.setScrubbing?.(scrubbing);
        return;
      }
      engine.setScrubbing?.(activeAttempt, scrubbing);
    },
    setSpeed(rate) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.setSpeed(rate);
        return;
      }
      const clampedRate = clampPlaybackSpeed(rate);
      if (clampedRate !== undefined) engine.setSpeed?.(activeAttempt, clampedRate);
    },
    selectAudioTrack(id) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.selectAudioTrack(id);
        return;
      }
      engine.selectAudioTrack?.(activeAttempt, id);
    },
    selectSubtitleTrack(id) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.selectSubtitleTrack(id);
        return;
      }
      engine.selectSubtitleTrack?.(activeAttempt, id);
    },
    selectSecondarySubtitleTrack(id) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.selectSecondarySubtitleTrack(id);
        return;
      }
      const normalized = typeof id === 'string' && id.trim().length > 0 ? id : null;
      engine.selectSecondarySubtitleTrack?.(activeAttempt, normalized);
    },
    addExternalSubtitle(track) {
      if (disposed) return false;
      if (delegate !== null) return delegate.addExternalSubtitle(track);
      const clean = normalizeExternalSubtitleTrack(track);
      if (clean === null) return false;
      if (externalSubtitles.some((e) => e.id === clean.id || e.uri === clean.uri)) return false;
      const next = Object.freeze([...externalSubtitles, clean]);
      externalSubtitles = next;
      updateState({ externalSubtitles: next });
      engine.addExternalSubtitle?.(activeAttempt, clean);
      return true;
    },
    setSubtitleStyle(style) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.setSubtitleStyle(style);
        return;
      }
      const clean = normalizeSubtitleStyle(style);
      updateState({ subtitleStyle: clean });
      engine.setSubtitleStyle?.(clean);
    },
    setAudioDelay(delayMs) {
      if (disposed || !Number.isFinite(delayMs)) return;
      if (delegate !== null) {
        delegate.setAudioDelay(delayMs);
        return;
      }
      const clamped = clampSyncDelayMs(delayMs);
      updateState({ audioDelayMs: clamped });
      engine.setAudioDelay?.(activeAttempt, clamped);
    },
    setSubtitleDelay(delayMs) {
      if (disposed || !Number.isFinite(delayMs)) return;
      if (delegate !== null) {
        delegate.setSubtitleDelay(delayMs);
        return;
      }
      const clamped = clampSyncDelayMs(delayMs);
      updateState({ subtitleDelayMs: clamped });
      engine.setSubtitleDelay?.(activeAttempt, clamped);
    },
    selectVideoQuality(id) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.selectVideoQuality(id);
        return;
      }
      const normalized = typeof id === 'string' && id.trim().length > 0 ? id : null;
      updateState({ selectedVideoQualityId: normalized });
      engine.selectVideoQuality?.(activeAttempt, normalized);
    },
    selectProgram(id) {
      if (disposed) return;
      if (delegate !== null) {
        delegate.selectProgram?.(id);
        return;
      }
      const trimmed = typeof id === 'string' ? id.trim() : '';
      if (trimmed.length > 0) engine.selectProgram?.(activeAttempt, trimmed);
    },
    getState: () => (delegate !== null ? delegate.getState() : state),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeEngine?.();
      unsubscribeEngine = null;
      unsubscribeDelegate?.();
      unsubscribeDelegate = null;
      if (delegate !== null) {
        delegate.dispose();
      } else if (state.status.kind !== 'idle') {
        engine.stop(activeAttempt);
      }
      listeners.clear();
    },
  };
}
