import type { ElvError } from '@elv/domain';
import type { ClockAnchor, EngineError, StreamRequest } from './engine';
import { canonicalizeHealthKey, type StreamHealthCache } from './stream-health-cache';
import type { StreamHealthScorer } from './stream-health-scorer';
import type { PlaybackClock, TuneRequest } from './types';

const BUFFER_SAMPLE_INTERVAL_MS = 5_000;

/** @internal Dependencies for {@link createHealthTelemetryRecorder}. */
export interface HealthTelemetryDeps {
  readonly clock: PlaybackClock;
  readonly healthCache?: StreamHealthCache;
  readonly healthScorer: StreamHealthScorer;
  readonly onStreamOutcome?: (stream: StreamRequest, outcome: 'success' | 'failure') => void;
  currentRequest(): TuneRequest | undefined;
  currentStream(): StreamRequest | undefined;
  tuneAt(): number | undefined;
}

/** @internal Records passive health cache, time-decayed scorer, and stream outcome callbacks. */
export interface HealthTelemetryRecorder {
  resetStreamSampling(): void;
  onFirstFrame(eventAtMs: number): void;
  onStall(phase: 'start' | 'end'): void;
  onClock(anchor: ClockAnchor, nowMs: number): void;
  onEngineError(error: EngineError): void;
  onResolveFailure(error: ElvError): void;
  onStartTimeout(): void;
}

function uniqueCacheKeys(item: string | undefined, stream: StreamRequest | undefined): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of [item, stream?.url]) {
    if (raw === undefined) continue;
    const canonical = canonicalizeHealthKey(raw);
    if (canonical !== undefined && !seen.has(canonical)) {
      seen.add(canonical);
      keys.push(canonical);
    }
  }
  return keys;
}

function isTerminalEngineFailure(error: EngineError): boolean {
  if (
    error.code === 'http-404' ||
    error.code === 'http-401' ||
    error.code === 'http-403' ||
    error.code === 'unsupported-format'
  ) {
    return true;
  }
  return error.httpStatus === 404 || error.httpStatus === 401 || error.httpStatus === 403;
}

function isTerminalResolveFailure(error: ElvError): boolean {
  return (
    error.code === 'http-404' ||
    error.code === 'http-401' ||
    error.code === 'http-403' ||
    error.code === 'item-not-found' ||
    error.code === 'unsupported-format'
  );
}

/** @internal Creates the playback health telemetry bridge wired into {@link createPlaybackService}. */
export function createHealthTelemetryRecorder(deps: HealthTelemetryDeps): HealthTelemetryRecorder {
  let lastBufferKey: string | undefined;
  let lastBufferSampleAtMs: number | undefined;
  let firstFrameRecorded = false;

  const scorerKeyOf = (stream: StreamRequest | undefined): string | undefined =>
    stream?.finalUrl ?? stream?.url;

  const recordFailureOutcome = (terminal: boolean): void => {
    const req = deps.currentRequest();
    const activeStream = deps.currentStream();
    if (deps.healthCache !== undefined) {
      for (const key of uniqueCacheKeys(req?.item, activeStream)) {
        deps.healthCache.recordFailure(key, terminal);
      }
    }
    const scorerKey = scorerKeyOf(activeStream);
    if (scorerKey !== undefined) {
      deps.healthScorer.recordFailure(scorerKey, deps.clock.now());
    }
    if (activeStream !== undefined) {
      deps.onStreamOutcome?.(activeStream, 'failure');
    }
  };

  return {
    resetStreamSampling() {
      lastBufferKey = undefined;
      lastBufferSampleAtMs = undefined;
      firstFrameRecorded = false;
    },

    onFirstFrame(eventAtMs) {
      if (firstFrameRecorded) return;
      firstFrameRecorded = true;
      const req = deps.currentRequest();
      const activeStream = deps.currentStream();
      const tuneAt = deps.tuneAt();
      const ttffMs = Math.max(0, eventAtMs - (tuneAt ?? eventAtMs));
      if (deps.healthCache !== undefined) {
        for (const key of uniqueCacheKeys(req?.item, activeStream)) {
          deps.healthCache.recordSuccess(key, ttffMs);
        }
      }
      const scorerKey = scorerKeyOf(activeStream);
      if (scorerKey !== undefined) {
        deps.healthScorer.recordFirstFrame(scorerKey, ttffMs, deps.clock.now());
      }
      if (activeStream !== undefined) {
        deps.onStreamOutcome?.(activeStream, 'success');
      }
    },

    onStall(phase) {
      if (phase !== 'start') return;
      const req = deps.currentRequest();
      const activeStream = deps.currentStream();
      if (deps.healthCache !== undefined) {
        for (const key of uniqueCacheKeys(req?.item, activeStream)) {
          deps.healthCache.recordStall(key);
        }
      }
      const scorerKey = scorerKeyOf(activeStream);
      if (scorerKey !== undefined) {
        deps.healthScorer.recordStall(scorerKey, deps.clock.now());
      }
    },

    onClock(anchor, nowMs) {
      if (
        anchor.liveEdgeMs === undefined ||
        !Number.isFinite(anchor.liveEdgeMs) ||
        !Number.isFinite(anchor.positionMs) ||
        anchor.liveEdgeMs < anchor.positionMs
      ) {
        return;
      }
      const scorerKey = scorerKeyOf(deps.currentStream());
      if (scorerKey === undefined) return;
      const canonical = canonicalizeHealthKey(scorerKey);
      if (canonical === undefined) return;
      if (
        lastBufferKey === canonical &&
        lastBufferSampleAtMs !== undefined &&
        nowMs - lastBufferSampleAtMs < BUFFER_SAMPLE_INTERVAL_MS
      ) {
        return;
      }
      lastBufferKey = canonical;
      lastBufferSampleAtMs = nowMs;
      deps.healthScorer.recordBufferDepth(canonical, anchor.liveEdgeMs - anchor.positionMs, nowMs);
    },

    onEngineError(error) {
      recordFailureOutcome(isTerminalEngineFailure(error));
    },

    onResolveFailure(error) {
      const item = deps.currentRequest()?.item;
      if (deps.healthCache !== undefined && item !== undefined) {
        deps.healthCache.recordFailure(item, isTerminalResolveFailure(error));
      }
    },

    onStartTimeout() {
      recordFailureOutcome(false);
    },
  };
}
