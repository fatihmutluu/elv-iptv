import type { ClockAnchor } from '@elv/playback';

/** Minimum interval between emitted byte/cache progress events (`#314`). */
export const PROGRESS_THROTTLE_MS = 500;

interface ProgressBody {
  readonly type: 'progress';
  readonly bytesReceived?: number;
  readonly atMs: number;
}

type ClockTelemetryFields = Pick<ClockAnchor, 'hasVideoTrack' | 'decodedVideoFrames'>;

/** Per-media mpv progress and video-frame telemetry tracker. */
export interface MpvTelemetry {
  onCacheState(value: unknown, atMs: number, waiting: boolean): ProgressBody | undefined;
  onCacheDuration(value: unknown, atMs: number, waiting: boolean): ProgressBody | undefined;
  onTrackList(value: unknown): void;
  onVid(value: unknown, loaded: boolean): void;
  onVideoParams(value: unknown): void;
  onEstimatedVfFps(value: unknown, atMs: number): void;
  clockFields(atMs: number, rate: number): ClockTelemetryFields;
}

const nonNegNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tracks throttled demuxer cache progress (`#314`) and rendered video-frame counts (`#321`). */
export function createMpvTelemetry(): MpvTelemetry {
  let lastSeenBytes = 0;
  let lastSeenDuration = 0;
  let cumulativeBytes = 0;
  let lastEmittedBytes = 0;
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  let hasVideoTrack: boolean | undefined;
  let hasVideoParams = false;
  let fpsObserved = false;
  let lastFps = 0;
  let lastFpsAt: number | undefined;
  let decodedFrames = 0;

  const maybeEmitProgress = (
    bytes: number | undefined,
    duration: number | undefined,
    atMs: number,
    waiting: boolean,
  ): ProgressBody | undefined => {
    let bytesAdvanced = false;
    if (bytes !== undefined) {
      if (bytes > lastSeenBytes) {
        cumulativeBytes += bytes - lastSeenBytes;
        bytesAdvanced = true;
      }
      lastSeenBytes = bytes;
    }

    let durationAdvanced = false;
    if (duration !== undefined) {
      if (duration > lastSeenDuration) durationAdvanced = true;
      lastSeenDuration = duration;
    }

    if (!waiting || (!bytesAdvanced && !durationAdvanced)) return undefined;
    if (atMs - lastProgressAt < PROGRESS_THROTTLE_MS) return undefined;

    lastProgressAt = atMs;
    const includeBytes = bytesAdvanced && cumulativeBytes > lastEmittedBytes;
    if (includeBytes) lastEmittedBytes = cumulativeBytes;
    return {
      type: 'progress',
      ...(includeBytes ? { bytesReceived: cumulativeBytes } : {}),
      atMs,
    };
  };

  return {
    onCacheState(value, atMs, waiting) {
      if (!isRecord(value)) return undefined;
      const bytes = nonNegNum(value['total-bytes']) ?? nonNegNum(value['fw-bytes']);
      const duration = nonNegNum(value['cache-duration']) ?? nonNegNum(value['cache-end']);
      return maybeEmitProgress(bytes, duration, atMs, waiting);
    },

    onCacheDuration(value, atMs, waiting) {
      const duration = nonNegNum(value);
      return duration === undefined
        ? undefined
        : maybeEmitProgress(undefined, duration, atMs, waiting);
    },

    onTrackList(value) {
      if (!Array.isArray(value) || value.length === 0) return;
      let foundVideo = false;
      let foundAnyTrack = false;
      for (const entry of value) {
        if (!isRecord(entry)) continue;
        const type = entry['type'];
        if (type === 'video' || type === 'audio' || type === 'sub') foundAnyTrack = true;
        if (type === 'video') foundVideo = true;
      }
      if (foundVideo) hasVideoTrack = true;
      else if (foundAnyTrack) hasVideoTrack = false;
    },

    onVid(value, loaded) {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        hasVideoTrack = true;
      } else if (loaded && (value === false || value === 'no')) {
        hasVideoTrack = false;
      }
    },

    onVideoParams(value) {
      if (isRecord(value)) hasVideoParams = true;
    },

    onEstimatedVfFps(value, atMs) {
      const fps = nonNegNum(value);
      if (fps === undefined) return;
      fpsObserved = true;
      lastFps = fps;
      if (fps > 0) {
        hasVideoTrack = true;
        if (decodedFrames === 0) decodedFrames = 1;
        lastFpsAt ??= atMs;
      }
    },

    clockFields(atMs, rate) {
      if (fpsObserved) {
        if (lastFps > 0 && rate > 0) {
          const elapsedSec = lastFpsAt === undefined ? 0 : Math.max(0, (atMs - lastFpsAt) / 1000);
          if (elapsedSec > 0) {
            decodedFrames += Math.max(1, Math.round(lastFps * elapsedSec * rate));
          }
          lastFpsAt = atMs;
        } else {
          lastFpsAt = atMs;
        }
      }
      const out: ClockTelemetryFields = {};
      if (hasVideoTrack !== undefined) out.hasVideoTrack = hasVideoTrack;
      if (hasVideoTrack === true && (fpsObserved || !hasVideoParams)) {
        out.decodedVideoFrames = decodedFrames;
      }
      return out;
    },
  };
}
