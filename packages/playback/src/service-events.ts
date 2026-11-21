import { isAtLiveEdge, positionAt } from './clock';
import { DEFAULT_PLAYBACK_CONFIG, type PlaybackConfig } from './config';
import {
  type AttemptToken,
  type ClockAnchor,
  EMPTY_TRACKS,
  type EngineEvent,
  type MediaTracks,
  type PlayerEngine,
} from './engine';
import type { RecoveryHooks } from './seam';
import type { SeekCoalescer } from './seek-coalescer';
import type { PlaybackStateStore } from './state-store';
import type { PlaybackClock, PlaybackState, PlaybackStatus, TuneRequest } from './types';

const IGNORED_IN: ReadonlySet<PlaybackStatus['kind']> = new Set(['idle', 'failed', 'limited']);

export interface EventRouterDeps {
  readonly engine: PlayerEngine;
  readonly clock: PlaybackClock;
  readonly store: PlaybackStateStore;
  readonly seekCoalescer: SeekCoalescer;
  readonly hooks: RecoveryHooks;
  readonly liveEdgeToleranceMs: number;
  readonly reconcileTracks: (tracks: MediaTracks) => {
    readonly audioTrackId?: string;
    readonly subtitleTrackId?: string | null;
  };
  currentRequest(): TuneRequest | undefined;
  setLastVodPosition(ms: number): void;
  freezeAnchor(): void;
  clearStartTimeout(): void;
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
        return;
      }
      case 'clock': {
        const now = clock.now();
        if (!seekCoalescer.shouldAcceptClock(event.anchor)) {
          const prevAnchor = store.getState().anchor;
          if (
            prevAnchor !== undefined &&
            (event.anchor.durationMs !== prevAnchor.durationMs ||
              event.anchor.liveEdgeMs !== prevAnchor.liveEdgeMs)
          ) {
            const mergedAnchor: ClockAnchor = {
              ...prevAnchor,
              ...(event.anchor.durationMs === undefined
                ? {}
                : { durationMs: event.anchor.durationMs }),
              ...(event.anchor.liveEdgeMs === undefined
                ? {}
                : { liveEdgeMs: event.anchor.liveEdgeMs }),
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
          hooks.onClock?.(event.anchor);
        });
        return;
      }
      case 'tracks': {
        store.update({ tracks: event.tracks });
        const next = deps.reconcileTracks(event.tracks);
        const attempt = store.getState().attempt;
        if (next.audioTrackId !== undefined) engine.selectAudioTrack?.(attempt, next.audioTrackId);
        if (next.subtitleTrackId !== undefined) {
          engine.selectSubtitleTrack?.(attempt, next.subtitleTrackId);
        }
        return;
      }
      case 'stall':
        hooks.onStall?.(event.phase);
        return;
      case 'error':
        store.batch(() => {
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
 * Computes a clamped seek position against a valid positive `durationMs` and returns `undefined`
 * when seeking at or past EOF on an already-`ended` VOD (`#224` / seek EOF guard).
 */
export function resolveSeekTarget(
  positionMs: number,
  isVod: boolean,
  statusKind: PlaybackStatus['kind'],
  rawDuration: number | undefined,
): number | undefined {
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
  };
}

export function nextTuneState(
  prev: PlaybackState,
  token: AttemptToken,
  request: TuneRequest,
  held: boolean,
  now: number,
): PlaybackState {
  const { anchor: _a, atLiveEdge: _l, firstFrameAt: _f, ...kept } = prev;
  return {
    ...kept,
    status: held ? prev.status : { kind: 'tuning' },
    attempt: token,
    tracks: EMPTY_TRACKS,
    item: request.item,
    accountKey: request.accountKey,
    tuneAt: now,
  };
}
