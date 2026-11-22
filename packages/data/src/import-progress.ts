import type { ImportOptions, ImportProgress } from './import-types';

type WeightedStage = 'categories' | 'live' | 'movies' | 'series' | 'cleanup';

const STAGE_WEIGHTS: Readonly<Record<WeightedStage, number>> = {
  categories: 10,
  live: 30,
  movies: 30,
  series: 25,
  cleanup: 5,
};

const TOTAL_WEIGHT = 100;
const ASYMPTOTIC_CAP = 0.95;
const ASYMPTOTIC_HALF_POINT = 1_000;

interface StageState {
  done: number;
  fraction: number;
}

/** Monotonic multi-stage progress tracker for concurrent catalog imports (`#197`). */
export interface MonotonicProgressMeter {
  /** Updates `phase` progress and returns an `ImportProgress` with monotonic `done` and `fraction`. */
  report(phase: ImportProgress['phase'], done: number, total?: number): ImportProgress;
  /** Marks `phase` complete (stage fraction = `1`) and returns an `ImportProgress` event. */
  complete(phase: ImportProgress['phase'], done?: number): ImportProgress;
  /** Marks `phase` complete without emitting an event (e.g. for an empty kind). */
  markComplete(phase: ImportProgress['phase']): void;
  /** Current monotonic high-water overall fraction in `[0, 1]`. */
  fraction(): number;
}

const isWeightedStage = (phase: ImportProgress['phase']): phase is WeightedStage =>
  phase in STAGE_WEIGHTS;

function sanitizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function asymptoticFraction(done: number): number {
  if (done <= 0) return 0;
  return ASYMPTOTIC_CAP * (done / (done + ASYMPTOTIC_HALF_POINT));
}

/**
 * Creates a monotonic progress meter tracking weighted stages (`categories: 0.10`, `live: 0.30`,
 * `movies: 0.30`, `series: 0.25`, `cleanup: 0.05`). Uses an asymptotic curve while streaming with
 * unknown totals and clamps both overall `fraction` and per-phase `done` monotonically.
 */
export function createMonotonicProgressMeter(): MonotonicProgressMeter {
  const stages = new Map<ImportProgress['phase'], StageState>();
  let highWater = 0;

  const getStage = (phase: ImportProgress['phase']): StageState => {
    let st = stages.get(phase);
    if (st === undefined) {
      st = { done: 0, fraction: 0 };
      stages.set(phase, st);
    }
    return st;
  };

  const recomputeOverall = (): number => {
    let weighted = 0;
    let allComplete = true;
    for (const [stage, weight] of Object.entries(STAGE_WEIGHTS) as [WeightedStage, number][]) {
      const f = stages.get(stage)?.fraction ?? 0;
      if (f < 1) allComplete = false;
      weighted += weight * f;
    }
    const raw = allComplete ? 1 : Math.min(1, Math.max(0, weighted / TOTAL_WEIGHT));
    if (raw > highWater) highWater = raw;
    return highWater;
  };

  const report = (
    phase: ImportProgress['phase'],
    rawDone: number,
    rawTotal?: number,
  ): ImportProgress => {
    const st = getStage(phase);
    const done = Math.max(st.done, sanitizeCount(rawDone));
    st.done = done;

    let total: number | undefined;
    if (rawTotal !== undefined && Number.isFinite(rawTotal) && rawTotal >= 0) {
      total = Math.max(done, Math.floor(rawTotal));
    }

    if (isWeightedStage(phase)) {
      const next =
        total !== undefined
          ? total > 0
            ? Math.min(1, done / total)
            : 0
          : phase === 'cleanup'
            ? 0
            : asymptoticFraction(done);
      if (next > st.fraction) st.fraction = next;
    }

    const fraction = recomputeOverall();
    return total === undefined ? { phase, done, fraction } : { phase, done, total, fraction };
  };

  const markComplete = (phase: ImportProgress['phase']): void => {
    const st = getStage(phase);
    st.fraction = 1;
    recomputeOverall();
  };

  const complete = (phase: ImportProgress['phase'], rawDone?: number): ImportProgress => {
    const st = getStage(phase);
    if (rawDone !== undefined) {
      st.done = Math.max(st.done, sanitizeCount(rawDone));
    }
    st.fraction = 1;
    const fraction = recomputeOverall();
    if (phase === 'cleanup') {
      return { phase, done: st.done, fraction };
    }
    return { phase, done: st.done, total: st.done, fraction };
  };

  return {
    report,
    complete,
    markComplete,
    fraction: () => highWater,
  };
}

/**
 * Wraps `opts.onProgress` so `cleanup` phase events from `performRun` are enriched with monotonic
 * `fraction` values from `meter` (reaching `1` on final cleanup completion).
 */
export function wrapCleanupProgress(
  opts: ImportOptions,
  meter: MonotonicProgressMeter,
  notifyFn: (o: ImportOptions, p: ImportProgress) => void,
): ImportOptions {
  if (opts.onProgress === undefined) return opts;
  let cleanupCalls = 0;
  return {
    ...opts,
    onProgress: (p) => {
      if (p.phase === 'cleanup') {
        cleanupCalls += 1;
        notifyFn(
          opts,
          cleanupCalls >= 2
            ? meter.complete('cleanup', p.done)
            : meter.report('cleanup', p.done, p.total),
        );
        return;
      }
      notifyFn(opts, p);
    },
  };
}

/**
 * Runs async tasks concurrently with a linked child `AbortController`: any caller abort or first
 * task failure aborts all siblings immediately and awaits full settlement before rethrowing.
 */
export async function runParallelFailFast<
  T extends readonly ((signal: AbortSignal) => Promise<unknown>)[],
>(
  parentSignal: AbortSignal | undefined,
  tasks: readonly [...T],
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });

  let firstError: unknown;
  let hasError = false;
  try {
    const results = await Promise.all(
      tasks.map(async (task) => {
        try {
          return await task(controller.signal);
        } catch (e) {
          if (!hasError) {
            hasError = true;
            firstError = e;
          }
          controller.abort();
          return undefined;
        }
      }),
    );
    if (hasError) throw firstError;
    return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  } finally {
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

/** First-wins ID and `(itemId, categoryId)` placement deduplicator across streaming batches. */
export interface StreamBatchDeduper<T extends { id: number; categoryIds: string[] }> {
  readonly uniqueCount: number;
  readonly placements: number;
  readonly skippedPlaceholders: number;
  readonly uncategorized: boolean;
  wroteAny: boolean;
  consume(
    items: readonly T[],
    onlyCategory: string | undefined,
    keyOf: (id: number) => string,
    uncategorizedId: string,
    skip?: (item: T) => boolean,
  ): {
    entries: { key: string; item: T }[];
    links: [string, string, number][];
    createdUncategorized: boolean;
  };
  reset(): void;
}

/** Creates a streaming batch deduplicator preserving first-wins item metadata and placement order. */
export function createStreamBatchDeduper<
  T extends { id: number; categoryIds: string[] },
>(): StreamBatchDeduper<T> {
  const seen = new Set<number>();
  const skippedIds = new Set<number>();
  const placed = new Set<string>();
  const positions = new Map<string, number>();
  let placements = 0;
  let skippedPlaceholders = 0;
  let uncategorized = false;
  let wroteAny = false;

  return {
    get uniqueCount() {
      return seen.size;
    },
    get placements() {
      return placements;
    },
    get skippedPlaceholders() {
      return skippedPlaceholders;
    },
    get uncategorized() {
      return uncategorized;
    },
    get wroteAny() {
      return wroteAny;
    },
    set wroteAny(v: boolean) {
      wroteAny = v;
    },
    consume(items, onlyCategory, keyOf, uncategorizedId, skip) {
      const entries: { key: string; item: T }[] = [];
      const links: [string, string, number][] = [];
      let createdUncategorized = false;
      for (const item of items) {
        if (skippedIds.has(item.id)) continue;
        const key = keyOf(item.id);
        const isNew = !seen.has(item.id);
        if (isNew) {
          if (skip?.(item)) {
            skippedIds.add(item.id);
            skippedPlaceholders += 1;
            continue;
          }
          seen.add(item.id);
          entries.push({ key, item });
        }
        let cats: readonly string[];
        if (onlyCategory !== undefined) cats = [onlyCategory];
        else if (item.categoryIds.length > 0) cats = item.categoryIds;
        else if (!isNew) continue;
        else {
          if (!uncategorized) {
            uncategorized = true;
            createdUncategorized = true;
          }
          cats = [uncategorizedId];
        }
        for (const category of cats) {
          const placeKey = `${item.id}\0${category}`;
          if (placed.has(placeKey)) continue;
          placed.add(placeKey);
          const position = positions.get(category) ?? 0;
          positions.set(category, position + 1);
          links.push([key, category, position]);
        }
      }
      placements += links.length;
      return { entries, links, createdUncategorized };
    },
    reset() {
      seen.clear();
      skippedIds.clear();
      placed.clear();
      positions.clear();
      placements = 0;
      skippedPlaceholders = 0;
      uncategorized = false;
      wroteAny = false;
    },
  };
}
