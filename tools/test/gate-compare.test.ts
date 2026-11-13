import { describe, expect, it } from 'vitest';
import { baselineRefusal, compareToBaseline, type GateResult } from '../src/gates/compare.ts';

const baseline: GateResult = {
  metrics: {
    moves: 600,
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

  it('warns about coalesced repeats without failing', () => {
    const outcome = compareToBaseline(change({ coalesced: 3 }), baseline);
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.join('\n')).toMatch(/coalesced/);
  });

  it('fails when the runs are not comparable', () => {
    expect(compareToBaseline(change({ items: 5 }), baseline).ok).toBe(false);
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
