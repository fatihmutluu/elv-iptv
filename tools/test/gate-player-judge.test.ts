import { describe, expect, it } from 'vitest';
import {
  aggregateRuns,
  budgetsFor,
  comparePlayer,
  crashFailures,
  judgeSoak,
  judgeStress,
  type PlayerLine,
  type PlayerResult,
  parsePlayerLine,
  type SoakBlock,
} from '../src/gates/player-judge.ts';
import { line, logcat } from './gate-player-fixtures.ts';

describe('parsePlayerLine', () => {
  it('returns the last well-formed line among noise', () => {
    const text = [
      logcat(line({ zaps: 5 })),
      'I ReactNativeJS: other',
      logcat(line({ zaps: 9 })),
    ].join('\n');
    expect(parsePlayerLine(text)?.zaps).toBe(9);
  });

  it('accepts null for unmeasured values', () => {
    const l = line({ ttffColdMs: null, zapMs: { p50: null, p95: null, max: null } });
    expect(parsePlayerLine(logcat(l))).toEqual(l);
  });

  it('ignores broken, partial and foreign lines', () => {
    expect(parsePlayerLine('ELV_GATE_PLAYER {"zaps":1')).toBeUndefined();
    expect(parsePlayerLine('ELV_GATE_PLAYER {"zaps":1}')).toBeUndefined();
    expect(parsePlayerLine(logcat({ ...line(), recoveries: {} }))).toBeUndefined();
    expect(parsePlayerLine('ELV_GATE_PLAYER {"x":[1}')).toBeUndefined();
    expect(parsePlayerLine('nothing')).toBeUndefined();
  });

  it('reads the soak block and the final status, and defaults them for older builds', () => {
    const soak: SoakBlock = {
      minutes: 10,
      playedMs: 599_000,
      positionAdvancedMs: 598_500,
      stalls: 0,
      longestStallMs: 0,
      ended: false,
      durationMs: null,
    };
    expect(parsePlayerLine(logcat(line({ soak, final: 'failed' })))).toMatchObject({
      soak,
      final: 'failed',
    });
    const { soak: _s, final: _f, ...old } = line();
    expect(parsePlayerLine(logcat(old))).toMatchObject({ soak: null, final: 'other' });
    expect(parsePlayerLine(logcat({ ...line(), soak: { minutes: 1 } }))).toBeUndefined();
    expect(parsePlayerLine(logcat({ ...line(), final: 'done' }))).toBeUndefined();
  });

  it('reads limitedAfterMs, defaults it to null for older builds and rejects a bad value', () => {
    const limited = line({ fault: '509', faultOutcome: 'limited-backoff', limitedAfterMs: 140 });
    expect(parsePlayerLine(logcat(limited))?.limitedAfterMs).toBe(140);
    const { limitedAfterMs: _l, ...old } = line();
    expect(parsePlayerLine(logcat(old))?.limitedAfterMs).toBeNull();
    expect(parsePlayerLine(logcat({ ...line(), limitedAfterMs: 'soon' }))).toBeUndefined();
    expect(parsePlayerLine(logcat({ ...line(), limitedAfterMs: -1 }))).toBeUndefined();
  });
});

describe('aggregateRuns', () => {
  it('takes the median of times and the worst run of counters and overlap', () => {
    const result = aggregateRuns(
      [
        line({ ttffColdMs: 900 }),
        line({ ttffColdMs: 1500, surfaceCreated: 2 }),
        line({ ttffColdMs: null }),
      ],
      [
        { limitResponses: 0, overlapMs: 10 },
        { limitResponses: 2, overlapMs: 30 },
        { limitResponses: 1, overlapMs: 20 },
      ],
    );
    expect(result.ttffColdMs).toBe(1200);
    expect(result.surfaceCreated).toBe(2);
    expect(result.limitResponses).toBe(2);
    expect(result.overlapMs).toBe(30);
  });

  it('keeps a metric null when no run measured it', () => {
    const l = line({ zapMs: { p50: null, p95: null, max: null } });
    expect(aggregateRuns([l], [{ limitResponses: 0, overlapMs: 0 }]).zapMs.p95).toBeNull();
  });
});

const result = (over: Partial<PlayerResult> = {}): PlayerResult => ({
  ...aggregateRuns([line()], [{ limitResponses: 0, overlapMs: 0 }]),
  ...over,
});

describe('comparePlayer', () => {
  it('passes a run within the budgets and the baseline', () => {
    expect(comparePlayer(result(), result())).toEqual({ ok: true, failures: [], warnings: [] });
  });

  it('applies the absolute budgets, with strict limits for cold and warm', () => {
    const slow = result({
      ttffColdMs: 2000,
      ttffWarmMs: { p50: 1000, p95: 1 },
      zapMs: { p50: 1, p95: 2001, max: 1 },
    });
    const out = comparePlayer(slow, undefined);
    expect(out.failures).toHaveLength(3);
    expect(out.failures.join('\n')).toMatch(/cold start 2000 ms.*2000/);
    expect(
      comparePlayer(result({ zapMs: { p50: 1, p95: 2000, max: 1 } }), undefined).failures,
    ).toEqual([]);
    expect(out.warnings[0]).toMatch(/no baseline/);
  });

  it('only warns about time budgets with --budgets warn, never about counters', () => {
    const slow = result({ ttffColdMs: 3000, surfaceCreated: 2 });
    const out = comparePlayer(slow, undefined, { budgets: 'warn' });
    expect(out.failures).toEqual(['surfaceCreated 2, expected 1']);
    expect(out.warnings.join('\n')).toMatch(/cold start 3000 ms.*reported only/);
  });

  it('fails stale events, failed tunes, limit responses and unmeasured times; warns about overlap', () => {
    const out = comparePlayer(
      result({
        staleEventsApplied: 1,
        failures: 2,
        limitResponses: 3,
        ttffColdMs: null,
        overlapMs: 40,
      }),
      undefined,
    );
    expect(out.failures).toEqual(
      expect.arrayContaining([
        'cold start was not measured',
        'staleEventsApplied 1, expected 0',
        '2 tunes failed during the zap runs',
        'limitResponses 3 on account demo, expected 0',
      ]),
    );
    expect(out.warnings.join('\n')).toMatch(/open together for 40 ms/);
  });

  it('warns about a time one run did not measure when the result has one from the others', () => {
    const runs = [result(), result({ ttffColdMs: null, zapMs: { p50: 1, p95: null, max: 1 } })];
    const out = comparePlayer(result(), result(), { runs });
    expect(out.ok).toBe(true);
    expect(out.warnings).toEqual([
      'run 2: cold start was not measured; the result uses the other runs',
      'run 2: zap p95 was not measured; the result uses the other runs',
    ]);
  });

  it('fails a time that grows more than 10 percent plus 50 ms slack over the baseline', () => {
    expect(comparePlayer(result({ ttffColdMs: 950 }), result()).ok).toBe(true);
    const out = comparePlayer(result({ ttffColdMs: 1000 }), result());
    expect(out.failures[0]).toMatch(
      /cold start 1000 ms exceeds the limit 990 ms \(baseline 900 ms\)/,
    );
  });

  it('is not comparable with another zap count', () => {
    const out = comparePlayer(result({ zaps: 10 }), result());
    expect(out.failures).toEqual(['not comparable: 10 zaps, baseline has 30']);
  });

  it('is not comparable across bursts, while an older baseline without burstSec matches burst 0', () => {
    expect(comparePlayer(result({ burstSec: 8 }), result({ burstSec: 0 })).failures).toEqual([
      'not comparable: burst 8, baseline has 0',
    ]);
    const legacy = { ...result() } as Partial<PlayerResult>;
    delete legacy.burstSec;
    expect(comparePlayer(result({ burstSec: 0 }), legacy as PlayerResult).ok).toBe(true);
  });

  it('selects budgets per target and burst profile', () => {
    expect(budgetsFor('android-tv', 0)).toEqual({ coldMs: 2000, warmP50Ms: 1000, zapP95Ms: 2000 });
    expect(budgetsFor('tvos', 8)).toEqual({ coldMs: 2000, warmP50Ms: 1000, zapP95Ms: 2000 });
    expect(budgetsFor('ios', 8)).toEqual({ coldMs: 2000, warmP50Ms: 1000, zapP95Ms: 2000 });
    expect(budgetsFor('tvos', 0)).toEqual({ coldMs: 4000, warmP50Ms: 3000, zapP95Ms: 4000 });
    expect(budgetsFor('ios', 0)).toEqual({ coldMs: 4000, warmP50Ms: 3000, zapP95Ms: 4000 });

    const realtime = result({
      burstSec: 0,
      ttffColdMs: 3500,
      ttffWarmMs: { p50: 2500, p95: 3000 },
      zapMs: { p50: 2000, p95: 4000, max: 4000 },
    });
    expect(comparePlayer(realtime, undefined, { target: 'tvos' }).failures).toEqual([]);
    expect(
      comparePlayer({ ...realtime, burstSec: 8 }, undefined, { target: 'tvos' }).failures,
    ).toHaveLength(3);
  });
});

const soak = (over: Partial<SoakBlock> = {}): SoakBlock => ({
  minutes: 60,
  playedMs: 3_598_000,
  positionAdvancedMs: 3_597_200,
  stalls: 0,
  longestStallMs: 0,
  ended: false,
  durationMs: null,
  ...over,
});
const soakLine = (over: Partial<SoakBlock> = {}, rest: Partial<PlayerLine> = {}) =>
  line({ zaps: 0, soak: soak(over), ...rest });
const noMemory = { firstMb: null, lastMb: null };

describe('judgeSoak', () => {
  it('a live soak passes with no stalls and matching positions', () => {
    expect(judgeSoak(soakLine(), { stream: 'ts', crashes: [], memory: noMemory })).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('a 3 s position deficit fails', () => {
    const out = judgeSoak(soakLine({ positionAdvancedMs: 3_595_000 }), {
      stream: 'hls',
      crashes: [],
      memory: noMemory,
    });
    expect(out.failures).toEqual([
      'soak: position advanced 3595000 ms in 3598000 ms played, off by 3000 ms (limit 2000 ms)',
    ]);
  });

  it('fails stalls, failures, recoveries, crashes and a missing soak block', () => {
    const out = judgeSoak(
      soakLine(
        { stalls: 2, longestStallMs: 1500 },
        { failures: 1, recoveries: { '1': 1, '2': 0, '3': 0, '4': 0 } },
      ),
      { stream: 'ts', crashes: ['ElvIptv-2026-11-15-101010.ips'], memory: noMemory },
    );
    expect(out.failures).toEqual([
      'soak: 1 tunes failed',
      'soak: 2 stalls (longest 1500 ms), expected 0',
      'soak: recovery rung 1 entered 1 times, expected 0',
      'crash reports newer than the run: ElvIptv-2026-11-15-101010.ips',
    ]);
    expect(judgeSoak(line(), { stream: 'ts', crashes: [], memory: noMemory }).failures).toEqual([
      'soak: the line carries no soak block; the app build predates soak runs',
    ]);
  });

  it('a VOD soak must end', () => {
    const vod = { stream: 'vod' as const, crashes: [], memory: noMemory };
    const done = soakLine({
      ended: true,
      durationMs: 600_000,
      positionAdvancedMs: 598_500,
      playedMs: 610_000,
    });
    expect(judgeSoak(done, vod).failures).toEqual([]);
    expect(judgeSoak(soakLine({ ended: false, durationMs: 600_000 }), vod).failures).toEqual([
      'soak: the movie did not play to its end',
    ]);
    expect(
      judgeSoak(soakLine({ ended: true, durationMs: 600_000, positionAdvancedMs: 590_000 }), vod)
        .failures,
    ).toEqual(['soak: position advanced 590000 ms of the 600000 ms movie (at least 598000 ms)']);
    expect(judgeSoak(soakLine({ ended: true, durationMs: null }), vod).failures).toEqual([
      'soak: the movie reported no duration',
    ]);
  });

  it('memory growth of 120 MB fails and 40 MB warns', () => {
    const at = (lastMb: number) =>
      judgeSoak(soakLine(), { stream: 'ts', crashes: [], memory: { firstMb: 200, lastMb } });
    expect(at(320).failures).toEqual(['soak: memory grew 120 MB (200 MB to 320 MB), limit 100 MB']);
    expect(at(240)).toEqual({
      failures: [],
      warnings: ['soak: memory grew 40 MB (200 MB to 240 MB), warning above 32 MB'],
    });
    expect(at(230)).toEqual({ failures: [], warnings: [] });
  });
});

describe('judgeStress', () => {
  const run = (
    over: Partial<PlayerLine> = {},
    extra: Partial<{ limitResponses: number }> = {},
  ) => ({
    line: line({ zaps: 200, ...over }),
    limitResponses: 0,
    overlapMs: 0,
    crashes: [] as string[],
    ...extra,
  });

  it('stress judges counters only and fails without a final frame', () => {
    const slow = run({ ttffColdMs: 9000, zapMs: { p50: 5000, p95: 9000, max: 9999 } });
    expect(judgeStress([slow, run()], 200)).toEqual({ failures: [], warnings: [] });
    const out = judgeStress(
      [
        run({ final: 'other' }),
        run({ failures: 1, staleEventsApplied: 2, surfaceCreated: 2 }, { limitResponses: 1 }),
        { ...run({ zaps: 150 }), crashes: ['ElvIptv.ips'] },
      ],
      200,
    );
    expect(out.failures).toEqual([
      'run 1: final status other, expected playing (the last zap showed no frame)',
      'run 2: 1 tunes failed',
      'run 2: staleEventsApplied 2, expected 0',
      'run 2: surfaceCreated 2, expected 1',
      'run 2: limitResponses 1 on account demo, expected 0',
      'run 3: the screen made 150 zaps, requested 200',
      'run 3: crash reports newer than the run: ElvIptv.ips',
    ]);
  });

  it('warns about overlap', () => {
    expect(judgeStress([{ ...run(), overlapMs: 30 }], 200).warnings).toEqual([
      'run 1: two demo streams were open together for 30 ms',
    ]);
  });
});

describe('crashFailures', () => {
  it('names the reports, or nothing', () => {
    expect(crashFailures([])).toEqual([]);
    expect(crashFailures(['a.ips', 'b.ips'])).toEqual([
      'crash reports newer than the run: a.ips, b.ips',
    ]);
  });
});
