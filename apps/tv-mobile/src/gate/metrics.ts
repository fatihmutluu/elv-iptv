import type { FrameWindow } from '@elv/ui-kit';

/** Counters a gate run reports next to the latency summary. */
export interface GateCounts {
  moves: number;
  coalesced: number;
  losses: number;
  items: number;
}

/** What the single `ELV_GATE` line carries. Times are milliseconds rounded to 0.01. */
export interface GateMetrics extends GateCounts {
  keyToHighlightMs: { p50: number; p95: number; max: number };
  maxJsGapMs: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Nearest-rank percentile of an ascending array: the value at rank `ceil(p * n)` (1-based); 0 when empty. */
function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/** A stalled frame is discounted by this share of the typical frame time: vsync slips of that size occur on an idle app. */
const VSYNC_SLACK = 0.7;

/**
 * Evidence of a long JS task from animation frames. A task of L ms started x ms after a frame callback delays the next
 * callback to x + L, so the slowest frame delta bounds the longest task from above and (delta - frame time) from below.
 * The estimate is the slowest delta minus 0.7 of the median delta (the typical frame time), which keeps idle
 * vsync jitter (deltas up to about 1.5 frames on the emulator) below 16 ms while a 30 ms task reads 16 ms or more. The
 * resolution is about one frame: a 20 ms task reads 16 ms or more only when it starts late in a frame. 0 without frames.
 */
function frameStall(deltas: readonly number[]): number {
  if (deltas.length === 0) return 0;
  const sorted = [...deltas].sort((a, b) => a - b);
  const typical = sorted[sorted.length >> 1] ?? 0;
  return Math.max(0, (sorted[sorted.length - 1] ?? 0) - VSYNC_SLACK * typical);
}

/**
 * Summarizes key-to-highlight `samples` (ms) with nearest-rank p50/p95 and the maximum, and the event-loop `gaps`
 * (ms: the longest JS task candidates) with their maximum. Inputs are not modified.
 */
export function summarize(
  samples: readonly number[],
  gaps: readonly number[],
  counts: GateCounts,
): GateMetrics {
  const sorted = [...samples].sort((a, b) => a - b);
  let maxGap = 0;
  for (const g of gaps) if (g > maxGap) maxGap = g;
  return {
    moves: counts.moves,
    coalesced: counts.coalesced,
    losses: counts.losses,
    keyToHighlightMs: {
      p50: round(nearestRank(sorted, 0.5)),
      p95: round(nearestRank(sorted, 0.95)),
      max: round(sorted[sorted.length - 1] ?? 0),
    },
    maxJsGapMs: round(maxGap),
    items: counts.items,
  };
}

/** The log line the gate runner greps for: `ELV_GATE ` followed by the metrics as one-line JSON. */
export function gateLine(m: GateMetrics): string {
  return `ELV_GATE ${JSON.stringify(m)}`;
}

/** Collects the samples and counters of one gate run. Hot paths only push numbers and bump counters. */
export interface Recorder {
  /** A move changed the focused index; `t0` is the key time (ms). */
  move(t0: number): void;
  /** A repeat was dropped because the previous move had not committed yet. */
  coalesce(): void;
  /** A move was dispatched at `t` (ms); ignored while an earlier dispatch still waits for its commit. */
  workStart(t: number): void;
  /** A React commit of the list finished at `t`; the synchronous work since `workStart` is a JS task sample. */
  workEnd(t: number): void;
  /** The time (ms) between two consecutive animation frames while the run was active. */
  frameDelta(ms: number): void;
  /** A frame showing `window` committed `index` at `t1` while the store's current index was `current`. */
  commit(t1: number, index: number, current: number, window: FrameWindow): void;
  /** Resolves pending moves at `t1` when their net effect left the index unchanged, so no frame was reported. */
  resolve(t1: number): void;
  /** Moves waiting for a committed frame. */
  pending(): number;
  /** Summarizes the run, settles the losses, and resets the recorder for the next run. */
  finish(): GateMetrics;
}

/**
 * Creates a recorder for a list of `items`. Loss rule, evaluated per run: a committed frame whose focused index is
 * outside `[0, items)`, outside the visible window it reported, or outside the rows it rendered is one loss; when the
 * run settles, a last committed index that differs from the store's current index is one loss; every move that never
 * got a committed frame is one loss.
 */
export function createRecorder(geometry: { items: number }): Recorder {
  let samples: number[] = [];
  let gaps: number[] = [];
  let deltas: number[] = [];
  let workAt: number | undefined;
  let pendingT0: number[] = [];
  let moves = 0;
  let coalesced = 0;
  let losses = 0;
  let settled: { index: number; current: number } | undefined;

  return {
    move(t0) {
      moves++;
      pendingT0.push(t0);
    },
    coalesce() {
      coalesced++;
    },
    workStart(t) {
      workAt ??= t;
    },
    workEnd(t) {
      if (workAt === undefined) return;
      gaps.push(t - workAt);
      workAt = undefined;
    },
    frameDelta(ms) {
      deltas.push(ms);
    },
    commit(t1, index, current, window) {
      for (const t0 of pendingT0) samples.push(t1 - t0);
      pendingT0.length = 0;
      if (
        index < 0 ||
        index >= geometry.items ||
        index < window.start ||
        index >= window.end ||
        index < window.renderedStart ||
        index >= window.renderedEnd
      ) {
        losses++;
      }
      settled = { index, current };
    },
    resolve(t1) {
      workAt = undefined;
      for (const t0 of pendingT0) samples.push(t1 - t0);
      pendingT0.length = 0;
    },
    pending: () => pendingT0.length,
    finish() {
      let total = losses + pendingT0.length;
      if (settled !== undefined && settled.index !== settled.current) total++;
      const result = summarize(samples, [...gaps, frameStall(deltas)], {
        moves,
        coalesced,
        losses: total,
        items: geometry.items,
      });
      samples = [];
      gaps = [];
      deltas = [];
      workAt = undefined;
      pendingT0 = [];
      moves = 0;
      coalesced = 0;
      losses = 0;
      settled = undefined;
      return result;
    },
  };
}
