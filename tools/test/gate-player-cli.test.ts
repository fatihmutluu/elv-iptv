import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/adb.ts';
import {
  PLAYER_USAGE,
  type PlayerCli,
  type PlayerCliIo,
  playerMain,
} from '../src/gates/player-cli.ts';
import type { FaultReport, PlayerGateOptions, PlayerGateOutput } from '../src/gates/player-gate.ts';
import { aggregateRuns } from '../src/gates/player-judge.ts';
import { line } from './gate-player-fixtures.ts';

const result = aggregateRuns([line()], [{ limitResponses: 0, overlapMs: 0 }]);

const output = (over: Partial<PlayerGateOutput> = {}): PlayerGateOutput => ({
  device: { model: 'sim' },
  result,
  runs: [result],
  faults: [],
  crashes: [],
  ...over,
});

const fault = (failures: string[] = []): FaultReport => ({
  fault: '509',
  line: line({ fault: '509', faultOutcome: 'limited-backoff', zaps: 1, limitedAfterMs: 120 }),
  failures,
  warnings: [],
  limitResponses: 0,
  overlapMs: 0,
  crashes: [],
});

let root = '';
let out: string[] = [];
let err: string[] = [];
let calls: PlayerGateOptions[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elv-player-cli-'));
  out = [];
  err = [];
  calls = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const gitExec =
  (dirty = ''): Exec =>
  async (_command, args) =>
    args[0] === 'rev-parse' ? { ok: true, output: 'abc1234\n' } : { ok: true, output: dirty };

const main = (
  values: PlayerCli,
  gate: () => Promise<PlayerGateOutput> = async () => output(),
  exec: Exec = gitExec(),
) => {
  const io: PlayerCliIo = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    exec,
    runGate: (opts) => {
      calls.push(opts);
      return gate();
    },
  };
  return playerMain(values, root, io);
};

const BASELINE = 'docs/learned/gates/player-android-tv.json';

const writeBaseline = (name = BASELINE) => {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ device: {}, build: '', commit: 'x', date: '', result }));
};

describe('playerMain usage errors', () => {
  it.each<[string, PlayerCli, RegExp]>([
    ['an unknown target', { target: 'webos' }, /--target is android-tv, tvos or ios/],
    ['an unknown stream', { stream: 'dash' }, /--stream is ts, hls or vod/],
    ['non-numeric channels', { channels: '1001,abc' }, /--channels/],
    ['an empty channel', { channels: '1001,' }, /--channels/],
    [
      'more than 20 channels',
      { channels: Array.from({ length: 21 }, (_, i) => String(1000 + i)).join(',') },
      /--channels/,
    ],
    ['a rate below 0.05', { rate: '0.01' }, /--rate/],
    ['a rate above 5', { rate: '6' }, /--rate/],
    ['a negative rate', { rate: '-1' }, /--rate/],
    ['a burst above 30', { burst: '31' }, /--burst/],
    ['a non-numeric burst', { burst: 'x' }, /--burst/],
    ['zero runs', { runs: '0' }, /--runs and --zaps/],
    ['fractional zaps', { zaps: '1.5' }, /--runs and --zaps/],
    ['more than 200 zaps', { zaps: '201' }, /--runs and --zaps/],
    ['more than 100 runs', { runs: '101' }, /--runs and --zaps/],
    ['a zero soak', { soak: '0' }, /--soak is an integer from 1 to 180/],
    ['a soak above 180', { soak: '181' }, /--soak is an integer from 1 to 180/],
    ['soak with stress', { soak: '5', stress: true }, /mutually exclusive/],
    ['an unknown budgets mode', { budgets: 'maybe' }, /--budgets is fail or warn/],
    ['a soak baseline', { 'write-baseline': true, faults: true, soak: '5' }, /standard zap runs/],
    [
      'a stress baseline',
      { 'write-baseline': true, faults: true, stress: true },
      /standard zap runs/,
    ],
    ['a baseline without faults', { 'write-baseline': true }, /baseline needs --faults/],
    [
      'an HLS baseline',
      { 'write-baseline': true, faults: true, stream: 'hls' },
      /default live TS channel set/,
    ],
    [
      'a custom channel baseline',
      { 'write-baseline': true, faults: true, channels: '1001' },
      /default live TS channel set/,
    ],
    [
      'a warn-mode local baseline',
      { 'write-baseline': true, faults: true, budgets: 'warn' },
      /--budgets warn/,
    ],
    ['an Apple target without --app', { target: 'tvos' }, /--target tvos requires --app/],
    ['an Apple target with an empty --app', { target: 'ios', app: '' }, /requires --app/],
    ['an Apple target with --build', { target: 'ios', app: 'a.app', build: true }, /Android-only/],
  ])('returns 2 for %s without starting the gate', async (_name, values, message) => {
    expect(await main(values)).toBe(2);
    const text = err.join('');
    expect(text).toMatch(message);
    expect(text).toContain(PLAYER_USAGE);
    expect(calls).toEqual([]);
    expect(out).toEqual([]);
  });

  it('names the player gate options in PLAYER_USAGE', () => {
    expect(PLAYER_USAGE).toMatch(/gate player.*--target.*--burst.*--soak.*--stress/);
  });
});

describe('playerMain runs', () => {
  it('returns 1 with the error when the gate throws', async () => {
    const code = await main({}, async () => {
      throw new Error('gate: no emulator');
    });
    expect(code).toBe(1);
    expect(err.join('')).toBe('gate: no emulator\n');
  });

  it('passes the parsed options to the gate', async () => {
    writeBaseline();
    await main({
      channels: '1001,1002',
      rate: '0.25',
      burst: '8',
      runs: '2',
      zaps: '10',
      faults: true,
      avd: 'elv_tv',
      build: true,
    });
    expect(calls[0]).toMatchObject({
      target: 'android-tv',
      stream: 'ts',
      channels: ['1001', '1002'],
      rate: 0.25,
      burst: 8,
      runs: 2,
      zaps: 10,
      faults: true,
      avd: 'elv_tv',
      build: true,
      root,
    });
    await main({ target: 'tvos', app: 'ELV.app', device: 'Apple TV', soak: '3' });
    expect(calls[1]).toMatchObject({
      target: 'tvos',
      app: 'ELV.app',
      deviceName: 'Apple TV',
      soak: 3,
    });
  });

  it('fails a default run without a baseline and passes against one', async () => {
    expect(await main({})).toBe(1);
    expect(out.join('')).toMatch(
      /FAIL: no baseline at docs\/learned\/gates\/player-android-tv.json/,
    );
    out = [];
    writeBaseline();
    expect(await main({})).toBe(0);
    expect(out.join('')).toMatch(/gate player: passed/);
    const report = JSON.parse(readFileSync(join(root, 'gate-player.json'), 'utf8'));
    expect(report).toMatchObject({ commit: 'abc1234', baseline: BASELINE, outcome: { ok: true } });
  });

  it('passes a custom probe without a baseline and writes --out', async () => {
    expect(await main({ stream: 'hls', out: 'reports/hls.json' })).toBe(0);
    expect(existsSync(join(root, 'reports/hls.json'))).toBe(true);
  });

  it('fails when a fault run or a crash report failed', async () => {
    writeBaseline();
    expect(
      await main({ faults: true }, async () => output({ faults: [fault(['509: late'])] })),
    ).toBe(1);
    expect(out.join('')).toMatch(/FAIL: 509: late/);
    expect(await main({}, async () => output({ crashes: ['elv-1.crash'] }))).toBe(1);
    expect(out.join('')).toMatch(/crash reports newer than the run: elv-1.crash/);
  });

  it('judges soak and stress runs by their verdict', async () => {
    const soak = output({
      soak: {
        minutes: 1,
        stream: 'ts',
        line: line(),
        memory: { firstMb: null, lastMb: null },
        crashes: [],
        limitResponses: 0,
        overlapMs: 0,
        verdict: { failures: ['soak: 1 stalls'], warnings: [] },
      },
    });
    expect(await main({ soak: '1' }, async () => soak)).toBe(1);
    expect(out.join('')).toMatch(/FAIL: soak: 1 stalls/);
    const stress = output({
      stress: { zaps: 200, runs: [], verdict: { failures: [], warnings: [] } },
    });
    expect(await main({ stress: true }, async () => stress)).toBe(0);
  });

  it('writes a baseline only from a clean tree with passing faults', async () => {
    const values: PlayerCli = { 'write-baseline': true, faults: true };
    expect(await main(values, async () => output({ faults: [fault(['509: late'])] }))).toBe(2);
    expect(err.join('')).toMatch(/refusing to write a baseline: 509: late/);
    err = [];
    expect(await main(values, undefined, gitExec(' M apps/tv-mobile/src/x.ts\n'))).toBe(2);
    expect(err.join('')).toMatch(/uncommitted app or package changes/);
    expect(await main(values, async () => output({ faults: [fault()] }))).toBe(0);
    const written = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
    expect(written).toMatchObject({ commit: 'abc1234', result });
    expect(out.join('')).toMatch(
      /baseline written to docs\/learned\/gates\/player-android-tv.json/,
    );
  });
});
