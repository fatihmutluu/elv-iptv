import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/adb.ts';
import { IMPORT_USAGE } from '../src/gates/import-cli.ts';
import {
  compareImport,
  type ImportResult,
  parseImportLine,
  runImportGate,
} from '../src/gates/import-gate.ts';

const PKG = 'io.github.fatihmutluu.elviptv.dev';
const S = '-s emulator-5554';
const URL_LARGE = 'elviptv://gate/import?host=10.0.2.2:7878&account=large&batch=5000&maxBody=4096';

const importLine = (duration: number, stall: number, account = 'large', rows = 95500) =>
  `11-14 10:00:00.000  4581  4640 I ReactNativeJS: ELV_GATE_IMPORT ${JSON.stringify({
    account,
    batch: 5000,
    maxBody: 4096,
    rows,
    durationMs: duration,
    maxStallMs: stall,
  })}`;

function fakeAdb(lines: string[], opts: { install?: boolean } = {}) {
  const calls: string[] = [];
  let starts = 0;
  const exec: Exec = async (_command, args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line === 'devices') {
      return { ok: true, output: 'List of devices attached\nemulator-5554\tdevice\n' };
    }
    const rest = line.replace(/^-s emulator-5554 /, '');
    if (rest.startsWith('install')) {
      return opts.install === false
        ? { ok: false, output: 'adb: failed' }
        : { ok: true, output: 'Success' };
    }
    if (rest.startsWith('shell getprop sys.boot_completed')) return { ok: true, output: '1\n' };
    if (rest.startsWith('shell am start')) starts++;
    if (rest === 'shell dumpsys activity activities') {
      return {
        ok: true,
        output: `  topResumedActivity=ActivityRecord{1a u0 ${PKG}/.MainActivity t1}`,
      };
    }
    if (rest === 'logcat -d -s ReactNativeJS:V') {
      return { ok: true, output: lines[Math.min(starts, lines.length) - 1] ?? '' };
    }
    return { ok: true, output: '' };
  };
  return { calls, exec };
}

function fakeSim(reused = false) {
  const events: string[] = [];
  return {
    events,
    sim: {
      ensure: async () => {
        events.push(reused ? 'reuse' : 'start');
        return {
          reused,
          stop: async () => {
            events.push('stop');
          },
        };
      },
    },
  };
}

const noSleep = async () => {};
const base: ImportResult = {
  account: 'large',
  batch: 5000,
  maxBody: 4096,
  rows: 95500,
  durationMs: 18000,
  maxStallMs: 45,
};

describe('parseImportLine', () => {
  it('returns the last well-formed line among noise', () => {
    const text = [importLine(1, 1), 'I ReactNativeJS: other', importLine(20000, 50)].join('\n');
    expect(parseImportLine(text)).toMatchObject({ durationMs: 20000, maxStallMs: 50 });
  });

  it('reports the error of a failed import', () => {
    const line =
      'ELV_GATE_IMPORT {"account":"huge","batch":5000,"error":"network/stream-failed","maxStallMs":1060.1}';
    expect(parseImportLine(line)).toEqual({ error: 'network/stream-failed' });
  });

  it('ignores broken lines', () => {
    expect(parseImportLine('ELV_GATE_IMPORT {"rows":1')).toBeUndefined();
    expect(parseImportLine('ELV_GATE_IMPORT {"rows":1}')).toBeUndefined();
    expect(parseImportLine('nothing')).toBeUndefined();
  });
});

describe('compareImport', () => {
  it('passes a run within 10 percent of the baseline and under the stall budget', () => {
    const out = compareImport({ ...base, durationMs: 19500, maxStallMs: 99 }, base);
    expect(out).toEqual({ ok: true, failures: [], warnings: [] });
  });

  it('fails when the duration grows more than 10 percent plus 2 s slack', () => {
    expect(compareImport({ ...base, durationMs: 20000 }, base).ok).toBe(true);
    const out = compareImport({ ...base, durationMs: 22000 }, base);
    expect(out.ok).toBe(false);
    expect(out.failures[0]).toMatch(/duration 22000 ms.*baseline 18000/);
  });

  it('fails above the absolute 100 ms stall budget, or only warns with warn', () => {
    expect(compareImport({ ...base, maxStallMs: 101 }, base).failures[0]).toMatch(/100 ms/);
    const warned = compareImport({ ...base, maxStallMs: 101 }, base, { budgets: 'warn' });
    expect(warned.ok).toBe(true);
    expect(warned.warnings[0]).toMatch(/100 ms/);
  });

  it('fails when the row count differs from the baseline', () => {
    const out = compareImport({ ...base, rows: 95000 }, base);
    expect(out.failures[0]).toMatch(/rows 95000.*95500/);
  });

  it('is not comparable across other account, batch or body cap', () => {
    const out = compareImport({ ...base, batch: 1000 }, base);
    expect(out.ok).toBe(false);
    expect(out.failures[0]).toMatch(/not comparable/);
  });

  it('without a baseline checks the stall budget and warns', () => {
    const out = compareImport({ ...base, maxStallMs: 300 }, undefined);
    expect(out.ok).toBe(false);
    const fine = compareImport(base, undefined);
    expect(fine.ok).toBe(true);
    expect(fine.warnings[0]).toMatch(/no baseline/);
  });

  it('is report-only for the huge account', () => {
    const huge = { ...base, account: 'huge', rows: 356000, durationMs: 146000, maxStallMs: 190 };
    const out = compareImport(huge, { ...huge, durationMs: 100000, rows: 1 });
    expect(out.ok).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/report-only/);
  });
});

describe('runImportGate', () => {
  it('starts the simulator, sends the route and stops the simulator', async () => {
    const device = fakeAdb([importLine(18834, 45.5)]);
    const { sim, events } = fakeSim();
    const result = await runImportGate({ exec: device.exec, sim, sleep: noSleep, runs: 1 });
    expect(events).toEqual(['start', 'stop']);
    expect(device.calls).toEqual([
      'devices',
      `${S} shell getprop sys.boot_completed`,
      expect.stringMatching(/^-s emulator-5554 install -r .*app-release\.apk$/),
      `${S} shell am force-stop ${PKG}`,
      `${S} logcat -c`,
      `${S} shell am start -a android.intent.action.VIEW -d '${URL_LARGE}' ${PKG}`,
      `${S} shell dumpsys activity activities`,
      `${S} logcat -d -s ReactNativeJS:V`,
    ]);
    expect(result).toEqual({
      account: 'large',
      batch: 5000,
      maxBody: 4096,
      rows: 95500,
      durationMs: 18834,
      maxStallMs: 45.5,
    });
  });

  it('sends the chosen account, batch and body cap', async () => {
    const device = fakeAdb([importLine(1, 1, 'huge')]);
    await runImportGate({
      exec: device.exec,
      sim: fakeSim().sim,
      sleep: noSleep,
      account: 'huge',
      batch: 1000,
      maxBody: 1024,
    });
    expect(device.calls.some((c) => c.includes('account=huge&batch=1000&maxBody=1024'))).toBe(true);
  });

  it('takes the median of several runs', async () => {
    const device = fakeAdb([importLine(30000, 50), importLine(10000, 90), importLine(20000, 70)]);
    const seen: number[] = [];
    const result = await runImportGate({
      exec: device.exec,
      sim: fakeSim().sim,
      sleep: noSleep,
      runs: 3,
      onRun: (r) => seen.push(r.durationMs),
    });
    expect(seen).toEqual([30000, 10000, 20000]);
    expect(result.durationMs).toBe(20000);
    expect(result.maxStallMs).toBe(70);
    expect(device.calls.filter((c) => c.includes('install')).length).toBe(1);
  });

  it('runs three times by default and returns the median, like the list gate', async () => {
    const device = fakeAdb([importLine(27000, 80), importLine(17600, 40), importLine(17800, 42)]);
    const seen: number[] = [];
    const result = await runImportGate({
      exec: device.exec,
      sim: fakeSim().sim,
      sleep: noSleep,
      onRun: (r) => seen.push(r.durationMs),
    });
    expect(seen).toEqual([27000, 17600, 17800]);
    expect(result).toMatchObject({ durationMs: 17800, maxStallMs: 42 });
    expect(IMPORT_USAGE).toContain('[--runs 3 (default)]');
  });

  it('says so when it reuses a running simulator and leaves it running', async () => {
    const device = fakeAdb([importLine(1, 1)]);
    const { sim, events } = fakeSim(true);
    const notes: string[] = [];
    await runImportGate({
      exec: device.exec,
      sim,
      sleep: noSleep,
      onNote: (n) => notes.push(n),
    });
    expect(notes.join(' ')).toMatch(/already running/);
    expect(events).toEqual(['reuse', 'stop']);
  });

  it('waits up to 3 minutes for large and 10 for huge', async () => {
    for (const [account, minutes] of [
      ['large', 3],
      ['huge', 10],
    ] as const) {
      const device = fakeAdb(['I ReactNativeJS: hello']);
      let slept = 0;
      await expect(
        runImportGate({
          exec: device.exec,
          sim: fakeSim().sim,
          account,
          sleep: async (ms) => {
            slept += ms;
          },
        }),
      ).rejects.toThrow(/no ELV_GATE_IMPORT line within/);
      expect(slept).toBeGreaterThanOrEqual(minutes * 60_000);
      expect(slept).toBeLessThan((minutes + 1) * 60_000);
    }
  });

  it('throws the error of a failed import and still stops the simulator', async () => {
    const device = fakeAdb([
      'ELV_GATE_IMPORT {"account":"huge","batch":5000,"error":"network/stream-failed","maxStallMs":1}',
    ]);
    const { sim, events } = fakeSim();
    await expect(
      runImportGate({ exec: device.exec, sim, sleep: noSleep, account: 'huge' }),
    ).rejects.toThrow(/network\/stream-failed/);
    expect(events).toEqual(['start', 'stop']);
  });

  it('stops the simulator when the install fails', async () => {
    const device = fakeAdb([], { install: false });
    const { sim, events } = fakeSim();
    await expect(runImportGate({ exec: device.exec, sim, sleep: noSleep })).rejects.toThrow(
      /install/,
    );
    expect(events).toEqual(['start', 'stop']);
  });

  it('builds the development APK first when asked', async () => {
    const device = fakeAdb([importLine(1, 1)]);
    const builds: string[] = [];
    const exec: Exec = async (command, args, opts) => {
      if (command !== 'adb') {
        builds.push(`${command} ${args.join(' ')} @${opts?.cwd ?? ''}`);
        return { ok: true, output: '' };
      }
      return device.exec(command, args);
    };
    await runImportGate({
      exec,
      sim: fakeSim().sim,
      sleep: noSleep,
      build: true,
      root: '/repo',
      adb: 'adb',
    });
    expect(builds[0]).toMatch(/expo prebuild --clean --platform android --no-install/);
    expect(builds[1]).toMatch(/assembleRelease/);
  });

  it('rejects an unknown account', async () => {
    const device = fakeAdb([]);
    await expect(
      runImportGate({ exec: device.exec, sim: fakeSim().sim, sleep: noSleep, account: 'tiny' }),
    ).rejects.toThrow(/large or huge/);
  });
});
