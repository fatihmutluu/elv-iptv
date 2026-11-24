import { beforeEach, describe, expect, it } from 'vitest';
import {
  createStreamHealthScorer,
  DEFAULT_HEALTH_SCORER_HALF_LIFE_MS,
  DEFAULT_HEALTH_SCORER_MAX_ENTRIES,
  HEALTH_SCORE_TIE_TOLERANCE,
} from './stream-health-scorer';

describe('createStreamHealthScorer (#195)', () => {
  let nowMs = 100_000;
  const clock = { now: () => nowMs };

  beforeEach(() => {
    nowMs = 100_000;
  });

  it('defaults to 300 max entries, 15-minute half-life, and 0.01 tie tolerance', () => {
    expect(DEFAULT_HEALTH_SCORER_MAX_ENTRIES).toBe(300);
    expect(DEFAULT_HEALTH_SCORER_HALF_LIFE_MS).toBe(15 * 60 * 1_000);
    expect(HEALTH_SCORE_TIE_TOLERANCE).toBe(0.01);
  });

  it('canonicalizes stream URLs so credentials never enter scorer keys', () => {
    const scorer = createStreamHealthScorer({ clock });
    const synthetic = (origin: string, u: string, p: string, q: string) =>
      `${origin}/live/${u}/${p}/10.ts?${q}`;
    scorer.recordFailure(
      synthetic('http://u1:p1@edge.example.test:80', 'acct1', 'cred1', 'token=t1'),
    );
    const score = scorer.score(synthetic('http://EDGE.EXAMPLE.TEST', 'acct2', 'cred2', 'token=t2'));
    expect(score).toBeCloseTo(-3.0, 5);
    expect(scorer.size()).toBe(1);
  });

  it('applies stall (-1.5), failure (-3.0), TTFF tiers, and bounded buffer depth adjustments', () => {
    const scorer = createStreamHealthScorer({ clock });

    expect(scorer.score('unseen')).toBe(0);
    expect(scorer.recordStall('s-stall')).toBeCloseTo(-1.5, 5);
    expect(scorer.recordFailure('s-fail')).toBeCloseTo(-3.0, 5);

    // TTFF tiers: <= 1500 (+0.8), <= 3000 (+0.3), <= 5000 (0), > 5000 (-0.8)
    expect(scorer.recordFirstFrame('ttff-fast', 900)).toBeCloseTo(0.8, 5);
    expect(scorer.recordFirstFrame('ttff-ok', 2_500)).toBeCloseTo(0.3, 5);
    expect(scorer.recordFirstFrame('ttff-mid', 4_500)).toBeCloseTo(0, 5);
    expect(scorer.recordFirstFrame('ttff-slow', 6_200)).toBeCloseTo(-0.8, 5);

    // Buffer depth: >= 4000 (+0.25), < 1000 (-0.35), bounded so repeated ticks cannot swamp penalties
    expect(scorer.recordBufferDepth('buf-good', 5_000)).toBeCloseTo(0.25, 5);
    for (let i = 0; i < 20; i += 1) {
      scorer.recordBufferDepth('buf-good', 6_000);
    }
    expect(scorer.score('buf-good')).toBeLessThanOrEqual(0.5);

    expect(scorer.recordBufferDepth('buf-low', 400)).toBeCloseTo(-0.35, 5);
    for (let i = 0; i < 20; i += 1) {
      scorer.recordBufferDepth('buf-low', 200);
    }
    expect(scorer.score('buf-low')).toBeGreaterThanOrEqual(-0.5);

    // Overall score clamped to [-12, +4]
    for (let i = 0; i < 10; i += 1) {
      scorer.recordFailure('s-clamped-low');
      scorer.recordFirstFrame('s-clamped-high', 500);
    }
    expect(scorer.score('s-clamped-low')).toBe(-12);
    expect(scorer.score('s-clamped-high')).toBeLessThanOrEqual(4);
  });

  it('exponentially decays penalties toward 0 with 15-minute half-life', () => {
    const scorer = createStreamHealthScorer({ clock });
    scorer.recordFailure('http://a.example/live/1.ts'); // -3.0
    expect(scorer.score('http://a.example/live/1.ts')).toBeCloseTo(-3.0, 5);

    // After 1 half-life (15 min) -> -1.5
    nowMs += DEFAULT_HEALTH_SCORER_HALF_LIFE_MS;
    expect(scorer.score('http://a.example/live/1.ts')).toBeCloseTo(-1.5, 5);

    // After 2 half-lives (30 min) -> -0.75
    nowMs += DEFAULT_HEALTH_SCORER_HALF_LIFE_MS;
    expect(scorer.score('http://a.example/live/1.ts')).toBeCloseTo(-0.75, 5);

    // After 10 half-lives (150 min) -> ~ -0.0029 (< 0.01 tie tolerance)
    nowMs += 8 * DEFAULT_HEALTH_SCORER_HALF_LIFE_MS;
    expect(Math.abs(scorer.score('http://a.example/live/1.ts'))).toBeLessThan(
      HEALTH_SCORE_TIE_TOLERANCE,
    );
  });

  it('ranks alternates descending by decayed score and strictly preserves original order on ties (< 0.01)', () => {
    const scorer = createStreamHealthScorer({ clock });
    const alts = [
      { id: 'priority-1', url: 'http://p1.example/1.ts' },
      { id: 'priority-2', url: 'http://p2.example/1.ts' },
      { id: 'priority-3', url: 'http://p3.example/1.ts' },
    ];

    // Unseen -> preserves original user drag-and-drop priority order
    expect(scorer.rankAlternates(alts, (a) => a.url).map((a) => a.id)).toEqual([
      'priority-1',
      'priority-2',
      'priority-3',
    ]);

    // Penalize priority-1 -> drops behind priority-2 and priority-3, which keep relative order
    scorer.recordStall('http://p1.example/1.ts');
    expect(scorer.rankAlternates(alts, (a) => a.url).map((a) => a.id)).toEqual([
      'priority-2',
      'priority-3',
      'priority-1',
    ]);

    // Reward priority-3 with fast first frame -> rises to top
    scorer.recordFirstFrame('http://p3.example/1.ts', 800);
    expect(scorer.rankAlternates(alts, (a) => a.url).map((a) => a.id)).toEqual([
      'priority-3',
      'priority-2',
      'priority-1',
    ]);

    // After sufficient decay (~10 half-lives), penalties and bonuses decay below 0.01 -> user order restored!
    nowMs += 10 * DEFAULT_HEALTH_SCORER_HALF_LIFE_MS;
    expect(scorer.rankAlternates(alts, (a) => a.url).map((a) => a.id)).toEqual([
      'priority-1',
      'priority-2',
      'priority-3',
    ]);
  });

  it('caps tracked entries at maxEntries (300 default) with LRU eviction', () => {
    const scorer = createStreamHealthScorer({ clock });
    for (let i = 0; i < 340; i += 1) {
      scorer.recordStall(`http://edge.example/live/${i}.ts`);
    }
    expect(scorer.size()).toBe(300);
    expect(scorer.score('http://edge.example/live/0.ts')).toBe(0);
    expect(scorer.score('http://edge.example/live/39.ts')).toBe(0);
    expect(scorer.score('http://edge.example/live/40.ts')).toBeCloseTo(-1.5, 5);
    expect(scorer.score('http://edge.example/live/339.ts')).toBeCloseTo(-1.5, 5);

    scorer.clear();
    expect(scorer.size()).toBe(0);
  });
});
