import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Exec,
  parseGateLine,
  resolveAdb,
  runListGate,
  topActivity,
} from '../src/gates/list-gate.ts';

const PKG = 'io.github.fatihmutluu.elviptv.dev';
const GFX = readFileSync(new URL('./fixtures/gate/gfxinfo-run.txt', import.meta.url), 'utf8');
const AUTO_URL = 'elviptv://gate/list?items=100000&auto=1&rate=20&moves=600';
const S = '-s emulator-5554';

const gateLine = (p95: number, gap = 8, losses = 0, moves = 600, stall = 12, coalesced = 0) =>
  `11-13 10:00:00.000  4581  4640 I ReactNativeJS: ELV_GATE ${JSON.stringify({
    moves,
    scripted: moves + coalesced,
    coalesced,
    losses,
    keyToHighlightMs: { p50: 18, p95, max: p95 + 3 },
    maxJsGapMs: gap,
    maxFrameStallMs: stall,
    items: 100000,
  })}`;

const top = (activity: string) =>
  `  topResumedActivity=ActivityRecord{1a2b3c u0 ${activity} t12}\n  mResumedActivity: x`;

interface Device {
  calls: string[];
  exec: Exec;
}

/** A scripted adb: `logcat` answers come from `lines` (one per `am start`), the foreground from `tops`. */
function fakeAdb(opts: { lines: string[]; tops?: string[]; install?: boolean }): Device {
  const calls: string[] = [];
  let starts = 0;
  let topCalls = 0;
  const tops = opts.tops ?? [top(`${PKG}/.MainActivity`)];
  const exec: Exec = async (_command, args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line === 'devices') {
      return { ok: true, output: 'List of devices attached\nemulator-5554\tdevice\n' };
    }
    const rest = line.replace(/^-s emulator-5554 /, '');
    if (rest.startsWith('install')) {
      return opts.install === false
        ? { ok: false, output: 'adb: failed to install' }
        : { ok: true, output: 'Success' };
    }
    if (rest.startsWith('shell getprop sys.boot_completed')) return { ok: true, output: '1\n' };
    if (rest.startsWith('shell am start')) starts++;
    if (rest === 'shell dumpsys activity activities') {
      const text = tops[Math.min(topCalls, tops.length - 1)] ?? '';
      topCalls++;
      return { ok: true, output: text };
    }
    if (rest === 'logcat -d -s ReactNativeJS:V') {
      return { ok: true, output: opts.lines[Math.min(starts, opts.lines.length) - 1] ?? '' };
    }
    if (rest === `shell dumpsys gfxinfo ${PKG}`) return { ok: true, output: GFX };
    return { ok: true, output: '' };
  };
  return { calls, exec };
}

const noSleep = async () => {};

describe('parseGateLine', () => {
  it('returns the last valid line among noise', () => {
    const text = [gateLine(10), 'I ReactNativeJS: other', gateLine(30)].join('\n');
    expect(parseGateLine(text)?.keyToHighlightMs.p95).toBe(30);
  });

  it('accepts a line without the frame stall or the scripted count', () => {
    const line =
      'ELV_GATE {"moves":1,"coalesced":0,"losses":0,"keyToHighlightMs":{"p50":1,"p95":2,"max":3},"maxJsGapMs":4,"items":5}';
    const metrics = parseGateLine(line);
    expect(metrics?.maxJsGapMs).toBe(4);
    expect(metrics?.maxFrameStallMs).toBeUndefined();
    expect(metrics?.scripted).toBeUndefined();
  });

  it('reads the scripted count', () => {
    expect(parseGateLine(gateLine(10, 8, 0, 597, 12, 3))).toMatchObject({
      moves: 597,
      scripted: 600,
      coalesced: 3,
    });
  });

  it('ignores broken or incomplete lines', () => {
    expect(parseGateLine('ELV_GATE {"moves":1')).toBeUndefined();
    expect(parseGateLine('ELV_GATE {"moves":1}')).toBeUndefined();
    expect(parseGateLine('nothing here')).toBeUndefined();
    expect(parseGateLine(`${gateLine(10)}\nELV_GATE {oops}`)?.keyToHighlightMs.p95).toBe(10);
  });
});

describe('topActivity', () => {
  it('reads the resumed activity component', () => {
    expect(topActivity(top('com.google.android.tvlauncher/.dialog.ShowDialogsActivity'))).toBe(
      'com.google.android.tvlauncher/.dialog.ShowDialogsActivity',
    );
    expect(topActivity('nothing')).toBeUndefined();
  });
});

describe('resolveAdb', () => {
  const exists = (path: string) => path === 'C:\\sdk\\platform-tools\\adb.exe';
  it('prefers ANDROID_HOME, then the default SDK folder, then PATH', () => {
    expect(resolveAdb({ ANDROID_HOME: 'C:\\sdk' }, 'win32', exists)).toBe(
      'C:\\sdk\\platform-tools\\adb.exe',
    );
    expect(resolveAdb({ LOCALAPPDATA: 'C:\\nope' }, 'win32', exists)).toBe('adb');
    expect(resolveAdb({ HOME: '/h' }, 'linux', () => false)).toBe('adb');
  });
});

describe('runListGate', () => {
  it('issues the expected adb sequence for one run', async () => {
    const device = fakeAdb({ lines: [gateLine(19)] });
    const result = await runListGate({ exec: device.exec, sleep: noSleep });
    expect(device.calls).toEqual([
      'devices',
      `${S} shell getprop sys.boot_completed`,
      expect.stringMatching(/^-s emulator-5554 install -r .*app-release\.apk$/),
      `${S} shell am force-stop ${PKG}`,
      `${S} logcat -c`,
      `${S} shell dumpsys gfxinfo ${PKG} reset`,
      `${S} shell am start -a android.intent.action.VIEW -d '${AUTO_URL}' ${PKG}`,
      `${S} shell dumpsys activity activities`,
      `${S} logcat -d -s ReactNativeJS:V`,
      `${S} shell dumpsys gfxinfo ${PKG}`,
    ]);
    expect(result.metrics.keyToHighlightMs.p95).toBe(19);
    expect(result.frames.totalFrames).toBe(605);
    expect(result.realKeys).toBeUndefined();
  });

  it('takes the median per metric and the maximum of the losses', async () => {
    const device = fakeAdb({
      lines: [gateLine(30, 5, 0), gateLine(10, 20, 2), gateLine(20, 9, 1)],
    });
    const result = await runListGate({ exec: device.exec, sleep: noSleep, runs: 3 });
    expect(result.metrics.keyToHighlightMs.p95).toBe(20);
    expect(result.metrics.keyToHighlightMs.max).toBe(23);
    expect(result.metrics.maxJsGapMs).toBe(9);
    expect(result.metrics.maxFrameStallMs).toBe(12);
    expect(result.metrics.scripted).toBe(600);
    expect(result.metrics.losses).toBe(2);
    expect(device.calls.filter((c) => c.includes('am start')).length).toBe(3);
    expect(device.calls.filter((c) => c.includes('install')).length).toBe(1);
  });

  it('routes through the device that runs the requested AVD', async () => {
    const calls: string[] = [];
    const inner = fakeAdb({ lines: [gateLine(19)] });
    const exec: Exec = async (command, args) => {
      const line = args.join(' ');
      if (line === 'devices') {
        return {
          ok: true,
          output: 'List of devices attached\nemulator-5556\tdevice\nemulator-5554\tdevice\n',
        };
      }
      if (line === '-s emulator-5556 emu avd name') return { ok: true, output: 'other\nOK\n' };
      if (line === '-s emulator-5554 emu avd name') return { ok: true, output: 'elv_tv\nOK\n' };
      calls.push(line);
      return inner.exec(command, args);
    };
    await runListGate({ exec, sleep: noSleep, avd: 'elv_tv' });
    expect(calls.every((c) => c.startsWith('-s emulator-5554 '))).toBe(true);
    await expect(runListGate({ exec, sleep: noSleep, avd: 'missing' })).rejects.toThrow(/missing/);
  });

  it('fails clearly when several devices run and no AVD is named', async () => {
    const exec: Exec = async () => ({
      ok: true,
      output: 'List of devices attached\na\tdevice\nb\tdevice\n',
    });
    await expect(runListGate({ exec, sleep: noSleep })).rejects.toThrow(/--avd/);
  });

  it('fails clearly when the install fails', async () => {
    const device = fakeAdb({ lines: [], install: false });
    await expect(runListGate({ exec: device.exec, sleep: noSleep })).rejects.toThrow(/install/);
  });

  it('presses Back and restarts once when another activity holds the foreground', async () => {
    const dialog = top('com.google.android.tvlauncher/.dialog.ShowDialogsActivity');
    const tops = Array.from({ length: 8 }, () => dialog).concat(top(`${PKG}/.MainActivity`));
    const device = fakeAdb({ lines: [gateLine(19)], tops });
    const result = await runListGate({ exec: device.exec, sleep: noSleep });
    expect(result.metrics.keyToHighlightMs.p95).toBe(19);
    expect(device.calls.filter((c) => c.endsWith('input keyevent 4')).length).toBe(1);
    expect(device.calls.filter((c) => c.includes('am start')).length).toBe(2);
  });

  it('names the blocking activity when the foreground cannot be won back', async () => {
    const dialog = top('com.google.android.tvlauncher/.dialog.ShowDialogsActivity');
    const device = fakeAdb({ lines: [gateLine(19)], tops: [dialog] });
    await expect(runListGate({ exec: device.exec, sleep: noSleep })).rejects.toThrow(
      /com\.google\.android\.tvlauncher\/\.dialog\.ShowDialogsActivity/,
    );
    expect(device.calls.filter((c) => c.endsWith('input keyevent 4')).length).toBe(1);
  });

  it('fails with a clear message instead of hanging when no ELV_GATE line appears', async () => {
    const device = fakeAdb({ lines: ['I ReactNativeJS: hello'] });
    await expect(runListGate({ exec: device.exec, sleep: noSleep })).rejects.toThrow(/ELV_GATE/);
  });

  it('fails when gfxinfo reports no frames', async () => {
    const device = fakeAdb({ lines: [gateLine(19)] });
    const exec: Exec = async (command, args) =>
      args.join(' ').endsWith(`gfxinfo ${PKG}`)
        ? { ok: true, output: 'Total frames rendered: 0' }
        : device.exec(command, args);
    await expect(runListGate({ exec, sleep: noSleep })).rejects.toThrow(/frames/);
  });

  it('sends real D-pad presses one per second and records the burst', async () => {
    const device = fakeAdb({ lines: [gateLine(19), gateLine(40, 12, 0, 3)] });
    const sleeps: number[] = [];
    const result = await runListGate({
      exec: device.exec,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      realKeys: 3,
    });
    const starts = device.calls.filter((c) => c.includes('am start'));
    expect(starts[1]).toContain('auto=0&');
    expect(device.calls.filter((c) => c.endsWith('input keyevent 20')).length).toBe(3);
    expect(sleeps.filter((ms) => ms === 1000).length).toBeGreaterThanOrEqual(3);
    expect(result.realKeys).toEqual({ p50: 18, p95: 40, max: 43, losses: 0 });
  });

  it('builds the development APK first when asked', async () => {
    const device = fakeAdb({ lines: [gateLine(19)] });
    const builds: string[] = [];
    const exec: Exec = async (command, args, opts) => {
      if (command !== 'adb') {
        builds.push(
          `${command} ${args.join(' ')} @${opts?.cwd ?? ''} ${opts?.env?.APP_VARIANT ?? ''}`,
        );
        return { ok: true, output: '' };
      }
      return device.exec(command, args);
    };
    await runListGate({ exec, sleep: noSleep, build: true, root: '/repo', adb: 'adb' });
    expect(builds[0]).toMatch(/expo prebuild --clean --platform android --no-install/);
    expect(builds[0]).toMatch(/apps\/tv-mobile.* development$/);
    expect(builds[1]).toMatch(/^\.[\\/]gradlew(\.bat)? assembleRelease --console=plain/);
    expect(builds[1]).toMatch(/android .*development$/);
  });
});

describe('runListGate build environment', () => {
  it('points Gradle at the SDK that holds adb', async () => {
    const adb = '/sdk/platform-tools/adb';
    const device = fakeAdb({ lines: [gateLine(19)] });
    let gradleEnv: Record<string, string> | undefined;
    const exec: Exec = async (command, args, opts) => {
      if (command === adb) return device.exec(command, args);
      if (args.includes('assembleRelease')) gradleEnv = opts?.env;
      return { ok: true, output: '' };
    };
    await runListGate({ exec, sleep: noSleep, build: true, root: '/repo', adb });
    expect(gradleEnv?.ANDROID_HOME).toBe('/sdk');
  });
});

describe('runListGate progress', () => {
  it('reports every run before the median', async () => {
    const device = fakeAdb({ lines: [gateLine(30), gateLine(10), gateLine(20)] });
    const seen: number[] = [];
    await runListGate({
      exec: device.exec,
      sleep: noSleep,
      runs: 3,
      onRun: (run) => seen.push(run.metrics.keyToHighlightMs.p95),
    });
    expect(seen).toEqual([30, 10, 20]);
  });
});

describe('runListGate safeguards', () => {
  it('fails with a clear message when an adb call hangs', async () => {
    const device = fakeAdb({ lines: [gateLine(19)] });
    const exec: Exec = async (command, args) =>
      args.join(' ').includes('install')
        ? { ok: false, output: 'timed out after 120 s', timedOut: true }
        : device.exec(command, args);
    await expect(runListGate({ exec, sleep: noSleep })).rejects.toThrow(/adb install.*timed out/);
  });

  it('gives every adb call a timeout', async () => {
    const device = fakeAdb({ lines: [gateLine(19)] });
    const timeouts: (number | undefined)[] = [];
    const exec: Exec = async (command, args, opts) => {
      timeouts.push(opts?.timeoutMs);
      return device.exec(command, args);
    };
    await runListGate({ exec, sleep: noSleep });
    expect(timeouts.length).toBeGreaterThan(5);
    expect(timeouts.every((t) => typeof t === 'number' && t > 0)).toBe(true);
  });

  it('fails when fewer real presses arrive than were sent', async () => {
    const device = fakeAdb({ lines: [gateLine(19), gateLine(40, 12, 0, 58)] });
    await expect(runListGate({ exec: device.exec, sleep: noSleep, realKeys: 60 })).rejects.toThrow(
      /58 of 60/,
    );
  });
});
