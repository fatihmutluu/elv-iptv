import type { ChapterInfo, ClockAnchor } from '@elv/playback';

/** Minimum interval between emitted byte/cache progress events (`#314`). */
export const PROGRESS_THROTTLE_MS = 500;

interface ProgressBody {
  readonly type: 'progress';
  readonly bytesReceived?: number;
  readonly atMs: number;
}

interface TelemetryBody {
  readonly type: 'telemetry';
  readonly droppedFrames: number;
}

interface ChaptersBody {
  readonly type: 'chapters';
  readonly chapters: readonly ChapterInfo[];
}

type ClockTelemetryFields = Pick<ClockAnchor, 'hasVideoTrack' | 'decodedVideoFrames'>;

/** Per-media mpv progress, dropped-frame telemetry (`#160`), chapters (`#118`), and video-frame tracker. */
export interface MpvTelemetry {
  onCacheState(value: unknown, atMs: number, waiting: boolean): ProgressBody | undefined;
  onCacheDuration(value: unknown, atMs: number, waiting: boolean): ProgressBody | undefined;
  onTrackList(value: unknown): void;
  onVid(value: unknown, loaded: boolean): void;
  onVideoParams(value: unknown): void;
  onEstimatedVfFps(value: unknown, atMs: number): void;
  onFrameDropCount(value: unknown): TelemetryBody | undefined;
  onChapterList(value: unknown, durationSec?: number): ChaptersBody | undefined;
  onDurationForChapters(durationSec: number | undefined): ChaptersBody | undefined;
  clockFields(atMs: number, rate: number): ClockTelemetryFields;
}

const nonNegNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses mpv `chapter-list` (`{ title?, time }[]`) into sorted `ChapterInfo[]` with derived `endMs` (`#118`). */
export function parseMpvChapters(value: unknown, durationSec?: number): ChapterInfo[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const rawEntries: Array<{ readonly title?: string; readonly startMs: number }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const sec = nonNegNum(item['time']);
    if (sec === undefined) continue;
    const rawTitle = typeof item['title'] === 'string' ? item['title'].trim() : '';
    rawEntries.push({
      startMs: Math.round(sec * 1000) + 0,
      ...(rawTitle.length > 0 ? { title: rawTitle } : {}),
    });
  }
  if (rawEntries.length === 0) return [];
  rawEntries.sort((a, b) => a.startMs - b.startMs);
  const durationMs =
    durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec * 1000)
      : undefined;
  return rawEntries.map((entry, idx) => {
    const next = rawEntries[idx + 1];
    const candidateEnd = next !== undefined ? next.startMs : durationMs;
    const endMs =
      candidateEnd !== undefined && candidateEnd > entry.startMs ? candidateEnd : undefined;
    return {
      id: `ch:${idx}`,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      startMs: entry.startMs,
      ...(endMs === undefined ? {} : { endMs }),
    };
  });
}

function chaptersEqual(a: readonly ChapterInfo[] | undefined, b: readonly ChapterInfo[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      !x ||
      !y ||
      x.id !== y.id ||
      x.title !== y.title ||
      x.startMs !== y.startMs ||
      x.endMs !== y.endMs
    ) {
      return false;
    }
  }
  return true;
}

/** Tracks throttled demuxer cache progress (`#314`), chapters (`#118`), dropped frames (`#160`), and video frames (`#321`). */
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
  let lastEmittedDroppedFrames = 0;
  let rawChapterList: unknown;
  let lastEmittedChapters: readonly ChapterInfo[] | undefined;

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

    onFrameDropCount(value) {
      const raw = nonNegNum(value);
      if (raw === undefined) return undefined;
      const count = Math.floor(raw);
      if (count <= lastEmittedDroppedFrames) return undefined;
      lastEmittedDroppedFrames = count;
      return { type: 'telemetry', droppedFrames: count };
    },

    onChapterList(value, durationSec) {
      rawChapterList = value;
      const parsed = parseMpvChapters(value, durationSec);
      if (parsed.length === 0 && lastEmittedChapters === undefined) return undefined;
      if (chaptersEqual(lastEmittedChapters, parsed)) return undefined;
      lastEmittedChapters = parsed;
      return { type: 'chapters', chapters: parsed };
    },

    onDurationForChapters(durationSec) {
      if (
        rawChapterList === undefined ||
        !lastEmittedChapters ||
        lastEmittedChapters.length === 0
      ) {
        return undefined;
      }
      const parsed = parseMpvChapters(rawChapterList, durationSec);
      if (chaptersEqual(lastEmittedChapters, parsed)) return undefined;
      lastEmittedChapters = parsed;
      return { type: 'chapters', chapters: parsed };
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
