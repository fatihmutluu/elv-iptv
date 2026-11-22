import { type ClockAnchor, EMPTY_TRACKS, type StreamVideoInfo } from './engine';
import type { PlaybackState, PlaybackStatus } from './types';

function sameStatus(a: PlaybackStatus, b: PlaybackStatus): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'idle':
    case 'tuning':
    case 'playing':
    case 'paused':
    case 'ended':
      return true;
    case 'recovering':
      return b.kind === 'recovering' && a.rung === b.rung && a.nextAtMs === b.nextAtMs;
    case 'limited':
      return b.kind === 'limited' && a.nextAtMs === b.nextAtMs;
    case 'failed':
      return (
        b.kind === 'failed' &&
        a.error.category === b.error.category &&
        a.error.code === b.error.code &&
        a.error.detail === b.error.detail
      );
  }
}

function sameAnchor(a: ClockAnchor | undefined, b: ClockAnchor | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.positionMs === b.positionMs &&
    a.atMs === b.atMs &&
    a.rate === b.rate &&
    a.durationMs === b.durationMs &&
    a.liveEdgeMs === b.liveEdgeMs
  );
}

function sameVideoInfo(a: StreamVideoInfo | undefined, b: StreamVideoInfo | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.fps === b.fps &&
    a.codec === b.codec &&
    a.hdr === b.hdr
  );
}

function samePlaybackState(a: PlaybackState, b: PlaybackState): boolean {
  if (a === b) return true;
  return (
    a.attempt === b.attempt &&
    a.tracks === b.tracks &&
    a.item === b.item &&
    a.accountKey === b.accountKey &&
    a.tuneAt === b.tuneAt &&
    a.firstFrameAt === b.firstFrameAt &&
    a.atLiveEdge === b.atLiveEdge &&
    a.surfaceRecreationToken === b.surfaceRecreationToken &&
    a.externalPlaybackActive === b.externalPlaybackActive &&
    sameStatus(a.status, b.status) &&
    sameAnchor(a.anchor, b.anchor) &&
    sameVideoInfo(a.videoInfo, b.videoInfo)
  );
}

/** @internal Batched, equality-gated state store with isolated subscriber notifications (`#224`). */
export interface PlaybackStateStore {
  getState(): PlaybackState;
  update(patch: Partial<PlaybackState>): void;
  replace(next: PlaybackState, silent?: boolean): void;
  batch<T>(fn: () => T): T;
  subscribe(listener: (state: PlaybackState) => void): () => void;
  clearListeners(): void;
}

export function createPlaybackStateStore(): PlaybackStateStore {
  const listeners = new Set<(state: PlaybackState) => void>();
  let state: PlaybackState = {
    status: { kind: 'idle' },
    attempt: 0,
    tracks: EMPTY_TRACKS,
    staleEventsDropped: 0,
    surfaceRecreationToken: 0,
  };
  let lastNotified: PlaybackState = state;
  let depth = 0;
  let dirty = false;

  const flush = (): void => {
    if (depth > 0 || !dirty) return;
    dirty = false;
    if (samePlaybackState(state, lastNotified)) return;
    lastNotified = state;
    const snapshot = state;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Isolate subscriber exceptions so neither recovery nor peer listeners are skipped.
      }
    }
  };

  return {
    getState: () => state,

    update(patch) {
      state = { ...state, ...patch };
      dirty = true;
      flush();
    },

    replace(next, silent = false) {
      state = next;
      if (silent) return;
      dirty = true;
      flush();
    },

    batch(fn) {
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
        flush();
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    clearListeners() {
      listeners.clear();
    },
  };
}
