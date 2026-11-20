import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_USAGE, desktopMain } from '../src/gates/desktop-cli.ts';
import {
  aggregateDesktopRuns,
  compareDesktop,
  type DesktopLine,
  type DesktopResult,
  judgeDesktopFault,
  parseDesktopLine,
} from '../src/gates/desktop-compare.ts';
import {
  type AppHandle,
  connectionStats,
  type DesktopGateDeps,
  defaultDesktopBaseline,
  desktopGateCatalog,
  runDesktopGate,
} from '../src/gates/desktop-gate.ts';
import type { SimLogEntry } from '../src/gates/sim-log.ts';

const T0 = Date.parse('2026-11-15T08:00:00.000Z');

const makeLine = (over: Partial<DesktopLine> = {}): DesktopLine => ({
  ttffColdMs: 820,
  ttffWarmMs: { p50: 410, p95: 620 },
  zapMs: { p50: 450, p95: 780, max: 1100 },
  surfaceCreated: 1,
  staleEventsApplied: 0,
  staleEventsDropped: 1,
  failures: 0,
  engineWedged: 0,
  recoveries: { '1': 0, '2': 0, '3': 0, '4': 0 },
  fault: '',
  faultOutcome: null,
  zaps: 30,
  vod: { playing: true, seeked: true },
  mpvSpawns: 1,
  loadMode: 'replace',
  presenter: 'child-window',
  videoVisible: true,
  distinct: 42,
  coalesceMaxMs: 120,
  ...over,
});

const makeEntry = (start: number, ms: number, over: Partial<SimLogEntry> = {}): SimLogEntry => ({
  t: new Date(T0 + start + ms).toISOString(),
  path: '/live/demo/demo/1001.ts',
  query: {},
  status: 200,
  bytes: 500_000,
  ms,
  account: 'demo',
  streamId: 1001,
  ...over,
});

async function* linesOf(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

describe('connectionStats (desktop re-export)', () => {
  it('handles sequential streams, overlap, 509 limits and HLS segments without account', () => {
    expect(connectionStats([makeEntry(0, 1000), makeEntry(1000, 1000)], 'demo')).toEqual({
      limitResponses: 0,
      overlapMs: 0,
    });
    expect(connectionStats([makeEntry(0, 1000), makeEntry(970, 1000)], 'demo').overlapMs).toBe(30);
    expect(
      connectionStats([makeEntry(0, 10, { status: 509, bytes: 0 })], 'demo').limitResponses,
    ).toBe(1);
    expect(
      connectionStats(
        [makeEntry(0, 500, { account: null, streamId: null, path: '/hls/news/1.ts', status: 509 })],
        'demo',
      ),
    ).toEqual({ limitResponses: 0, overlapMs: 0 });
  });
});

describe('desktopGateCatalog & defaultDesktopBaseline', () => {
  it('picks healthy h264-aac-720p25 live channels and the first h264 mp4 movie', () => {
    const picked = desktopGateCatalog();
    expect(picked.channels).toEqual(['1001', '1004', '1007', '1010']);
    expect(picked.vod).toBe('200001');
  });

  it('selects the platform baseline path', () => {
    expect(defaultDesktopBaseline('win32')).toBe('docs/learned/gates/player-desktop-windows.json');
    expect(defaultDesktopBaseline('darwin')).toBe('docs/learned/gates/player-desktop-macos.json');
  });
});

describe('parseDesktopLine & compareDesktop', () => {
  it('parses the last valid ELV_GATE_PLAYER line and ignores noise', () => {
    const l = makeLine({ ttffColdMs: 755 });
    const raw = `ELV_GATE_PLAYING\nnoise\nELV_GATE_PLAYER {bad\nELV_GATE_PLAYER ${JSON.stringify(l)}\n`;
    expect(parseDesktopLine(raw)?.ttffColdMs).toBe(755);
    expect(parseDesktopLine('nothing here')).toBeUndefined();
  });

  it('aggregates median times, worst counters, and videoVisible across runs', () => {
    const r = aggregateDesktopRuns(
      [
        makeLine({ ttffColdMs: 1200, zapMs: { p50: 400, p95: 900, max: 1100 }, distinct: 48 }),
        makeLine({ ttffColdMs: 800, zapMs: { p50: 350, p95: 700, max: 950 }, distinct: 35 }),
        makeLine({ ttffColdMs: 900, zapMs: { p50: 380, p95: 750, max: 1000 }, distinct: 40 }),
      ],
      [
        { limitResponses: 0, overlapMs: 0 },
        { limitResponses: 0, overlapMs: 15 },
        { limitResponses: 0, overlapMs: 0 },
      ],
    );
    expect(r.ttffColdMs).toBe(900);
    expect(r.zapMs.p95).toBe(750);
    expect(r.overlapMs).toBe(15);
    expect(r.distinct).toBe(35);
    expect(r.videoVisible).toBe(true);
  });

  it('enforces budgets, fails on videoVisible false, and warns on videoVisible null or overlap', () => {
    const base: DesktopResult = aggregateDesktopRuns(
      [makeLine()],
      [{ limitResponses: 0, overlapMs: 0 }],
    );
    expect(compareDesktop(base, base)).toEqual({ ok: true, failures: [], warnings: [] });

    const blank = compareDesktop({ ...base, videoVisible: false, distinct: 2 }, base);
    expect(blank.ok).toBe(false);
    expect(blank.failures.some((f) => f.includes('videoVisible'))).toBe(true);

    const uncaptured = compareDesktop(
      { ...base, videoVisible: null, distinct: 0, overlapMs: 25 },
      base,
    );
    expect(uncaptured.ok).toBe(true);
    expect(uncaptured.warnings.some((w) => w.includes('videoVisible'))).toBe(true);
    expect(uncaptured.warnings.some((w) => w.includes('25 ms'))).toBe(true);

    const broken = compareDesktop(
      {
        ...base,
        ttffColdMs: 2100,
        mpvSpawns: 2,
        engineWedged: 1,
        vod: { playing: true, seeked: false },
      },
      undefined,
    );
    expect(broken.ok).toBe(false);
    expect(broken.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cold start 2100 ms'),
        expect.stringContaining('mpvSpawns 2'),
        expect.stringContaining('engineWedged 1'),
        expect.stringContaining('VOD seek'),
      ]),
    );

    const soft = compareDesktop({ ...base, ttffColdMs: 2100 }, undefined, { budgets: 'warn' });
    expect(soft.ok).toBe(true);
    expect(soft.warnings.some((w) => w.includes('--budgets warn'))).toBe(true);
  });
});

describe('judgeDesktopFault', () => {
  it('accepts drop5, 404, 509, notice, stall, slowstart and silent within their windows', () => {
    expect(
      judgeDesktopFault(
        'drop5',
        makeLine({ fault: 'drop5', faultOutcome: 'recovered', zaps: 1 }),
        [makeEntry(0, 5000), makeEntry(6200, 3000)],
        '1001',
      ).failures,
    ).toEqual([]);

    expect(
      judgeDesktopFault(
        '404',
        makeLine({ fault: '404', faultOutcome: 'failed-in-time', zaps: 1, failures: 1 }),
        [
          makeEntry(0, 20, { status: 404, bytes: 0 }),
          makeEntry(1050, 20, { status: 404, bytes: 0 }),
        ],
        '1001',
      ).failures,
    ).toEqual([]);

    expect(
      judgeDesktopFault(
        '509',
        makeLine({ fault: '509', faultOutcome: 'limited-backoff', zaps: 1 }),
        [
          makeEntry(0, 15, { status: 509, bytes: 0, query: { fault: 'status=509' } }),
          makeEntry(2020, 15, { status: 509, bytes: 0, query: { fault: 'status=509' } }),
        ],
        '1001',
      ).failures,
    ).toEqual([]);

    expect(
      judgeDesktopFault(
        'notice',
        makeLine({ fault: 'notice', faultOutcome: 'limited-backoff', zaps: 1 }),
        [
          makeEntry(0, 20, { status: 200, bytes: 23, query: { fault: 'text-notice' } }),
          makeEntry(2050, 20, { status: 200, bytes: 23, query: { fault: 'text-notice' } }),
        ],
        '1001',
      ).failures,
    ).toEqual([]);

    expect(
      judgeDesktopFault(
        'stall',
        makeLine({ fault: 'stall', faultOutcome: 'recovered', zaps: 1 }),
        [makeEntry(0, 6000), makeEntry(6100, 3000)],
        '1001',
      ).failures,
    ).toEqual([]);

    expect(
      judgeDesktopFault(
        'slowstart',
        makeLine({ fault: 'slowstart', faultOutcome: 'left', zaps: 1, coalesceMaxMs: 240 }),
        [
          makeEntry(0, 820, { bytes: 0, query: { fault: 'slow-start=3' } }),
          makeEntry(830, 1500, { streamId: 1004, path: '/live/demo/demo/1004.ts' }),
        ],
        '1001',
      ).failures,
    ).toEqual([]);

    expect(
      judgeDesktopFault(
        'silent',
        makeLine({ fault: 'silent', faultOutcome: 'failed-in-time', zaps: 1, failures: 1 }),
        [makeEntry(0, 5000, { bytes: 0 }), makeEntry(5020, 2000, { bytes: 0 })],
        '1001',
      ).failures,
    ).toEqual([]);
  });

  it('checks every 509 and notice backoff interval against the 2, 4, 8, then 15 s ladder (#83)', () => {
    const limited = (start: number) =>
      makeEntry(start, 5, { status: 509, bytes: 0, query: { fault: 'status=509' } });
    const notice = (start: number) =>
      makeEntry(start, 5, { status: 200, bytes: 23, query: { fault: 'text-notice' } });
    const judge = (fault: '509' | 'notice', entries: SimLogEntry[]) =>
      judgeDesktopFault(
        fault,
        makeLine({ fault, faultOutcome: 'limited-backoff', zaps: 1 }),
        entries,
        '1001',
      );
    expect(judge('509', [limited(0), limited(2005), limited(6010), limited(14_015)])).toEqual({
      failures: [],
      warnings: [],
    });
    expect(judge('509', [limited(0), limited(2005), limited(3010)]).failures).toEqual([
      '509: next request came 1000 ms after 509 2, before the 4000 ms backoff',
    ]);
    expect(
      judge('509', [limited(0), limited(2005), limited(6010), limited(10_015)]).failures,
    ).toEqual(['509: next request came 4000 ms after 509 3, before the 8000 ms backoff']);
    expect(judge('notice', [notice(0), notice(2005), notice(4010)]).failures).toEqual([
      'notice: next request came 2000 ms after notice 2, before the 4000 ms backoff',
    ]);
    expect(judge('notice', [notice(0), notice(500)]).failures).toEqual([
      'notice: next request came 495 ms after the notice, before the 2000 ms backoff',
    ]);
    expect(judge('509', [makeEntry(0, 2500, { status: 509, bytes: 0 })]).failures).toEqual([
      '509: first limit answer took 2500 ms, limit 2000 ms',
    ]);
    expect(
      judgeDesktopFault(
        '509',
        makeLine({ fault: '509', faultOutcome: 'limited-backoff', zaps: 1, limitedAfterMs: 2400 }),
        [limited(0), limited(2005)],
        '1001',
      ).failures,
    ).toEqual(['509: the screen entered limited 2400 ms after the tune, limit 2000 ms']);
  });

  it('rejects missed outcomes and wedged engines', () => {
    const bad = judgeDesktopFault(
      'stall',
      makeLine({ fault: 'stall', faultOutcome: 'missed', zaps: 1, engineWedged: 1 }),
      [makeEntry(0, 6000)],
      '1001',
    );
    expect(bad.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('engineWedged 1'),
        expect.stringContaining('missed'),
      ]),
    );
  });
});

describe('runDesktopGate', () => {
  function fakeRig(opts: { orphanCloseAfterMs?: number | null }) {
    let simStarts = 0;
    let clock = T0;
    let killed = false;
    const spawnedArgs: string[][] = [];
    let currentEntries: SimLogEntry[] = [];

    const faultScripts: Record<string, { line: DesktopLine; entries: SimLogEntry[] }> = {
      drop5: {
        line: makeLine({ fault: 'drop5', faultOutcome: 'recovered', zaps: 1, vod: null }),
        entries: [makeEntry(0, 5000), makeEntry(5500, 3000)],
      },
      '404': {
        line: makeLine({
          fault: '404',
          faultOutcome: 'failed-in-time',
          zaps: 1,
          failures: 1,
          vod: null,
        }),
        entries: [makeEntry(0, 20, { status: 404, bytes: 0 })],
      },
      '509': {
        line: makeLine({ fault: '509', faultOutcome: 'limited-backoff', zaps: 1, vod: null }),
        entries: [
          makeEntry(0, 15, { status: 509, bytes: 0, query: { fault: 'status=509' } }),
          makeEntry(2020, 15, { status: 509, bytes: 0, query: { fault: 'status=509' } }),
        ],
      },
      notice: {
        line: makeLine({ fault: 'notice', faultOutcome: 'limited-backoff', zaps: 1, vod: null }),
        entries: [makeEntry(0, 15, { status: 200, bytes: 23, query: { fault: 'text-notice' } })],
      },
      stall: {
        line: makeLine({ fault: 'stall', faultOutcome: 'recovered', zaps: 1, vod: null }),
        entries: [makeEntry(0, 6000), makeEntry(6100, 2000)],
      },
      slowstart: {
        line: makeLine({ fault: 'slowstart', faultOutcome: 'left', zaps: 1, vod: null }),
        entries: [
          makeEntry(0, 810, { bytes: 0, query: { fault: 'slow-start=3' } }),
          makeEntry(820, 1200, { streamId: 1004, path: '/live/demo/demo/1004.ts' }),
        ],
      },
      silent: {
        line: makeLine({
          fault: 'silent',
          faultOutcome: 'failed-in-time',
          zaps: 1,
          failures: 1,
          vod: null,
        }),
        entries: [makeEntry(0, 5000, { bytes: 0 }), makeEntry(5010, 2000, { bytes: 0 })],
      },
    };

    const deps: DesktopGateDeps = {
      ffmpeg: () => '/usr/bin/ffmpeg',
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      startSim: async () => {
        simStarts += 1;
        return {
          url: 'http://127.0.0.1:51234',
          clearRequests: async () => {
            currentEntries = [];
          },
          requests: async () => currentEntries,
          close: async () => {},
        };
      },
      spawnApp: (args): AppHandle => {
        spawnedArgs.push([...args]);
        const query = (args[0] ?? '').replace(/^--elv-gate=/, '');
        const q = new URLSearchParams(query);
        const fault = q.get('fault') ?? '';
        const zaps = Number(q.get('zaps') ?? '30');
        const isOrphan = fault === '' && zaps === 1 && !query.includes('vod=');
        if (isOrphan) {
          let resolveExit = (_code: number | null) => {};
          const exited = new Promise<number | null>((r) => {
            resolveExit = r;
          });
          return {
            pid: 9001,
            lines: linesOf(['ELV_GATE_PLAYING']),
            exited,
            kill: () => {
              killed = true;
              if (opts.orphanCloseAfterMs !== null && opts.orphanCloseAfterMs !== undefined) {
                currentEntries = [
                  {
                    ...makeEntry(0, 1000 + opts.orphanCloseAfterMs),
                    t: new Date(clock + opts.orphanCloseAfterMs).toISOString(),
                  },
                ];
              }
              resolveExit(null);
            },
          };
        }
        if (fault !== '') {
          const script = faultScripts[fault];
          if (!script) throw new Error(`unexpected fault ${fault}`);
          currentEntries = script.entries;
          return {
            pid: 9000,
            lines: linesOf([`ELV_GATE_PLAYER ${JSON.stringify(script.line)}`]),
            exited: Promise.resolve(0),
            kill: () => {},
          };
        }
        currentEntries = [makeEntry(0, 1000), makeEntry(1010, 1000)];
        return {
          pid: 8999,
          lines: linesOf([`ELV_GATE_PLAYER ${JSON.stringify(makeLine({ zaps }))}`]),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
    };
    return { deps, getSimStarts: () => simStarts, wasKilled: () => killed, spawnedArgs };
  }

  it('runs zap runs, all faults, and passes when orphan stream closes within 2000 ms', async () => {
    const rig = fakeRig({ orphanCloseAfterMs: 320 });
    const out = await runDesktopGate({ runs: 2, zaps: 10, faults: true }, rig.deps);
    expect(rig.getSimStarts()).toBe(1);
    expect(out.runs).toHaveLength(2);
    expect(out.result.zaps).toBe(10);
    expect(out.faults.every((f) => f.failures.length === 0)).toBe(true);
    expect(rig.wasKilled()).toBe(true);
    expect(out.orphan).toEqual({ ok: true, closeMs: 320, failures: [] });
  });

  it('fails the orphan check when the stream stays open past 2000 ms', async () => {
    const rig = fakeRig({ orphanCloseAfterMs: 2450 });
    const out = await runDesktopGate({ runs: 1, zaps: 5, faults: true }, rig.deps);
    expect(out.orphan?.ok).toBe(false);
    expect(out.orphan?.closeMs).toBe(2450);
    expect(out.orphan?.failures[0]).toContain('2450 ms');
  });

  it('skips starting a local simulator when --sim is supplied', async () => {
    const rig = fakeRig({ orphanCloseAfterMs: 200 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { method?: string }) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify([makeEntry(0, 500)]))) as typeof fetch;
    try {
      const out = await runDesktopGate(
        { runs: 1, zaps: 5, simUrl: 'http://100.85.192.47:7879' },
        { ...rig.deps, ffmpeg: () => null },
      );
      expect(rig.getSimStarts()).toBe(0);
      expect(out.result.zaps).toBe(5);
      expect(rig.spawnedArgs[0]?.[0]).toContain('base=http://100.85.192.47:7879');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('desktopMain CLI', () => {
  it('refuses --write-baseline without --faults or when apps/desktop has uncommitted changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-desktop-cli-'));
    try {
      expect(DESKTOP_USAGE).toContain('pnpm gate desktop');
      const err: string[] = [];
      const out: string[] = [];
      const code1 = await desktopMain({ 'write-baseline': true }, dir, {
        platform: 'win32',
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
        exec: async () => ({ ok: true, output: '' }),
        runGate: async () => {
          throw new Error('should not run');
        },
      });
      expect(code1).toBe(2);
      expect(err.join('')).toContain('--faults');

      err.length = 0;
      const sampleResult = aggregateDesktopRuns(
        [makeLine()],
        [{ limitResponses: 0, overlapMs: 0 }],
      );
      const code2 = await desktopMain({ 'write-baseline': true, faults: true }, dir, {
        platform: 'win32',
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
        exec: async (_cmd, args) =>
          args[0] === 'rev-parse'
            ? { ok: true, output: 'abc1234\n' }
            : { ok: true, output: ' M apps/desktop/src/main/main.ts\n' },
        runGate: async () => ({
          result: sampleResult,
          runs: [sampleResult],
          faults: [],
          orphan: { ok: true, closeMs: 210, failures: [] },
        }),
      });
      expect(code2).toBe(2);
      expect(err.join('')).toContain('uncommitted');

      const code3 = await desktopMain({ 'write-baseline': true, faults: true }, dir, {
        platform: 'win32',
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
        exec: async (_cmd, args) =>
          args[0] === 'rev-parse' ? { ok: true, output: 'abc1234\n' } : { ok: true, output: '' },
        runGate: async () => ({
          result: sampleResult,
          runs: [sampleResult],
          faults: [],
          orphan: { ok: true, closeMs: 210, failures: [] },
        }),
      });
      expect(code3).toBe(0);
      const written = JSON.parse(
        readFileSync(join(dir, 'docs/learned/gates/player-desktop-windows.json'), 'utf8'),
      );
      expect(written.commit).toBe('abc1234');
      expect(written.result.ttffColdMs).toBe(820);

      writeFileSync(
        join(dir, 'docs/learned/gates/player-desktop-windows.json'),
        JSON.stringify(written),
      );
      const code4 = await desktopMain({ faults: true }, dir, {
        platform: 'win32',
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
        exec: async () => ({ ok: true, output: 'abc1234\n' }),
        runGate: async () => ({
          result: sampleResult,
          runs: [sampleResult],
          faults: [],
          orphan: { ok: true, closeMs: 210, failures: [] },
        }),
      });
      expect(code4).toBe(0);
      const report = JSON.parse(readFileSync(join(dir, 'gate-desktop.json'), 'utf8'));
      expect(report.outcome.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
