import { openAsyncIterator } from '@elv/domain';
import type { ImportProgress } from './import-types';

const TOTAL_WEIGHT = 100;
const STREAM_STAGE_WEIGHT = 95;
const CLEANUP_STAGE_WEIGHT = 5;

/** Default asymptotic cap and scale constant (`1 - exp(-done / scale)`) for unknown-total streams. */
const ASYMPTOTIC_CAP = 0.95;
export const DEFAULT_ASYMPTOTIC_SCALE = 6_000;

/** @internal Clamps non-finite or negative progress counts to non-negative integers. */
export function sanitizeProgressCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** @internal Bounded asymptotic curve `cap * (1 - exp(-done / scale))` for unknown-total streams. */
export function asymptoticProgressFraction(
  done: number,
  scale: number = DEFAULT_ASYMPTOTIC_SCALE,
): number {
  if (done <= 0) return 0;
  return ASYMPTOTIC_CAP * (1 - Math.exp(-done / scale));
}

/** @internal Converts a `[0, 1]` fraction to a strictly non-decreasing integer percent (`0..99`, `100` on complete). */
export function toMonotonicPercent(fraction: number, allComplete: boolean, prev: number): number {
  if (allComplete) return 100;
  const raw = Math.min(99, Math.max(0, Math.round(fraction * 100)));
  return Math.max(raw, prev);
}

/** Monotonic single-stream progress tracker for M3U and XMLTV guide imports (`#65`). */
export interface StreamProgressMeter {
  /** Updates a streaming phase using either known byte progress (`streamTotal > 0`) or an asymptotic curve. */
  reportStream(
    phase: ImportProgress['phase'],
    done: number,
    streamDone: number,
    streamTotal?: number,
  ): ImportProgress;
  /** Marks the streaming scan stage complete (reaching 95% before cleanup commit). */
  completeStream(): void;
  /** Updates a phase count (used by `wrapCleanupProgress` for cleanup start). */
  report(phase: ImportProgress['phase'], done: number, total?: number): ImportProgress;
  /** Completes a phase (reaching `fraction: 1, percent: 100` on `'cleanup'`). */
  complete(phase: ImportProgress['phase'], done?: number): ImportProgress;
  /** Current monotonic high-water overall fraction in `[0, 1]`. */
  fraction(): number;
  /** Current monotonic high-water overall integer percentage in `[0, 100]`. */
  percent(): number;
}

/** Parses a positive integer `Content-Length` header value, or `undefined` when absent/invalid. */
export function parseContentLength(headers: Readonly<Record<string, string>>): number | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'content-length') continue;
    const trimmed = v.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/** Wraps a response byte stream to report cumulative raw wire bytes read while preserving stream cleanup. */
export function trackBodyBytes(
  body: AsyncIterable<Uint8Array>,
  onBytes: (bytesRead: number) => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const iter = openAsyncIterator(body);
      let bytesRead = 0;
      try {
        for (;;) {
          const step = await iter.next();
          if (step.done) break;
          bytesRead += step.value.byteLength;
          onBytes(bytesRead);
          yield step.value;
        }
      } finally {
        await iter.return?.();
      }
    },
  };
}

/**
 * Creates a monotonic single-stream progress meter (`stream: 95%`, `cleanup: 5%`) for M3U and
 * XMLTV guide imports (`#65`). Interpolates accurately when `streamTotal > 0` (e.g. `Content-Length`)
 * and advances smoothly via `1 - exp(-done / scale)` when total length is unknown.
 */
export function createStreamProgressMeter(
  asymptoticScale: number = DEFAULT_ASYMPTOTIC_SCALE,
): StreamProgressMeter {
  const phaseDone = new Map<ImportProgress['phase'], number>();
  let streamFraction = 0;
  let cleanupDone = false;
  let highWater = 0;
  let percentHighWater = 0;

  const updatePhaseDone = (phase: ImportProgress['phase'], rawDone: number): number => {
    const next = Math.max(phaseDone.get(phase) ?? 0, sanitizeProgressCount(rawDone));
    phaseDone.set(phase, next);
    return next;
  };

  const recompute = (): { fraction: number; percent: number } => {
    const allComplete = streamFraction >= 1 && cleanupDone;
    const weighted =
      streamFraction * STREAM_STAGE_WEIGHT + (cleanupDone ? CLEANUP_STAGE_WEIGHT : 0);
    const raw = allComplete ? 1 : Math.min(1, Math.max(0, weighted / TOTAL_WEIGHT));
    if (raw > highWater) highWater = raw;
    percentHighWater = toMonotonicPercent(highWater, allComplete, percentHighWater);
    return { fraction: highWater, percent: percentHighWater };
  };

  return {
    reportStream(phase, rawDone, rawStreamDone, rawStreamTotal) {
      const done = updatePhaseDone(phase, rawDone);
      const streamCount = sanitizeProgressCount(rawStreamDone);
      const stageFrac =
        rawStreamTotal !== undefined && Number.isFinite(rawStreamTotal) && rawStreamTotal > 0
          ? Math.min(1, streamCount / Math.floor(rawStreamTotal))
          : asymptoticProgressFraction(streamCount, asymptoticScale);
      if (stageFrac > streamFraction) streamFraction = stageFrac;
      const { fraction, percent } = recompute();
      return { phase, done, fraction, percent };
    },
    completeStream() {
      streamFraction = 1;
      recompute();
    },
    report(phase, rawDone, rawTotal) {
      const done = updatePhaseDone(phase, rawDone);
      const { fraction, percent } = recompute();
      if (rawTotal !== undefined && Number.isFinite(rawTotal) && rawTotal >= 0) {
        return { phase, done, total: Math.max(done, Math.floor(rawTotal)), fraction, percent };
      }
      return { phase, done, fraction, percent };
    },
    complete(phase, rawDone) {
      const done =
        rawDone === undefined ? (phaseDone.get(phase) ?? 0) : updatePhaseDone(phase, rawDone);
      if (phase === 'cleanup') {
        streamFraction = 1;
        cleanupDone = true;
      }
      const { fraction, percent } = recompute();
      return phase === 'cleanup'
        ? { phase, done, fraction, percent }
        : { phase, done, total: done, fraction, percent };
    },
    fraction: () => highWater,
    percent: () => percentHighWater,
  };
}
