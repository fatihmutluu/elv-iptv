import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/adb.ts';
import type { GateDevice } from '../src/gates/gate-device.ts';
import { PLAYER_USAGE, playerMain } from '../src/gates/player-cli.ts';
import {
  aggregateRuns,
  comparePlayer,
  judgeFault,
  type PlayerLine,
  parsePlayerLine,
  runPlayerGate,
} from '../src/gates/player-gate.ts';
import type { SimLog, SimLogEntry } from '../src/gates/sim-log.ts';
import { entry, line, logcat, next, slow } from './gate-player-fixtures.ts';

const PKG = 'io.github.fatihmutluu.elviptv.dev';
const forced509 = { status: 509, bytes: 0, query: { fault: 'status=509' } };

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
      const current = opts.lines[Math.min(starts, opts.lines.length) - 1];
      return { ok: true, output: current === undefined ? '' : logcat(current) };
    }
    return { ok: true, output: '' };
  };
  const sim = {
    running: async () => false,
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

function appleFake(opts: {
  logs: string[][];
  entries?: SimLogEntry[][];
  crashes?: string[][];
  memories?: (number | null)[];
  reused?: boolean;
}) {
  const urls: string[] = [];
  const events: string[] = [];
  let runIdx = -1;
  let pollIdx = 0;
  let memIdx = 0;
  let entryIdx = 0;
  const device: GateDevice = {
    simHost: '127.0.0.1:7878',
    describe: async () => ({ platform: 'tvos', name: 'Apple TV 4K (3rd generation)' }),
    install: async () => void events.push('install'),
    start: async (url, startOpts) => {
      runIdx += 1;
      pollIdx = 0;
      events.push('start');
      await startOpts?.afterStop?.();
      urls.push(url);
    },
    stop: async () => void events.push('stop'),
    readLog: async () => {
      const seq = opts.logs[runIdx] ?? [];
      return seq[Math.min(pollIdx++, seq.length - 1)] ?? '';
    },
    crashesSince: async () => (opts.crashes ?? [])[runIdx] ?? [],
    memoryMb: async () => (opts.memories ?? [])[memIdx++] ?? null,
    close: async () => void events.push('close'),
  };
  const sim = {
    ensure: async () => ({
      reused: opts.reused ?? true,
      stop: async () => void events.push('sim-stop'),
    }),
  };
  const log: SimLog = {
    clear: async () => void events.push('clear'),
    entries: async () => (opts.entries ?? [])[entryIdx++] ?? [],
  };
  const exec: Exec = async () => ({ ok: true, output: '' });
  return { device, sim, log, exec, urls, events };
}

const noSleep = async () => {};
const ffmpeg = () => 'ffmpeg';

describe('player-gate re-exports', () => {
  it('keeps parsePlayerLine, aggregateRuns, comparePlayer and judgeFault exported', () => {
    expect(typeof parsePlayerLine).toBe('function');
    expect(typeof aggregateRuns).toBe('function');
    expect(typeof comparePlayer).toBe('function');
    expect(typeof judgeFault).toBe('function');
  });
});

describe('runPlayerGate (Android)', () => {
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
    expect([runs.length, out.result.zaps, out.runs.length, out.faults.length]).toEqual([
      3, 30, 3, 0,
    ]);
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
          entry(0, 5000, { bytes: 0 }),
          entry(5005, 2000, { bytes: 0 }),
          entry(7010, 2000, { bytes: 0 }),
        ],
      ],
    });
    const reports: string[] = [];
    const out = await runPlayerGate({
      ...f,
      sleep: noSleep,
      ffmpeg,
      runs: 1,
      burst: 8,
      faults: true,
      onFault: (r) => reports.push(r.fault),
    });
    expect(f.urls[0]).toContain('&burst=8');
    expect(f.urls.slice(1)).toEqual(
      [
        '0.05&fault=drop5',
        '0.1&fault=404',
        '0.1&fault=509',
        '1.25&fault=slowstart',
        '0.05&fault=silent',
      ].map(
        (x) =>
          `elviptv://gate/player?host=10.0.2.2:7878&account=demo&channels=1001,1002,1003,1004&zaps=1&rate=${x}&burst=8`,
      ),
    );
    expect(reports).toEqual(['drop5', '404', '509', 'slowstart', 'silent']);
    expect(out.faults.map((x) => x.failures.length)).toEqual([0, 0, 1, 0, 0]);
    expect(out.faults[2]?.failures[0]).toMatch(/missed/);
    expect(out.faults.every((x) => x.limitResponses === 0 && x.overlapMs === 0)).toBe(true);
  });

  it('fails clearly without FFmpeg when no simulator is running, before starting anything', async () => {
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
    expect(order.slice(0, 3)).toEqual(['build', 'build', 'build']);
    expect(order.indexOf('adb install')).toBe(3);
    expect(order.indexOf('adb start')).toBeGreaterThan(3);
  });

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
});

describe('runPlayerGate (GateDevice, soak and stress)', () => {
  it('reuses a running simulator without FFmpeg and builds links with the device simHost, channels and stream', async () => {
    const f = appleFake({ logs: [[logcat(line({ zaps: 10 }))]] });
    const out = await runPlayerGate({
      ...f,
      target: 'tvos',
      channels: ['200001', '200002'],
      stream: 'vod',
      burst: 8,
      runs: 1,
      zaps: 10,
      ffmpeg: () => null,
      sleep: noSleep,
    });
    expect(f.urls).toEqual([
      'elviptv://gate/player?host=127.0.0.1:7878&account=demo&channels=200001,200002&zaps=10&rate=0.5&fault=&stream=vod&burst=8',
    ]);
    expect(out.result.zaps).toBe(10);
    expect(out.result.burstSec).toBe(8);
    expect(f.events.at(-1)).toBe('sim-stop');
    expect(f.events).toContain('close');
  });

  it('fails a run with a crash report', async () => {
    const f = appleFake({ logs: [[logcat(line())]], crashes: [['ELVIPTV-2026-11-15.ips']] });
    const out = await runPlayerGate({
      ...f,
      target: 'tvos',
      runs: 1,
      ffmpeg: () => null,
      sleep: noSleep,
    });
    expect(out.crashes).toEqual(['ELVIPTV-2026-11-15.ips']);
  });

  it('runs a soak run, samples memory after warmup and at the end, and judges soak', async () => {
    const soakLine = line({
      zaps: 0,
      soak: {
        minutes: 1,
        playedMs: 59_500,
        positionAdvancedMs: 59_400,
        stalls: 0,
        longestStallMs: 0,
        ended: false,
        durationMs: null,
      },
    });
    const f = appleFake({
      logs: [['', '', '', '', '', '', logcat(soakLine)]],
      memories: [180, 225],
    });
    const out = await runPlayerGate({
      ...f,
      target: 'tvos',
      soak: 1,
      ffmpeg: () => null,
      sleep: noSleep,
    });
    expect(f.urls).toEqual([
      'elviptv://gate/player?host=127.0.0.1:7878&account=demo&channels=1001,1002,1003,1004&zaps=1&rate=0.5&fault=&soak=1',
    ]);
    expect(out.soak?.verdict).toEqual({
      failures: [],
      warnings: ['soak: memory grew 45 MB (180 MB to 225 MB), warning above 32 MB'],
    });
  });

  it('runs stress as 3 runs of 200 zaps at 5/s and judges counters only', async () => {
    const stressLine = line({ zaps: 200, final: 'playing' });
    const f = appleFake({
      logs: [[logcat(stressLine)], [logcat(stressLine)], [logcat(stressLine)]],
    });
    const out = await runPlayerGate({
      ...f,
      target: 'tvos',
      stress: true,
      ffmpeg: () => null,
      sleep: noSleep,
    });
    expect(f.urls).toHaveLength(3);
    expect(f.urls[0]).toContain('zaps=200&rate=5&fault=');
    expect(out.stress?.verdict).toEqual({ failures: [], warnings: [] });
  });
});

describe('playerMain', () => {
  const captureErr = async (fn: () => Promise<number>) => {
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => {
      written.push(t);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await fn(), text: written.join('') };
    } finally {
      process.stderr.write = real;
    }
  };

  it('refuses --write-baseline without --faults and requires --app on Apple targets', async () => {
    const noFaults = await captureErr(() => playerMain({ 'write-baseline': true }, '.'));
    expect(noFaults.code).toBe(2);
    expect(noFaults.text).toMatch(/baseline needs --faults/);
    const noApp = await captureErr(() => playerMain({ target: 'tvos' }, '.'));
    expect(noApp.code).toBe(2);
    expect(noApp.text).toMatch(/--app/);
    const badTarget = await captureErr(() => playerMain({ target: 'webos' }, '.'));
    expect(badTarget.code).toBe(2);
    expect(badTarget.text).toMatch(/--target/);
    const badBurst = await captureErr(() => playerMain({ burst: '31' }, '.'));
    expect(badBurst.code).toBe(2);
    expect(badBurst.text).toMatch(/--burst/);
  });

  it('names the player gate options in PLAYER_USAGE', () => {
    expect(PLAYER_USAGE).toMatch(/gate player.*--target.*--burst.*--soak.*--stress/);
  });
});
