import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/adb.ts';
import { PLAYER_USAGE, playerMain } from '../src/gates/player-cli.ts';
import {
  aggregateRuns,
  comparePlayer,
  judgeFault,
  type PlayerLine,
  type PlayerResult,
  parsePlayerLine,
  runPlayerGate,
} from '../src/gates/player-gate.ts';
import type { SimLog, SimLogEntry } from '../src/gates/sim-log.ts';

const PKG = 'io.github.fatihmutluu.elviptv.dev';
const T0 = Date.parse('2026-11-14T10:00:00.000Z');

const line = (over: Partial<PlayerLine> = {}): PlayerLine => ({
  ttffColdMs: 900,
  ttffWarmMs: { p50: 400, p95: 700 },
  zapMs: { p50: 500, p95: 900, max: 1200 },
  surfaceCreated: 1,
  staleEventsApplied: 0,
  staleEventsDropped: 2,
  failures: 0,
  recoveries: { '1': 0, '2': 0, '3': 0, '4': 0 },
  fault: '',
  faultOutcome: null,
  zaps: 30,
  ...over,
});
const logcat = (l: PlayerLine) =>
  `11-14 10:00:00.000 1 2 I ReactNativeJS: ELV_GATE_PLAYER ${JSON.stringify(l)}`;

const entry = (start: number, ms: number, over: Partial<SimLogEntry> = {}): SimLogEntry => ({
  t: new Date(T0 + start + ms).toISOString(),
  path: '/live/demo/demo/1001.ts',
  query: {},
  status: 200,
  bytes: 1000,
  ms,
  account: 'demo',
  streamId: 1001,
  ...over,
});

const forced509 = { status: 509, bytes: 0, query: { fault: 'status=509' } };
const slow = (start: number, ms: number, over: Partial<SimLogEntry> = {}) =>
  entry(start, ms, { query: { fault: 'slow-start=3' }, bytes: 0, ...over });
const next = (start: number, ms: number) =>
  entry(start, ms, { streamId: 1002, path: '/live/demo/demo/1002.ts' });

function fakes(opts: { lines: PlayerLine[]; entries?: SimLogEntry[][]; install?: boolean }) {
  const calls: string[] = [];
  const urls: string[] = [];
  const events: string[] = [];
  let starts = 0;
  let reads = 0;
  const exec: Exec = async (_c, args) => {
    const text = args.join(' ');
    calls.push(text);
    if (text === 'devices')
      return { ok: true, output: 'List of devices attached\nemulator-5554\tdevice\n' };
    const rest = text.replace(/^-s emulator-5554 /, '');
    if (rest.startsWith('shell am force-stop')) events.push('force-stop');
    if (rest.startsWith('install'))
      return {
        ok: opts.install !== false,
        output: opts.install === false ? 'adb: failed' : 'Success',
      };
    if (rest.startsWith('shell getprop sys.boot_completed')) return { ok: true, output: '1\n' };
    if (rest.startsWith('shell am start')) {
      starts++;
      urls.push(/-d '([^']*)'/.exec(rest)?.[1] ?? '');
    }
    if (rest === 'shell dumpsys activity activities') {
      return {
        ok: true,
        output: `  topResumedActivity=ActivityRecord{1a u0 ${PKG}/.MainActivity t1}`,
      };
    }
    if (rest === 'logcat -d -s ReactNativeJS:V') {
      const next = opts.lines[Math.min(starts, opts.lines.length) - 1];
      return { ok: true, output: next === undefined ? '' : logcat(next) };
    }
    return { ok: true, output: '' };
  };
  const sim = {
    ensure: async () => {
      events.push('start');
      return { reused: false, stop: async () => void events.push('stop') };
    },
  };
  const log: SimLog = {
    clear: async () => void events.push('clear'),
    entries: async () => {
      events.push('read');
      return (opts.entries ?? [])[reads++] ?? [];
    },
  };
  return { exec, sim, log, calls, urls, events };
}
const noSleep = async () => {};
const ffmpeg = () => 'ffmpeg';

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
    expect(
      parsePlayerLine(logcat({ ...line(), recoveries: {} } as unknown as PlayerLine)),
    ).toBeUndefined();
    expect(parsePlayerLine('ELV_GATE_PLAYER {"x":[1}')).toBeUndefined();
    expect(parsePlayerLine('nothing')).toBeUndefined();
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
});

describe('judgeFault', () => {
  const run = (fault: string, outcome: string | null) =>
    line({ fault, faultOutcome: outcome, zaps: 1 });

  it('accepts a dropped stream that is requested again in time', () => {
    const entries = [entry(0, 5000), entry(5300, 3000)];
    expect(judgeFault('drop5', run('drop5', 'recovered'), entries, '1001')).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails drop5 without a reconnect, a late one or a missed outcome', () => {
    expect(
      judgeFault('drop5', run('drop5', 'recovered'), [entry(0, 5000)], '1001').failures[0],
    ).toMatch(/no reconnect/);
    const late = judgeFault(
      'drop5',
      run('drop5', 'recovered'),
      [entry(0, 5000), entry(15001, 10)],
      '1001',
    );
    expect(late.failures[0]).toMatch(/10001 ms after the drop/);
    const missed = judgeFault(
      'drop5',
      run('drop5', 'missed'),
      [entry(0, 5000), entry(5100, 10)],
      '1001',
    );
    expect(missed.failures[0]).toMatch(/missed/);
  });

  it('accepts a 404 answered in time and fails a wrong outcome or an unanswered one', () => {
    const entries = [entry(0, 20, { status: 404 }), entry(1000, 20, { status: 404 })];
    expect(judgeFault('404', run('404', 'failed-in-time'), entries, '1001').failures).toEqual([]);
    expect(judgeFault('404', run('404', 'recovered'), entries, '1001').failures[0]).toMatch(
      /outcome recovered, expected failed-in-time/,
    );
    expect(
      judgeFault('404', run('404', 'failed-in-time'), [entry(0, 20)], '1001').failures[0],
    ).toMatch(/no 404/);
    const slow = [entry(0, 20, { status: 404 }), entry(10_000, 20, { status: 404 })];
    expect(judgeFault('404', run('404', 'failed-in-time'), slow, '1001').failures[0]).toMatch(
      /limit 10000/,
    );
  });

  it('requires the next request after a 509 to wait for the backoff', () => {
    const ok = [entry(0, 5, { status: 509 }), entry(2100, 5, { status: 509 })];
    expect(judgeFault('509', run('509', 'limited-backoff'), ok, '1001')).toEqual({
      failures: [],
      warnings: [],
    });
    const eager = [entry(0, 5, { status: 509 }), entry(500, 5, { status: 509 })];
    expect(judgeFault('509', run('509', 'limited-backoff'), eager, '1001').failures[0]).toMatch(
      /before the 2000 ms backoff/,
    );
    const single = judgeFault(
      '509',
      run('509', 'limited-backoff'),
      [entry(0, 5, { status: 509 })],
      '1001',
    );
    expect(single.failures).toEqual([]);
    expect(single.warnings[0]).toMatch(/backoff was not verified/);
    expect(
      judgeFault('509', run('509', 'limited-backoff'), [entry(0, 5)], '1001').failures[0],
    ).toMatch(/no 509/);
  });

  it('passes a slow start left by a zap whose next request came after the slow one closed', () => {
    const entries = [slow(0, 800), next(805, 2000)];
    expect(judgeFault('slowstart', run('slowstart', 'left'), entries, '1001')).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails a slow start whose request stayed open beside the next one, and warns about overlap', () => {
    const late = slow(0, 3000, { status: 509, bytes: 0 });
    const out = judgeFault('slowstart', run('slowstart', 'left'), [late, next(1800, 2000)], '1001');
    expect(out.failures).toEqual([
      'slowstart: 1 limit responses on demo: the slow request stayed open beside the next channel',
    ]);
    expect(out.warnings).toEqual(['slowstart: two demo streams were open together for 1200 ms']);
    const unseen = judgeFault(
      'slowstart',
      run('slowstart', 'left'),
      [slow(0, 800)],
      '1001',
    ).failures;
    expect(unseen).toEqual(['slowstart: the simulator saw no request after the zap']);
    const noFrame = line({ fault: 'slowstart', faultOutcome: 'left', zaps: 1 });
    noFrame.zapMs = { p50: null, p95: null, max: null };
    expect(
      judgeFault('slowstart', noFrame, [slow(0, 800), next(805, 10)], '1001').failures,
    ).toEqual(['slowstart: the zap away from the slow channel showed no frame']);
  });

  it('fails when the simulator saw nothing for the channel or the screen ran another fault', () => {
    const other = [entry(0, 100, { streamId: 1002, path: '/live/demo/demo/1002.ts' })];
    expect(judgeFault('404', run('', 'failed-in-time'), other, '1001').failures).toEqual([
      'the screen ran fault "", expected "404"',
      '404: the simulator saw no request for channel 1001',
    ]);
    expect(judgeFault('404', run('404', null), [], '1001').failures[0]).toMatch(/outcome null/);
  });

  it('judges a silent fault run bounded to 12 s with ladder retries and zero limit responses (#81)', () => {
    const stalled = (start: number, ms: number, over: Partial<SimLogEntry> = {}) =>
      entry(start, ms, { bytes: 0, query: { fault: 'stall30s@0s' }, ...over });
    const bounded = [
      stalled(0, 4000),
      stalled(4005, 2000),
      stalled(6010, 2000),
      next(20_000, 1000),
    ];
    expect(judgeFault('silent', run('silent', 'failed-in-time'), bounded, '1001')).toEqual({
      failures: [],
      warnings: [],
    });

    const single = [stalled(0, 4000)];
    expect(
      judgeFault('silent', run('silent', 'failed-in-time'), single, '1001').failures[0],
    ).toMatch(/fewer than 2 requests/);

    const old23s = [stalled(0, 8000), stalled(9000, 4000), stalled(15_000, 8000)];
    expect(
      judgeFault('silent', run('silent', 'failed-in-time'), old23s, '1001').failures[0],
    ).toMatch(/limit 12000 ms/);

    const leaked = [stalled(0, 4500), stalled(4000, 5, { status: 509 })];
    expect(
      judgeFault('silent', run('silent', 'failed-in-time'), leaked, '1001').failures[0],
    ).toMatch(/1 limit responses on demo/);
  });
});

describe('runPlayerGate', () => {
  it('runs the zap runs with the right link, clears the log and stops the simulator', async () => {
    const f = fakes({ lines: [line(), line(), line()], entries: [[], [], []] });
    const runs: number[] = [];
    const out = await runPlayerGate({
      ...f,
      sleep: noSleep,
      ffmpeg,
      zaps: 12,
      onRun: (r) => runs.push(r.zaps),
    });
    expect(f.urls).toEqual(
      Array(3).fill(
        'elviptv://gate/player?host=10.0.2.2:7878&account=demo&channels=1001,1002,1003,1004&zaps=12&rate=0.5&fault=',
      ),
    );
    expect(f.events).toEqual([
      'start',
      ...Array(3).fill(['force-stop', 'clear', 'force-stop', 'read']).flat(),
      'stop',
    ]);
    expect(runs).toHaveLength(3);
    expect(out.result.zaps).toBe(30);
    expect(out.runs).toHaveLength(3);
    expect(out.faults).toEqual([]);
  });

  it('takes limit responses and overlap from the simulator log of each zap run', async () => {
    const f = fakes({
      lines: [line()],
      entries: [[entry(0, 1000), entry(900, 1000), entry(5000, 3, { status: 509, bytes: 0 })]],
    });
    const out = await runPlayerGate({ ...f, sleep: noSleep, ffmpeg, runs: 1 });
    expect(out.result.limitResponses).toBe(1);
    expect(out.result.overlapMs).toBe(100);
  });

  it('runs one low-rate run per fault and judges each', async () => {
    const f = fakes({
      lines: [
        line(),
        line({ fault: 'drop5', faultOutcome: 'recovered', zaps: 1 }),
        line({ fault: '404', faultOutcome: 'failed-in-time', zaps: 1 }),
        line({ fault: '509', faultOutcome: 'missed', zaps: 1 }),
        line({ fault: 'slowstart', faultOutcome: 'left', zaps: 1 }),
        line({ fault: 'silent', faultOutcome: 'failed-in-time', zaps: 1 }),
      ],
      entries: [
        [],
        [entry(0, 5000), entry(5200, 100)],
        [entry(0, 10, { status: 404 })],
        [entry(0, 5, forced509), entry(2500, 5, forced509)],
        [slow(0, 800), next(810, 2000)],
        [
          entry(0, 4000, { bytes: 0 }),
          entry(4005, 2000, { bytes: 0 }),
          entry(6010, 2000, { bytes: 0 }),
        ],
      ],
    });
    const reports: string[] = [];
    const out = await runPlayerGate({
      ...f,
      sleep: noSleep,
      ffmpeg,
      runs: 1,
      faults: true,
      onFault: (r) => reports.push(r.fault),
    });
    expect(f.urls.slice(1)).toEqual(
      [
        ...['drop5', '404', '509'].map((x) => `0.1&fault=${x}`),
        '1.25&fault=slowstart',
        '0.05&fault=silent',
      ].map(
        (x) =>
          `elviptv://gate/player?host=10.0.2.2:7878&account=demo&channels=1001,1002,1003,1004&zaps=1&rate=${x}`,
      ),
    );
    expect(reports).toEqual(['drop5', '404', '509', 'slowstart', 'silent']);
    expect(out.faults.map((x) => x.failures.length)).toEqual([0, 0, 1, 0, 0]);
    expect(out.faults[2]?.failures[0]).toMatch(/missed/);
    expect(out.faults.map((x) => [x.limitResponses, x.overlapMs])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it('fails clearly without FFmpeg, before starting anything', async () => {
    const f = fakes({ lines: [] });
    await expect(runPlayerGate({ ...f, sleep: noSleep, ffmpeg: () => null })).rejects.toThrow(
      /FFmpeg not found/,
    );
    expect(f.events).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('stops the simulator when the install fails and when no line appears', async () => {
    const broken = fakes({ lines: [], install: false });
    await expect(runPlayerGate({ ...broken, sleep: noSleep, ffmpeg })).rejects.toThrow(
      /adb install failed/,
    );
    expect(broken.events).toEqual(['start', 'stop']);

    const silent = fakes({ lines: [] });
    await expect(
      runPlayerGate({ ...silent, sleep: noSleep, ffmpeg, runs: 1, zaps: 1 }),
    ).rejects.toThrow(/no ELV_GATE_PLAYER line within 62 s/);
    expect(silent.events).toEqual(['start', 'force-stop', 'clear', 'stop']);
  });

  it('builds first with --build and notes a reused simulator', async () => {
    const f = fakes({ lines: [line()], entries: [[]] });
    const notes: string[] = [];
    f.sim.ensure = async () => ({ reused: true, stop: async () => void f.events.push('stop') });
    const seen: string[] = [];
    const exec: Exec = async (c, a, o) => {
      seen.push(
        c === 'adb'
          ? `adb ${a.find((x) => x === 'install' || x === 'start') ?? ''}`.trim()
          : 'build',
      );
      return f.exec(c, a, o);
    };
    await runPlayerGate({
      ...f,
      exec,
      build: true,
      sleep: noSleep,
      ffmpeg,
      runs: 1,
      onNote: (n) => notes.push(n),
    });
    expect(notes[0]).toMatch(/reusing it/);
    const order = seen.filter((c) => c !== 'adb');
    expect(order.slice(0, 2)).toEqual(['build', 'build']);
    expect(order.indexOf('adb install')).toBe(2);
    expect(order.indexOf('adb start')).toBeGreaterThan(2);
  });
});

describe('line validation', () => {
  it('fails a zap run whose line ran a fault or fewer zaps than requested', async () => {
    const faulted = fakes({ lines: [line({ fault: '404' })], entries: [[]] });
    await expect(runPlayerGate({ ...faulted, sleep: noSleep, ffmpeg, runs: 1 })).rejects.toThrow(
      /fault "404"/,
    );
    const short = fakes({ lines: [line({ zaps: 5 })], entries: [[]] });
    await expect(runPlayerGate({ ...short, sleep: noSleep, ffmpeg, runs: 1 })).rejects.toThrow(
      /5 zaps, requested no fault and 30/,
    );
    expect(short.events.at(-1)).toBe('stop');
  });

  it('fails a fault run whose line made no zap', () => {
    const l = line({ fault: '404', faultOutcome: 'failed-in-time', zaps: 0 });
    const out = judgeFault('404', l, [entry(0, 20, { status: 404 })], '1001');
    expect(out.failures).toEqual(['404: the screen made 0 zaps, requested 1']);
  });
});

describe('playerMain', () => {
  it('refuses --write-baseline without --faults before touching a device', async () => {
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => {
      written.push(t);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await playerMain({ 'write-baseline': true }, '.')).toBe(2);
    } finally {
      process.stderr.write = real;
    }
    expect(written.join('')).toMatch(/baseline needs --faults/);
  });
});

describe('PLAYER_USAGE', () => {
  it('names the player gate options', () => {
    expect(PLAYER_USAGE).toMatch(/gate player.*--zaps.*--faults/);
  });
});
