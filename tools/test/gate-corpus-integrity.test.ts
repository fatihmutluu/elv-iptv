import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/adb.ts';
import { corpusMain } from '../src/gates/corpus-cli.ts';
import {
  type CorpusGateOptions,
  type CorpusLine,
  judgeCorpus,
  parseCorpusLine,
  runCorpusGate,
} from '../src/gates/corpus-gate.ts';
import { CORPUS_ITEM_COUNT } from '../src/gates/corpus-judge.ts';
import type { AppHandle, DesktopGateDeps } from '../src/gates/desktop-gate.ts';
import type { GateDevice } from '../src/gates/gate-device.ts';
import type { SimLog } from '../src/gates/sim-log.ts';

const OK_LINE: CorpusLine = {
  total: 29,
  passed: 29,
  failed: [],
  surfaceCreated: 1,
  staleEventsApplied: 0,
};
const CLEAN = { limitResponses: 0, overlapMs: 0 };
const tag = (body: unknown): string => `ELV_GATE_CORPUS ${JSON.stringify(body)}`;

function fakeDevice(events: string[], logs: string[] = [tag(OK_LINE)]): GateDevice {
  let reads = 0;
  return {
    simHost: '127.0.0.1:7878',
    describe: async () => ({ platform: 'tvos' }),
    install: async () => void events.push('install'),
    start: async (_url, startOpts) => {
      events.push('stop-before-start');
      await startOpts?.afterStop?.();
      events.push('start');
    },
    stop: async () => void events.push('stop'),
    readLog: async () => logs[Math.min(reads++, logs.length - 1)] ?? '',
    crashesSince: async () => [],
    memoryMb: async () => null,
    close: async () => void events.push('close'),
  };
}

function deviceOpts(
  events: string[],
  simLog: SimLog,
  extra: Partial<CorpusGateOptions> = {},
): CorpusGateOptions {
  return {
    exec: async () => ({ ok: true, output: '' }),
    target: 'tvos',
    device: fakeDevice(events),
    sim: {
      ensure: async () => ({
        reused: true,
        stop: async () => void events.push('sim-stop'),
      }),
    },
    simLog,
    ffmpeg: () => '/bin/ffmpeg',
    sleep: async () => {},
    ...extra,
  };
}

describe('parseCorpusLine integrity', () => {
  it('rejects non-integer or negative surfaceCreated and staleEventsApplied', () => {
    for (const bad of [
      { surfaceCreated: 1.5 },
      { surfaceCreated: -1 },
      { staleEventsApplied: 0.5 },
      { staleEventsApplied: -2 },
      { mpvSpawns: 'one' },
      { mpvSpawns: 1.5 },
      { videoVisible: 'yes' },
    ]) {
      expect(parseCorpusLine(tag({ ...OK_LINE, ...bad }))).toBeUndefined();
    }
  });

  it('keeps the optional desktop fields', () => {
    expect(parseCorpusLine(tag({ ...OK_LINE, mpvSpawns: 1, videoVisible: null }))).toEqual({
      ...OK_LINE,
      mpvSpawns: 1,
      videoVisible: null,
    });
  });
});

describe('judgeCorpus integrity', () => {
  it('expects 29 items, one surface, no overlap and one mpv process with visible video', () => {
    expect(CORPUS_ITEM_COUNT).toBe(29);
    expect(judgeCorpus(OK_LINE, CLEAN)).toEqual({ ok: true, failures: [] });
    expect(judgeCorpus({ ...OK_LINE, mpvSpawns: 1, videoVisible: null }, CLEAN).ok).toBe(true);
    expect(judgeCorpus({ ...OK_LINE, surfaceCreated: 0 }, CLEAN).failures).toEqual([
      'surfaceCreated: 0 (expected 1)',
    ]);
    expect(judgeCorpus({ ...OK_LINE, surfaceCreated: 2 }, CLEAN).failures).toEqual([
      'surfaceCreated: 2 (expected 1)',
    ]);
    expect(judgeCorpus(OK_LINE, { limitResponses: 0, overlapMs: 120 }).failures).toEqual([
      'overlapMs: 120 (expected 0)',
    ]);
    expect(judgeCorpus({ ...OK_LINE, total: 28, passed: 28 }, CLEAN).failures).toEqual([
      'corpus: total 28 (expected 29)',
    ]);
    expect(judgeCorpus({ ...OK_LINE, mpvSpawns: 2, videoVisible: false }, CLEAN).failures).toEqual([
      'mpvSpawns: 2 (expected 1)',
      'videoVisible: false (the player area showed no video)',
    ]);
  });
});

describe('runCorpusGate device path', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('clears the simulator log after the app stopped and before it starts', async () => {
    const events: string[] = [];
    const simLog: SimLog = {
      clear: async () => void events.push('clear'),
      entries: async () => [],
    };
    const out = await runCorpusGate(deviceOpts(events, simLog));
    expect(out.outcome.ok).toBe(true);
    expect(events.slice(0, 4)).toEqual(['install', 'stop-before-start', 'clear', 'start']);
  });

  it('fails loudly when the simulator log cannot be read or cleared', async () => {
    const events: string[] = [];
    const unreadable: SimLog = {
      clear: async () => {},
      entries: async () => {
        throw new Error('sim log: HTTP 500');
      },
    };
    await expect(runCorpusGate(deviceOpts(events, unreadable))).rejects.toThrow(/HTTP 500/);
    expect(events).toContain('close');
    expect(events).toContain('sim-stop');
    const uncleared: SimLog = {
      clear: async () => {
        throw new Error('sim log: refused');
      },
      entries: async () => [],
    };
    await expect(runCorpusGate(deviceOpts([], uncleared))).rejects.toThrow(/refused/);
  });

  it('rejects --sim on device targets', async () => {
    const simLog: SimLog = { clear: async () => {}, entries: async () => [] };
    await expect(
      runCorpusGate(deviceOpts([], simLog, { simUrl: 'http://127.0.0.1:9999' })),
    ).rejects.toThrow(/--sim/);
  });

  it('builds the APK for the Android target it runs on', async () => {
    const envs = new Map<string, Record<string, string>>();
    const exec: Exec = async (_command, args, opts) => {
      if (args.includes('assembleRelease')) envs.set('gradle', opts?.env ?? {});
      if (args.includes('prebuild')) envs.set('prebuild', opts?.env ?? {});
      return { ok: true, output: '' };
    };
    const simLog: SimLog = { clear: async () => {}, entries: async () => [] };
    const cases = [
      ['fire-os', { EXPO_TV: '1', STORE: 'amazon' }],
      ['android-tv', { EXPO_TV: '1' }],
      ['android', {}],
    ] as const;
    for (const [target, want] of cases) {
      const root = mkdtempSync(join(tmpdir(), 'elv-corpus-build-'));
      dirs.push(root);
      envs.clear();
      await runCorpusGate(deviceOpts([], simLog, { exec, target, build: true, root }));
      for (const step of ['prebuild', 'gradle']) {
        const env = envs.get(step) ?? {};
        expect(env.APP_VARIANT).toBe('development');
        expect(env.EXPO_TV).toBe('EXPO_TV' in want ? want.EXPO_TV : undefined);
        expect(env.STORE).toBe('STORE' in want ? want.STORE : undefined);
      }
    }
  });
});

function fakeApp(lines: string[], exitOnEnd: boolean): AppHandle & { kills: number } {
  let exit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    exit = resolve;
  });
  const app = {
    pid: 4242,
    kills: 0,
    exited,
    lines: (async function* () {
      for (const [i, line] of lines.entries()) {
        if (exitOnEnd && i === lines.length - 1) exit(0);
        yield line;
      }
    })(),
    kill: () => {
      app.kills += 1;
      exit(null);
    },
  };
  return app;
}

function desktopDeps(app: AppHandle, events: string[]): DesktopGateDeps {
  return {
    prepareMedia: async () => void events.push('prepare'),
    startSim: async () => ({
      url: 'http://127.0.0.1:7878',
      requests: async () => [],
      clearRequests: async () => void events.push('clear'),
      close: async () => void events.push('sim-close'),
    }),
    spawnApp: () => app,
  };
}

describe('runCorpusGate desktop path', () => {
  it('prepares recipes, lets the app exit on its own after the corpus line instead of killing it', async () => {
    const events: string[] = [];
    const app = fakeApp([tag({ ...OK_LINE, mpvSpawns: 1, videoVisible: true })], true);
    const out = await runCorpusGate({
      exec: async () => ({ ok: true, output: '' }),
      sim: { ensure: async () => ({ reused: true, stop: async () => {} }) },
      target: 'desktop',
      desktopDeps: desktopDeps(app, events),
      ffmpeg: () => '/bin/ffmpeg',
      sleep: async () => {},
    });
    expect(out.outcome).toEqual({ ok: true, failures: [] });
    expect(app.kills).toBe(0);
    expect(events).toEqual(['prepare', 'clear', 'sim-close']);
  });

  it('wires --sim on desktop without starting a local simulator', async () => {
    const events: string[] = [];
    const args: string[][] = [];
    const app = fakeApp([tag({ ...OK_LINE, mpvSpawns: 1, videoVisible: true })], true);
    const out = await runCorpusGate({
      exec: async () => ({ ok: true, output: '' }),
      sim: { ensure: async () => ({ reused: true, stop: async () => {} }) },
      target: 'desktop',
      simUrl: 'http://100.64.0.1:7878/',
      simLog: {
        clear: async () => void events.push('ext-clear'),
        entries: async () => [],
      },
      desktopDeps: {
        startSim: async () => {
          throw new Error('should not start local sim');
        },
        spawnApp: (argv) => {
          args.push([...argv]);
          return app;
        },
      },
      ffmpeg: () => null,
      sleep: async () => {},
    });
    expect(out.outcome.ok).toBe(true);
    expect(events).toEqual(['ext-clear']);
    expect(args).toEqual([
      ['--elv-gate=elv-gate=corpus&base=http://100.64.0.1:7878&account=corpus'],
    ]);
  });

  it('kills the app when it ends without a corpus line', async () => {
    const app = fakeApp(['noise'], false);
    await expect(
      runCorpusGate({
        exec: async () => ({ ok: true, output: '' }),
        sim: { ensure: async () => ({ reused: true, stop: async () => {} }) },
        target: 'desktop',
        desktopDeps: desktopDeps(app, []),
        ffmpeg: () => '/bin/ffmpeg',
        sleep: async () => {},
      }),
    ).rejects.toThrow(/exited before emitting ELV_GATE_CORPUS/);
    expect(app.kills).toBe(1);
  });
});

describe('corpusMain --sim', () => {
  it('rejects --sim on device targets and malformed URLs with exit code 2', async () => {
    const err: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => {
      err.push(t);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await corpusMain({ target: 'android-tv', sim: 'http://127.0.0.1:7878' }, '.')).toBe(2);
      expect(await corpusMain({ target: 'desktop', sim: 'not a url' }, '.')).toBe(2);
      expect(await corpusMain({ target: 'desktop', sim: 'https://example.com' }, '.')).toBe(2);
      expect(await corpusMain({ target: 'desktop', sim: 'http://127.0.0.1:70000' }, '.')).toBe(2);
    } finally {
      process.stderr.write = real;
    }
    expect(err.join('')).toMatch(/--sim/);
  });
});
