import type { FrameStats } from './gfxinfo.ts';

/** Mirror of the `ELV_GATE` line the app prints (`apps/tv-mobile/src/gate/metrics.ts`); tools never import the app. */
export interface GateMetrics {
  moves: number;
  coalesced: number;
  losses: number;
  keyToHighlightMs: { p50: number; p95: number; max: number };
  /** Longest synchronous JS work of one move (enforced). */
  maxJsGapMs: number;
  /** Frame-stall estimate; absent in old lines and baselines. Report-only on emulators. */
  maxFrameStallMs?: number;
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
 * a run is never judged by an average that hides a stall. Without a baseline (`undefined`) only the absolute budgets
 * and the focus-loss rule apply, and a warning says so.
 */
export function compareToBaseline(
  result: GateResult,
  baseline: GateResult | undefined,
): CompareOutcome {
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
  if (baseline === undefined) {
    warnings.push(
      'no baseline: only the absolute budgets and the focus-loss rule were checked, relative limits were skipped',
    );
  } else if (m.items !== baseline.metrics.items || m.moves !== baseline.metrics.moves) {
    failures.push(
      `not comparable: ${m.items} items and ${m.moves} moves, baseline has ${baseline.metrics.items} and ${baseline.metrics.moves}`,
    );
  }
  if (m.losses > 0) failures.push(`focus losses: ${m.losses}`);
  if (m.coalesced > 0) warnings.push(`${m.coalesced} repeats were coalesced (commits fell behind)`);

  if (baseline !== undefined) {
    const bk = baseline.metrics.keyToHighlightMs;
    const k = m.keyToHighlightMs;
    relative('key-to-highlight p50', k.p50, bk.p50, SLACK_LATENCY_MS, ' ms');
    relative('key-to-highlight p95', k.p95, bk.p95, SLACK_LATENCY_MS, ' ms');
    relative('key-to-highlight max', k.max, bk.max, SLACK_LATENCY_MS, ' ms');
  }
  budget('key-to-highlight p95', m.keyToHighlightMs.p95, BUDGET_P95_MS);
  if (baseline !== undefined) {
    relative('max JS gap', m.maxJsGapMs, baseline.metrics.maxJsGapMs, SLACK_JS_GAP_MS, ' ms');
  }
  budget('max JS gap', m.maxJsGapMs, BUDGET_JS_GAP_MS);
  if (m.maxFrameStallMs !== undefined) {
    const stall = m.maxFrameStallMs;
    const baseStall = baseline?.metrics.maxFrameStallMs;
    if (stall > BUDGET_JS_GAP_MS) {
      warnings.push(
        `frame stall ${stall} ms exceeds the ${BUDGET_JS_GAP_MS} ms budget (report-only on emulators)`,
      );
    }
    if (baseStall !== undefined && stall > limit(baseStall, SLACK_JS_GAP_MS)) {
      warnings.push(
        `frame stall ${stall} ms exceeds the baseline limit (baseline ${baseStall} ms; report-only on emulators)`,
      );
    }
  }

  if (baseline !== undefined) {
    const bf = baseline.frames;
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
  }
  if (f.jankyPercent > 0 || (f.legacyJankyPercent ?? 0) > 0) {
    warnings.push(
      `janky frames ${f.jankyPercent}% (legacy ${f.legacyJankyPercent ?? 'n/a'}%): target is 0 %, tolerated on emulators`,
    );
  }

  const real = result.realKeys;
  if (real !== undefined) {
    if (real.losses > 0) failures.push(`real keys: focus losses: ${real.losses}`);
    budget('real-key p95', real.p95, BUDGET_P95_MS);
    const base = baseline?.realKeys;
    if (base !== undefined) {
      relative('real-key p95', real.p95, base.p95, SLACK_LATENCY_MS, ' ms');
      relative('real-key max', real.max, base.max, SLACK_LATENCY_MS, ' ms');
    }
  }

  return { ok: failures.length === 0, failures, warnings };
}

/**
 * Why a result must not become a baseline, or undefined when it may: focus losses (auto or real keys) or a broken
 * absolute budget would bake a failure into the reference.
 */
export function baselineRefusal(result: GateResult): string | undefined {
  const own = compareToBaseline(result, result);
  const reasons = own.failures.filter((f) => /losses|budget/.test(f));
  return reasons.length === 0 ? undefined : `refusing to write a baseline: ${reasons.join('; ')}`;
}
