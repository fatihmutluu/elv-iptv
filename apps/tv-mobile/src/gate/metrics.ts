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

/**
 * Summarizes key-to-highlight `samples` (ms) with nearest-rank p50/p95 and the maximum, and the event-loop `gaps`
 * (ms over the 4 ms sampling interval) with their maximum. Inputs are not modified.
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

/** First visible item of the list window when `index` is focused (mirrors `TvList`'s window rule). */
export function windowStart(
  index: number,
  count: number,
  visibleRows: number,
  focusLine: number,
): number {
  return Math.min(Math.max(index - focusLine, 0), Math.max(0, count - visibleRows));
}

/** List geometry the recorder uses to check that a committed index is on screen. */
export interface RecorderGeometry {
  items: number;
  visibleRows: number;
  focusLine: number;
}

/** Collects the samples and counters of one gate run. Hot paths only push numbers and bump counters. */
export interface Recorder {
  /** A move changed the focused index; `t0` is the key time (ms). */
  move(t0: number): void;
  /** A repeat was dropped because the previous move had not committed yet. */
  coalesce(): void;
  /** One event-loop sample: the lag in ms beyond the sampling interval. */
  gap(ms: number): void;
  /** A frame committed `index` at `t1` while the store's current index was `current`. */
  commit(t1: number, index: number, current: number): void;
  /** Moves waiting for a committed frame. */
  pending(): number;
  /** Summarizes the run, settles the losses, and resets the recorder for the next run. */
  finish(): GateMetrics;
}

/**
 * Creates a recorder. Loss rule, evaluated per run: a committed frame whose index is not on screen (outside
 * `[0, items)` or, equivalently, outside the window `[windowStart, windowStart + visibleRows)`) is one loss; when
 * the run settles, a last committed index that differs from the store's current index is one loss; every move that
 * never got a committed frame is one loss.
 */
export function createRecorder(geometry: RecorderGeometry): Recorder {
  let samples: number[] = [];
  let gaps: number[] = [];
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
    gap(ms) {
      gaps.push(ms);
    },
    commit(t1, index, current) {
      for (const t0 of pendingT0) samples.push(t1 - t0);
      pendingT0.length = 0;
      const start = windowStart(index, geometry.items, geometry.visibleRows, geometry.focusLine);
      if (
        index < 0 ||
        index >= geometry.items ||
        index < start ||
        index >= start + geometry.visibleRows
      ) {
        losses++;
      }
      settled = { index, current };
    },
    pending: () => pendingT0.length,
    finish() {
      let total = losses + pendingT0.length;
      if (settled !== undefined && settled.index !== settled.current) total++;
      const result = summarize(samples, gaps, {
        moves,
        coalesced,
        losses: total,
        items: geometry.items,
      });
      samples = [];
      gaps = [];
      pendingT0 = [];
      moves = 0;
      coalesced = 0;
      losses = 0;
      settled = undefined;
      return result;
    },
  };
}
