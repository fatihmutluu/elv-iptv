import { describe, expect, it } from 'vitest';
import {
  baselineRefusal,
  baselineTargetRefusal,
  compareToBaseline,
  type GateResult,
  worstRunWarnings,
} from '../src/gates/compare.ts';

const baseline: GateResult = {
  metrics: {
    moves: 600,
    scripted: 600,
    coalesced: 0,
    losses: 0,
    keyToHighlightMs: { p50: 18, p95: 19, max: 22 },
    maxJsGapMs: 8,
    maxFrameStallMs: 10,
    items: 100000,
  },
  frames: {
    totalFrames: 600,
    jankyPercent: 70,
    legacyJankyPercent: 0.5,
    p50: 17,
    p90: 18,
    p95: 18,
    p99: 19,
  },
  realKeys: { p50: 20, p95: 30, max: 40, losses: 0 },
};

const change = (patch: {
  p95?: number;
  max?: number;
  gap?: number;
  losses?: number;
  coalesced?: number;
  edgeSteps?: number;
  scripted?: number;
  janky?: number;
  legacy?: number;
  framesP99?: number;
  stall?: number;
  items?: number;
  realP95?: number;
  realLosses?: number;
}): GateResult => ({
  metrics: {
    ...baseline.metrics,
    moves: (patch.scripted ?? 600) - (patch.coalesced ?? 0) - (patch.edgeSteps ?? 0),
    scripted: patch.scripted ?? 600,
    losses: patch.losses ?? 0,
    coalesced: patch.coalesced ?? 0,
    items: patch.items ?? baseline.metrics.items,
    keyToHighlightMs: {
      ...baseline.metrics.keyToHighlightMs,
      p95: patch.p95 ?? 19,
      max: patch.max ?? 22,
    },
    maxJsGapMs: patch.gap ?? 8,
    maxFrameStallMs: patch.stall ?? 10,
  },
  frames: {
    ...baseline.frames,
    jankyPercent: patch.janky ?? 70,
    legacyJankyPercent: patch.legacy ?? 0.5,
    p99: patch.framesP99 ?? 19,
  },
  realKeys: {
    p50: 20,
    p95: patch.realP95 ?? 30,
    max: 40,
    losses: patch.realLosses ?? 0,
  },
});

describe('compareToBaseline', () => {
  it('passes an identical result, warning that the emulator is janky', () => {
    const outcome = compareToBaseline(baseline, baseline);
    expect(outcome.ok).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.warnings.join('\n')).toMatch(/janky/);
  });

  it('passes within the slack and fails beyond max(b x 1.10, b + slack)', () => {
    expect(compareToBaseline(change({ p95: 24 }), baseline).ok).toBe(true);
    const over = compareToBaseline(change({ p95: 24.01 }), baseline);
    expect(over.ok).toBe(false);
    expect(over.failures[0]).toMatch(/p95/);
  });

  it('uses the ten percent term when it is larger than the slack', () => {
    const slow = change({ p95: 60 });
    expect(compareToBaseline(change({ p95: 66 }), slow).ok).toBe(true);
    expect(compareToBaseline(change({ p95: 66.01 }), slow).ok).toBe(false);
  });

  it('enforces the legacy janky metric but only warns about the noisy deadline metric', () => {
    expect(compareToBaseline(change({ legacy: 2.5 }), baseline).ok).toBe(true);
    const bad = compareToBaseline(change({ legacy: 2.51 }), baseline);
    expect(bad.ok).toBe(false);
    expect(bad.failures[0]).toMatch(/legacy/);
    const noisy = compareToBaseline(change({ janky: 95 }), baseline);
    expect(noisy.ok).toBe(true);
    expect(noisy.warnings.join(' ')).toMatch(/95/);
  });

  it('applies the JS gap slack of 4 ms', () => {
    expect(compareToBaseline(change({ gap: 12 }), baseline).ok).toBe(true);
    expect(compareToBaseline(change({ gap: 12.01 }), baseline).ok).toBe(false);
  });

  it('fails the absolute budgets even when the baseline is equally bad', () => {
    const bad = change({ p95: 120 });
    const badBaseline = change({ p95: 120 });
    const outcome = compareToBaseline(bad, badBaseline);
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join('\n')).toMatch(/budget/);
    const gap = compareToBaseline(change({ gap: 17 }), change({ gap: 17 }));
    expect(gap.ok).toBe(false);
    expect(gap.failures.join('\n')).toMatch(/16/);
  });

  it('fails on any focus loss, in the auto run or with real keys', () => {
    expect(compareToBaseline(change({ losses: 1 }), baseline).ok).toBe(false);
    expect(compareToBaseline(change({ realLosses: 1 }), baseline).ok).toBe(false);
  });

  it('fails when the real-key p95 exceeds its limit', () => {
    expect(compareToBaseline(change({ realP95: 36 }), baseline).ok).toBe(false);
  });

  it('only warns about the frame stall, relative to the baseline and to the budget', () => {
    const relative = compareToBaseline(change({ stall: 16 }), baseline);
    expect(relative.ok).toBe(true);
    expect(relative.warnings.join(' ')).toMatch(/frame stall/);
    const absolute = compareToBaseline(change({ stall: 40 }), change({ stall: 40 }));
    expect(absolute.ok).toBe(true);
    expect(absolute.warnings.join(' ')).toMatch(/frame stall.*budget/);
    expect(compareToBaseline(change({ stall: 11 }), baseline).warnings.join(' ')).not.toMatch(
      /frame stall/,
    );
  });

  it('compares results that lack the frame stall, as old baselines do', () => {
    const old: GateResult = { ...baseline, metrics: { ...baseline.metrics } };
    delete old.metrics.maxFrameStallMs;
    expect(compareToBaseline(change({}), old).ok).toBe(true);
    expect(compareToBaseline(old, baseline).ok).toBe(true);
  });

  it('warns about coalesced repeats without failing, though they lower the move count', () => {
    const outcome = compareToBaseline(change({ coalesced: 3 }), baseline);
    expect(outcome.ok).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.warnings.join('\n')).toMatch(/3 repeats were coalesced/);
  });

  it('compares the script length, so steps that hit an edge after coalescing still compare', () => {
    expect(compareToBaseline(change({ coalesced: 3, edgeSteps: 3 }), baseline).failures).toEqual(
      [],
    );
  });

  it('falls back to moves plus coalesced for lines and baselines without the scripted count', () => {
    const old: GateResult = { ...baseline, metrics: { ...baseline.metrics } };
    delete old.metrics.scripted;
    expect(compareToBaseline(change({ coalesced: 3 }), old).ok).toBe(true);
    const oldLine = change({ coalesced: 3 });
    delete oldLine.metrics.scripted;
    expect(compareToBaseline(oldLine, baseline).ok).toBe(true);
  });

  it('fails when the runs are not comparable', () => {
    expect(compareToBaseline(change({ items: 5 }), baseline).ok).toBe(false);
    const shorter = compareToBaseline(change({ scripted: 400 }), baseline);
    expect(shorter.failures).toEqual([
      'not comparable: 100000 items and 400 scripted events, baseline has 100000 and 600',
    ]);
  });

  it('skips real keys that the baseline lacks', () => {
    const { realKeys: _, ...noKeys } = baseline;
    expect(compareToBaseline(change({}), noKeys).ok).toBe(true);
  });
});

describe('baselineRefusal', () => {
  it('accepts a clean result', () => {
    expect(baselineRefusal(baseline)).toBeUndefined();
  });

  it('refuses results with losses or a broken budget', () => {
    expect(baselineRefusal(change({ losses: 1 }))).toMatch(/losses/);
    expect(baselineRefusal(change({ realLosses: 2 }))).toMatch(/losses/);
    expect(baselineRefusal(change({ gap: 17 }))).toMatch(/budget/);
    expect(baselineRefusal(change({ p95: 101 }))).toMatch(/budget/);
  });
});

describe('baselineTargetRefusal', () => {
  const local = '/repo/docs/learned/gates/list-android-tv.json';
  const ci = '/repo/docs/learned/gates/list-android-tv-ci.json';

  it('refuses to write the default local baseline with budgets as warnings', () => {
    expect(baselineTargetRefusal('warn', local, local)).toMatch(/--budgets warn.*--baseline/);
  });

  it('lets budgets-as-warnings write another baseline file, and budgets-fail write any', () => {
    expect(baselineTargetRefusal('warn', ci, local)).toBeUndefined();
    expect(baselineTargetRefusal('fail', local, local)).toBeUndefined();
    expect(baselineTargetRefusal('fail', ci, local)).toBeUndefined();
  });
});

describe('compareToBaseline with budgets as warnings', () => {
  const warn = { budgets: 'warn' } as const;

  it('reports absolute-budget breaches as warnings', () => {
    const slow = change({ p95: 120, gap: 17, realP95: 150 });
    const outcome = compareToBaseline(slow, slow, warn);
    expect(outcome.ok).toBe(true);
    expect(outcome.failures).toEqual([]);
    const text = outcome.warnings.join('\n');
    expect(text).toMatch(/key-to-highlight p95 120 ms exceeds the absolute budget of 100 ms/);
    expect(text).toMatch(/max JS gap 17 ms exceeds the absolute budget of 16 ms/);
    expect(text).toMatch(/real-key p95 150 ms exceeds the absolute budget of 100 ms/);
  });

  it('still fails regressions against the baseline and focus losses', () => {
    expect(compareToBaseline(change({ p95: 24.01 }), baseline, warn).ok).toBe(false);
    expect(compareToBaseline(change({ gap: 12.01 }), baseline, warn).ok).toBe(false);
    expect(compareToBaseline(change({ losses: 1 }), baseline, warn).ok).toBe(false);
    expect(compareToBaseline(change({ realLosses: 1 }), undefined, warn).ok).toBe(false);
  });

  it('fails the same breaches by default', () => {
    const slow = change({ gap: 17 });
    expect(compareToBaseline(slow, slow).ok).toBe(false);
    expect(compareToBaseline(slow, slow, { budgets: 'fail' }).ok).toBe(false);
  });

  it('lets a baseline over the budgets be written, but never one with losses', () => {
    expect(baselineRefusal(change({ gap: 17 }), 'warn')).toBeUndefined();
    expect(baselineRefusal(change({ losses: 1, gap: 17 }), 'warn')).toMatch(/losses: 1$/);
  });
});

describe('worstRunWarnings', () => {
  it('warns when the worst run breaks an absolute budget that the median meets', () => {
    const runs = [change({ p95: 20, gap: 5 }), change({ p95: 130, gap: 18 }), change({ p95: 21 })];
    expect(worstRunWarnings(runs, change({ p95: 21, gap: 8 }))).toEqual([
      'worst run: key-to-highlight p95 130 ms exceeds the absolute budget of 100 ms (the median passes)',
      'worst run: max JS gap 18 ms exceeds the absolute budget of 16 ms (the median passes)',
    ]);
  });

  it('stays quiet when every run meets the budgets or the median already fails them', () => {
    expect(worstRunWarnings([change({}), change({ p95: 99 })], change({}))).toEqual([]);
    const bad = [change({ p95: 120 }), change({ p95: 130 })];
    expect(worstRunWarnings(bad, change({ p95: 125 }))).toEqual([]);
  });
});

describe('compareToBaseline without a baseline', () => {
  it('applies only the losses rule and the absolute budgets, and says so', () => {
    const outcome = compareToBaseline(change({ p95: 60, gap: 12 }), undefined);
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.join('\n')).toMatch(/no baseline.*absolute budgets/);
  });

  it('still fails on focus losses and broken budgets', () => {
    const outcome = compareToBaseline(change({ losses: 1, p95: 101, gap: 17 }), undefined);
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join('\n')).toMatch(/focus losses: 1/);
    expect(outcome.failures.join('\n')).toMatch(/p95 101 ms exceeds the absolute budget/);
    expect(outcome.failures.join('\n')).toMatch(/JS gap 17 ms exceeds the absolute budget/);
  });

  it('does not judge items or moves or relative growth', () => {
    const outcome = compareToBaseline(change({ items: 5, max: 90, framesP99: 80 }), undefined);
    expect(outcome.ok).toBe(true);
  });

  it('checks real-key losses and budget', () => {
    const result = change({ realP95: 150, realLosses: 2 });
    const outcome = compareToBaseline(result, undefined);
    expect(outcome.failures.join('\n')).toMatch(/real keys: focus losses: 2/);
    expect(outcome.failures.join('\n')).toMatch(/real-key p95 150 ms exceeds the absolute budget/);
  });
});
