import type { FrameStats } from './gfxinfo.ts';

/** Mirror of the `ELV_GATE` line the app prints (`apps/tv-mobile/src/gate/metrics.ts`); tools never import the app. */
export interface GateMetrics {
  moves: number;
  coalesced: number;
  losses: number;
  keyToHighlightMs: { p50: number; p95: number; max: number };
  maxJsGapMs: number;
  items: number;
}

/** Key-to-highlight of a burst of real remote keys; `losses` is the burst's focus-loss count. */
export interface RealKeys {
  p50: number;
  p95: number;
  max: number;
  losses: number;
}

/** What one gate measurement produces (median over runs). */
export interface GateResult {
  metrics: GateMetrics;
  frames: FrameStats;
  realKeys?: RealKeys;
}

/** Verdict of a comparison: any failure fails the gate; warnings are reported only. */
export interface CompareOutcome {
  ok: boolean;
  failures: string[];
  warnings: string[];
}

/** Absolute budgets (spec 5.6). They hold regardless of the baseline. */
const BUDGET_P95_MS = 100;
const BUDGET_JS_GAP_MS = 16;

const SLACK_LATENCY_MS = 5;
const SLACK_JANKY_POINTS = 2;
const SLACK_JS_GAP_MS = 4;
const TOLERANCE = 1.1;

const limit = (baseline: number, slack: number): number =>
  Math.max(baseline * TOLERANCE, baseline + slack);

/**
 * Compares a result with the committed baseline. A metric fails when it exceeds `max(baseline x 1.10, baseline +
 * slack)` or its absolute budget; any focus loss fails. The legacy janky percentage is compared; the deadline-based one
 * only warns, because it swung between 50 and 73 % across identical emulator runs. p95 and max are both compared, so
 * a run is never judged by an average that hides a stall.
 */
export function compareToBaseline(result: GateResult, baseline: GateResult): CompareOutcome {
  const failures: string[] = [];
  const warnings: string[] = [];

  const relative = (name: string, value: number, base: number, slack: number, unit: string) => {
    const max = limit(base, slack);
    if (value > max) {
      failures.push(
        `${name} ${value}${unit} exceeds the limit ${Math.round(max * 100) / 100}${unit} (baseline ${base}${unit})`,
      );
    }
  };
  const budget = (name: string, value: number, max: number) => {
    if (value > max) failures.push(`${name} ${value} ms exceeds the absolute budget of ${max} ms`);
  };

  const { metrics: m, frames: f } = result;
  const { metrics: bm, frames: bf } = baseline;
  if (m.items !== bm.items || m.moves !== bm.moves) {
    failures.push(
      `not comparable: ${m.items} items and ${m.moves} moves, baseline has ${bm.items} and ${bm.moves}`,
    );
  }
  if (m.losses > 0) failures.push(`focus losses: ${m.losses}`);
  if (m.coalesced > 0) warnings.push(`${m.coalesced} repeats were coalesced (commits fell behind)`);

  relative(
    'key-to-highlight p50',
    m.keyToHighlightMs.p50,
    bm.keyToHighlightMs.p50,
    SLACK_LATENCY_MS,
    ' ms',
  );
  relative(
    'key-to-highlight p95',
    m.keyToHighlightMs.p95,
    bm.keyToHighlightMs.p95,
    SLACK_LATENCY_MS,
    ' ms',
  );
  relative(
    'key-to-highlight max',
    m.keyToHighlightMs.max,
    bm.keyToHighlightMs.max,
    SLACK_LATENCY_MS,
    ' ms',
  );
  budget('key-to-highlight p95', m.keyToHighlightMs.p95, BUDGET_P95_MS);
  relative('max JS gap', m.maxJsGapMs, bm.maxJsGapMs, SLACK_JS_GAP_MS, ' ms');
  budget('max JS gap', m.maxJsGapMs, BUDGET_JS_GAP_MS);

  if (f.legacyJankyPercent !== undefined && bf.legacyJankyPercent !== undefined) {
    relative(
      'janky frames (legacy)',
      f.legacyJankyPercent,
      bf.legacyJankyPercent,
      SLACK_JANKY_POINTS,
      '%',
    );
  }
  relative('frame p95', f.p95, bf.p95, SLACK_LATENCY_MS, ' ms');
  relative('frame p99', f.p99, bf.p99, SLACK_LATENCY_MS, ' ms');
  if (f.jankyPercent > 0 || (f.legacyJankyPercent ?? 0) > 0) {
    warnings.push(
      `janky frames ${f.jankyPercent}% (legacy ${f.legacyJankyPercent ?? 'n/a'}%): target is 0 %, tolerated on emulators`,
    );
  }

  const real = result.realKeys;
  if (real !== undefined) {
    if (real.losses > 0) failures.push(`real keys: focus losses: ${real.losses}`);
    budget('real-key p95', real.p95, BUDGET_P95_MS);
    const base = baseline.realKeys;
    if (base !== undefined) {
      relative('real-key p95', real.p95, base.p95, SLACK_LATENCY_MS, ' ms');
      relative('real-key max', real.max, base.max, SLACK_LATENCY_MS, ' ms');
    }
  }

  return { ok: failures.length === 0, failures, warnings };
}
