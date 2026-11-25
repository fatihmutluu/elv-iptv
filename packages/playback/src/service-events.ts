import type { SubtitleStyleConfig } from '@elv/domain';
import { isAtLiveEdge, positionAt } from './clock';
import { DEFAULT_PLAYBACK_CONFIG, type PlaybackConfig } from './config';
import {
  type AttemptToken,
  type ClockAnchor,
  EMPTY_TRACKS,
  type EngineEvent,
  type ExternalSubtitleTrack,
  type MediaTracks,
  type PlayerEngine,
  type StreamVideoInfo,
} from './engine';
import type { HealthTelemetryRecorder } from './health-telemetry';
import type { RecoveryHooks } from './seam';
import type { SeekCoalescer } from './seek-coalescer';
import { type PlaybackStateStore, sameBufferHealth } from './state-store';
import { clampLiveSeekPosition } from './timeshift';
import type {
  PlaybackClock,
  PlaybackState,
  PlaybackStatus,
  PlaybackTimers,
  TuneRequest,
} from './types';

const IGNORED_IN: ReadonlySet<PlaybackStatus['kind']> = new Set(['idle', 'failed', 'limited']);

export interface StartTimeoutController {
  isArmed(): boolean;
  arm(ms: number): void;
  clear(): void;
  onProgress(bytesReceived?: number): void;
}

/** @internal Manages tune start timeout with bounded byte-progress extensions on VOD (`#314`). */
export function createStartTimeoutController(deps: {
  readonly clock: PlaybackClock;
  readonly timers: PlaybackTimers;
  readonly config: PlaybackConfig;
  currentRequest(): TuneRequest | undefined;
  getState(): PlaybackState;
  onTimeout(): void;
}): StartTimeoutController {
  let timer: unknown;
  let tuningStartedAtMs: number | undefined;
  let lastBytes: number | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) deps.timers.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (ms: number): void => {
    clearTimer();
    const token = deps.getState().attempt;
    timer = deps.timers.setTimeout(() => {
      timer = undefined;
      tuningStartedAtMs = undefined;
      lastBytes = undefined;
      if (token === deps.getState().attempt) deps.onTimeout();
    }, ms);
  };

  return {
    isArmed: () => timer !== undefined,
    arm(ms) {
      tuningStartedAtMs = deps.clock.now();
      lastBytes = undefined;
      schedule(ms);
    },
    clear() {
      clearTimer();
      tuningStartedAtMs = undefined;
      lastBytes = undefined;
    },
    onProgress(bytesReceived) {
      if (
        timer === undefined ||
        tuningStartedAtMs === undefined ||
        deps.currentRequest()?.kind !== 'vod' ||
        deps.getState().status.kind !== 'tuning'
      ) {
        return;
      }
      if (bytesReceived !== undefined) {
        if (!Number.isFinite(bytesReceived) || bytesReceived <= 0) return;
        if (lastBytes !== undefined && bytesReceived <= lastBytes) return;
        lastBytes = bytesReceived;
      }
      const remaining = tuningStartedAtMs + deps.config.vodStartMaxTimeoutMs - deps.clock.now();
      if (remaining <= 0) return;
      schedule(Math.min(deps.config.startTimeoutMs, remaining));
    },
  };
}

export interface EventRouterDeps {
  readonly engine: PlayerEngine;
  readonly clock: PlaybackClock;
  readonly store: PlaybackStateStore;
  readonly seekCoalescer: SeekCoalescer;
  readonly hooks: RecoveryHooks;
  readonly healthTelemetry?: HealthTelemetryRecorder;
  readonly liveEdgeToleranceMs: number;
  readonly reconcileTracks: (tracks: MediaTracks) => {
    readonly audioTrackId?: string;
    readonly subtitleTrackId?: string | null;
    readonly secondarySubtitleTrackId?: string | null;
  };
  currentRequest(): TuneRequest | undefined;
  setLastVodPosition(ms: number): void;
  freezeAnchor(): void;
  clearStartTimeout(): void;
  onVodProgress?(bytesReceived?: number): void;
  onSeekSettled?(): void;
  onEnded?(): void;
}

/** @internal Routes engine events into batched state transitions and recovery hooks (`#224`). */
export function createEngineEventRouter(deps: EventRouterDeps): (event: EngineEvent) => void {
  const { engine, clock, store, seekCoalescer, hooks, liveEdgeToleranceMs } = deps;

  const liveEdgePatch = (anchor: ClockAnchor, nowMs: number): Partial<PlaybackState> =>
    deps.currentRequest()?.kind === 'live'
      ? { atLiveEdge: isAtLiveEdge(anchor, nowMs, liveEdgeToleranceMs) }
      : {};

  return (event: EngineEvent): void => {
    if (event.type === 'surface') {
      hooks.onSurface?.(event.change);
      return;
    }
    const cur = store.getState();
    if (event.attempt !== cur.attempt) {
      store.replace({ ...cur, staleEventsDropped: cur.staleEventsDropped + 1 }, true);
      return;
    }
    if (IGNORED_IN.has(cur.status.kind)) return;

    switch (event.type) {
      case 'firstFrame': {
        const now = clock.now();
        const floor = cur.tuneAt ?? now;
        const at = event.atMs >= floor && event.atMs <= now ? event.atMs : now;
        store.update({ firstFrameAt: cur.firstFrameAt ?? at });
        deps.healthTelemetry?.onFirstFrame(event.atMs);
        return;
      }
      case 'clock': {
        const now = clock.now();
        if (!seekCoalescer.shouldAcceptClock(event.anchor)) {
          const prevAnchor = store.getState().anchor;
          if (
            prevAnchor !== undefined &&
            (event.anchor.durationMs !== prevAnchor.durationMs ||
              event.anchor.liveEdgeMs !== prevAnchor.liveEdgeMs ||
              event.anchor.liveSeekableStartMs !== prevAnchor.liveSeekableStartMs ||
              event.anchor.timeShiftSupported !== prevAnchor.timeShiftSupported ||
              (event.anchor.bufferHealth !== undefined &&
                !sameBufferHealth(event.anchor.bufferHealth, prevAnchor.bufferHealth)))
          ) {
            const mergedAnchor: ClockAnchor = {
              ...prevAnchor,
              ...(event.anchor.durationMs === undefined
                ? {}
                : { durationMs: event.anchor.durationMs }),
              ...(event.anchor.liveEdgeMs === undefined
                ? {}
                : { liveEdgeMs: event.anchor.liveEdgeMs }),
              ...(event.anchor.liveSeekableStartMs === undefined
                ? {}
                : { liveSeekableStartMs: event.anchor.liveSeekableStartMs }),
              ...(event.anchor.timeShiftSupported === undefined
                ? {}
                : { timeShiftSupported: event.anchor.timeShiftSupported }),
              ...(event.anchor.bufferHealth === undefined
                ? {}
                : { bufferHealth: event.anchor.bufferHealth }),
            };
            store.update({ anchor: mergedAnchor, ...liveEdgePatch(mergedAnchor, now) });
          }
          return;
        }
        store.batch(() => {
          const st = store.getState();
          if (
            deps.currentRequest()?.kind === 'vod' &&
            (st.status.kind === 'playing' || event.anchor.rate > 0 || event.anchor.positionMs > 0)
          ) {
            deps.setLastVodPosition(positionAt(event.anchor, now));
          }
          store.update({ anchor: event.anchor, ...liveEdgePatch(event.anchor, now) });
          deps.healthTelemetry?.onClock(event.anchor, now);
          hooks.onClock?.(event.anchor);
        });
        deps.onSeekSettled?.();
        return;
      }
      case 'tracks': {
        const tracks = sanitizeMediaTracks(event.tracks);
        store.update({
          tracks,
          ...(tracks.selectedVideoQualityId === undefined
            ? {}
            : { selectedVideoQualityId: tracks.selectedVideoQualityId }),
        });
        const next = deps.reconcileTracks(tracks);
        const attempt = store.getState().attempt;
        if (next.audioTrackId !== undefined) engine.selectAudioTrack?.(attempt, next.audioTrackId);
        if (
          next.subtitleTrackId !== undefined &&
          next.subtitleTrackId !== null &&
          next.subtitleTrackId === tracks.selectedSecondarySubtitleId &&
          next.secondarySubtitleTrackId === undefined
        ) {
          engine.selectSecondarySubtitleTrack?.(attempt, null);
          store.update({
            tracks: { ...store.getState().tracks, selectedSecondarySubtitleId: null },
          });
        }
        if (next.subtitleTrackId !== undefined) {
          engine.selectSubtitleTrack?.(attempt, next.subtitleTrackId);
        }
        if (next.secondarySubtitleTrackId !== undefined) {
          engine.selectSecondarySubtitleTrack?.(attempt, next.secondarySubtitleTrackId);
        }
        return;
      }
      case 'chapters': {
        const chapters = event.chapters.filter(
          (ch) => typeof ch.id === 'string' && Number.isFinite(ch.startMs) && ch.startMs >= 0,
        );
        store.update({ chapters });
        return;
      }
      case 'mediaInfo': {
        const merged = mergeVideoInfo(cur.videoInfo, event.info);
        const droppedFrames = nonNegativeInt(event.info.droppedFrames);
        if (merged !== undefined || droppedFrames !== undefined) {
          store.update({
            ...(merged === undefined ? {} : { videoInfo: merged }),
            ...(droppedFrames === undefined ? {} : { droppedFrames }),
          });
        }
        return;
      }
      case 'telemetry': {
        const droppedFrames = nonNegativeInt(event.droppedFrames);
        if (droppedFrames !== undefined) {
          const nextVideoInfo =
            cur.videoInfo === undefined ? undefined : { ...cur.videoInfo, droppedFrames };
          store.update({
            droppedFrames,
            ...(nextVideoInfo === undefined ? {} : { videoInfo: nextVideoInfo }),
          });
        }
        return;
      }
      case 'stall':
        deps.healthTelemetry?.onStall(event.phase);
        hooks.onStall?.(event.phase);
        return;
      case 'externalPlayback':
        store.batch(() => {
          store.update({ externalPlaybackActive: event.active });
          hooks.onExternalPlayback?.(event.active);
        });
        return;
      case 'progress':
        deps.onVodProgress?.(event.bytesReceived);
        hooks.onProgress?.(event.atMs, event.bytesReceived);
        return;
      case 'error':
        store.batch(() => {
          deps.healthTelemetry?.onEngineError(event.error);
          hooks.onError?.(event.error);
        });
        return;
      case 'state':
        store.batch(() => {
          if (event.state === 'playing') {
            deps.clearStartTimeout();
            store.update({ status: { kind: 'playing' } });
          } else if (event.state === 'paused') {
            deps.freezeAnchor();
            store.update({ status: { kind: 'paused' } });
          } else if (event.state === 'ended') {
            deps.clearStartTimeout();
            deps.freezeAnchor();
            if (deps.currentRequest()?.kind === 'live' && hooks.onLiveEnded?.() === true) {
              return;
            }
            deps.onEnded?.();
            store.update({ status: { kind: 'ended' } });
          } else {
            const k = store.getState().status.kind;
            if (k === 'paused' || k === 'ended') store.update({ status: { kind: 'tuning' } });
          }
          hooks.onState?.(event.state);
        });
    }
  };
}

/**
 * Computes a clamped seek position against a valid positive `durationMs` (for VOD) or a bounded
 * live time-shift window `[liveSeekableStartMs, liveEdgeMs]` (for live, `#28`), returning
 * `undefined` when seeking at or past EOF on an already-`ended` VOD (`#224`) or when live
 * time-shift is explicitly unsupported (`timeShiftSupported === false`).
 */
export function resolveSeekTarget(
  positionMs: number,
  isVod: boolean,
  statusKind: PlaybackStatus['kind'],
  rawDuration: number | undefined,
  anchor?: ClockAnchor,
  nowMs?: number,
): number | undefined {
  if (!isVod && anchor !== undefined) {
    if (anchor.timeShiftSupported !== undefined || anchor.liveSeekableStartMs !== undefined) {
      return clampLiveSeekPosition(anchor, positionMs, nowMs);
    }
  }
  const validDuration =
    rawDuration !== undefined && Number.isFinite(rawDuration) && rawDuration > 0
      ? rawDuration
      : undefined;
  const clamped = Math.max(
    0,
    validDuration === undefined ? positionMs : Math.min(positionMs, validDuration),
  );
  if (isVod && statusKind === 'ended' && validDuration !== undefined && clamped >= validDuration) {
    return undefined;
  }
  return clamped;
}

export function mergePlaybackConfig(overrides?: Partial<PlaybackConfig>): PlaybackConfig {
  return {
    ...DEFAULT_PLAYBACK_CONFIG,
    ...(overrides?.startTimeoutMs !== undefined && overrides.liveStartTimeoutMs === undefined
      ? { liveStartTimeoutMs: overrides.startTimeoutMs }
      : {}),
    ...overrides,
  };
}

export function buildOptimisticSeekAnchor(
  clamped: number,
  now: number,
  statusKind: PlaybackStatus['kind'],
  prev: ClockAnchor | undefined,
): ClockAnchor {
  return {
    positionMs: clamped,
    atMs: now,
    rate: statusKind === 'playing' ? 1 : 0,
    ...(prev?.durationMs === undefined ? {} : { durationMs: prev.durationMs }),
    ...(prev?.liveEdgeMs === undefined ? {} : { liveEdgeMs: prev.liveEdgeMs }),
    ...(prev?.liveSeekableStartMs === undefined
      ? {}
      : { liveSeekableStartMs: prev.liveSeekableStartMs }),
    ...(prev?.timeShiftSupported === undefined
      ? {}
      : { timeShiftSupported: prev.timeShiftSupported }),
    ...(prev?.isLiveTs === undefined ? {} : { isLiveTs: prev.isLiveTs }),
  };
}

const positiveNumber = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;

const nonNegativeInt = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const cleanCodec = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

function mergeVideoInfo(
  prev: StreamVideoInfo | undefined,
  incoming: StreamVideoInfo,
): StreamVideoInfo | undefined {
  const width = positiveNumber(incoming.width) ?? prev?.width;
  const height = positiveNumber(incoming.height) ?? prev?.height;
  const aspectRatio = positiveNumber(incoming.aspectRatio) ?? prev?.aspectRatio;
  const fps = positiveNumber(incoming.fps) ?? prev?.fps;
  const codec = cleanCodec(incoming.codec) ?? prev?.codec;
  const hdr = incoming.hdr ?? prev?.hdr;
  const droppedFrames = nonNegativeInt(incoming.droppedFrames) ?? prev?.droppedFrames;
  if (
    width === undefined &&
    height === undefined &&
    aspectRatio === undefined &&
    fps === undefined &&
    codec === undefined &&
    hdr === undefined &&
    droppedFrames === undefined
  ) {
    return undefined;
  }
  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(fps === undefined ? {} : { fps }),
    ...(codec === undefined ? {} : { codec }),
    ...(hdr === undefined ? {} : { hdr }),
    ...(droppedFrames === undefined ? {} : { droppedFrames }),
  };
}

function sanitizeMediaTracks(tracks: MediaTracks): MediaTracks {
  const rawSecondary = tracks.selectedSecondarySubtitleId;
  if (rawSecondary === undefined) return tracks;
  const trimmed =
    typeof rawSecondary === 'string' && rawSecondary.trim().length > 0 ? rawSecondary : null;
  const safeSecondary = trimmed !== null && trimmed === tracks.selectedSubtitleId ? null : trimmed;
  if (safeSecondary === rawSecondary) return tracks;
  return { ...tracks, selectedSecondarySubtitleId: safeSecondary };
}

export function nextTuneState(
  prev: PlaybackState,
  token: AttemptToken,
  request: TuneRequest,
  held: boolean,
  now: number,
  externalSubtitles?: readonly ExternalSubtitleTrack[],
  subtitleStyle?: SubtitleStyleConfig,
): PlaybackState {
  const {
    anchor: _a,
    atLiveEdge: _l,
    firstFrameAt: _f,
    videoInfo: _v,
    chapters: _c,
    droppedFrames: _df,
    externalPlaybackActive: _ep,
    externalSubtitles: _es,
    subtitleStyle: _ss,
    ...kept
  } = prev;
  return {
    ...kept,
    status: held ? prev.status : { kind: 'tuning' },
    attempt: token,
    tracks: EMPTY_TRACKS,
    audioDelayMs: 0,
    subtitleDelayMs: 0,
    selectedVideoQualityId: null,
    item: request.item,
    accountKey: request.accountKey,
    tuneAt: now,
    ...(externalSubtitles !== undefined && externalSubtitles.length > 0
      ? { externalSubtitles }
      : {}),
    ...(subtitleStyle === undefined ? {} : { subtitleStyle }),
  };
}
