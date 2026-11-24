import { canonicalizeHealthKey } from './stream-health-cache';
import type { PlaybackClock } from './types';

/** Default LRU capacity for {@link createStreamHealthScorer} (`#195`). */
export const DEFAULT_HEALTH_SCORER_MAX_ENTRIES = 300;

/** Default exponential decay half-life (15 minutes) for runtime stream scores (`#195`). */
export const DEFAULT_HEALTH_SCORER_HALF_LIFE_MS = 15 * 60 * 1_000;

/** Score difference below which {@link StreamHealthScorer.rankAlternates} preserves user priority order (`#195`, `#157`). */
export const HEALTH_SCORE_TIE_TOLERANCE = 0.01;

const MIN_SCORE = -12;
const MAX_SCORE = 4;
const MIN_BUFFER_ADJUSTMENT = -0.5;
const MAX_BUFFER_ADJUSTMENT = 0.5;
const STALL_DELTA = -1.5;
const FAILURE_DELTA = -3.0;
const BUFFER_HEALTHY_MS = 4_000;
const BUFFER_LOW_MS = 1_000;
const BUFFER_HEALTHY_DELTA = 0.25;
const BUFFER_LOW_DELTA = -0.35;
const DEFAULT_CLOCK: PlaybackClock = { now: () => Date.now() };

/** Configuration options for {@link createStreamHealthScorer}. */
export interface StreamHealthScorerOptions {
  readonly maxEntries?: number;
  readonly halfLifeMs?: number;
  readonly clock?: PlaybackClock;
}

/** Bounded exponentially time-decayed runtime stream health scorer used to rank Rung-4 alternates (`#195`). */
export interface StreamHealthScorer {
  recordStall(key: string, nowMs?: number): number;
  recordFailure(key: string, nowMs?: number): number;
  recordFirstFrame(key: string, ttffMs: number, nowMs?: number): number;
  recordBufferDepth(key: string, bufferMs: number, nowMs?: number): number;
  score(key: string, nowMs?: number): number;
  rankAlternates<T>(
    items: readonly T[],
    keyOf: (item: T) => string | undefined,
    nowMs?: number,
  ): T[];
  size(): number;
  clear(): void;
}

interface ScorerEntry {
  readonly coreScore: number;
  readonly bufferScore: number;
  readonly updatedAtMs: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function ttffDelta(ttffMs: number): number {
  if (ttffMs <= 1_500) return 0.8;
  if (ttffMs <= 3_000) return 0.3;
  if (ttffMs <= 5_000) return 0;
  return -0.8;
}

function bufferDelta(bufferMs: number): number {
  if (bufferMs >= BUFFER_HEALTHY_MS) return BUFFER_HEALTHY_DELTA;
  if (bufferMs < BUFFER_LOW_MS) return BUFFER_LOW_DELTA;
  return 0;
}

/** Creates a bounded (`300`-entry) exponentially time-decayed stream health scorer (`#195`). */
export function createStreamHealthScorer(opts?: StreamHealthScorerOptions): StreamHealthScorer {
  const maxEntries = positiveIntOr(opts?.maxEntries, DEFAULT_HEALTH_SCORER_MAX_ENTRIES);
  const halfLifeMs = positiveIntOr(opts?.halfLifeMs, DEFAULT_HEALTH_SCORER_HALF_LIFE_MS);
  const clock = opts?.clock ?? DEFAULT_CLOCK;
  const entries = new Map<string, ScorerEntry>();

  const decayEntry = (
    entry: ScorerEntry | undefined,
    now: number,
  ): { coreScore: number; bufferScore: number } => {
    if (entry === undefined) return { coreScore: 0, bufferScore: 0 };
    const dt = Math.max(0, now - entry.updatedAtMs);
    if (dt === 0) return { coreScore: entry.coreScore, bufferScore: entry.bufferScore };
    const factor = 0.5 ** (dt / halfLifeMs);
    return {
      coreScore: entry.coreScore * factor,
      bufferScore: entry.bufferScore * factor,
    };
  };

  const combinedScore = (coreScore: number, bufferScore: number): number =>
    clamp(coreScore + bufferScore, MIN_SCORE, MAX_SCORE);

  const upsert = (canonical: string, entry: ScorerEntry): number => {
    entries.delete(canonical);
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
    entries.set(canonical, entry);
    return combinedScore(entry.coreScore, entry.bufferScore);
  };

  const applyCoreDelta = (key: string, delta: number, nowMs?: number): number => {
    const canonical = canonicalizeHealthKey(key);
    if (canonical === undefined) return 0;
    const now = nowMs ?? clock.now();
    const decayed = decayEntry(entries.get(canonical), now);
    const nextCore = clamp(decayed.coreScore + delta, MIN_SCORE, MAX_SCORE);
    return upsert(canonical, {
      coreScore: nextCore,
      bufferScore: decayed.bufferScore,
      updatedAtMs: now,
    });
  };

  const readScore = (key: string, nowMs?: number): number => {
    const canonical = canonicalizeHealthKey(key);
    if (canonical === undefined) return 0;
    const existing = entries.get(canonical);
    if (existing === undefined) return 0;
    const now = nowMs ?? clock.now();
    const decayed = decayEntry(existing, now);
    return combinedScore(decayed.coreScore, decayed.bufferScore);
  };

  return {
    recordStall: (key, nowMs) => applyCoreDelta(key, STALL_DELTA, nowMs),
    recordFailure: (key, nowMs) => applyCoreDelta(key, FAILURE_DELTA, nowMs),

    recordFirstFrame(key, ttffMs, nowMs) {
      if (!Number.isFinite(ttffMs) || ttffMs < 0) return readScore(key, nowMs);
      return applyCoreDelta(key, ttffDelta(ttffMs), nowMs);
    },

    recordBufferDepth(key, bufferMs, nowMs) {
      if (!Number.isFinite(bufferMs) || bufferMs < 0) return readScore(key, nowMs);
      const canonical = canonicalizeHealthKey(key);
      if (canonical === undefined) return 0;
      const now = nowMs ?? clock.now();
      const decayed = decayEntry(entries.get(canonical), now);
      const delta = bufferDelta(bufferMs);
      const nextBuffer = clamp(
        decayed.bufferScore + delta,
        MIN_BUFFER_ADJUSTMENT,
        MAX_BUFFER_ADJUSTMENT,
      );
      return upsert(canonical, {
        coreScore: decayed.coreScore,
        bufferScore: nextBuffer,
        updatedAtMs: now,
      });
    },

    score: readScore,

    rankAlternates<T>(
      items: readonly T[],
      keyOf: (item: T) => string | undefined,
      nowMs?: number,
    ): T[] {
      if (items.length <= 1) return [...items];
      const now = nowMs ?? clock.now();
      const annotated = items.map((item, index) => {
        const key = keyOf(item);
        return { item, index, value: key === undefined ? 0 : readScore(key, now) };
      });
      annotated.sort((a, b) => {
        const diff = b.value - a.value;
        if (Math.abs(diff) < HEALTH_SCORE_TIE_TOLERANCE) {
          return a.index - b.index;
        }
        return diff > 0 ? 1 : -1;
      });
      return annotated.map((entry) => entry.item);
    },

    size: () => entries.size,
    clear: () => entries.clear(),
  };
}
