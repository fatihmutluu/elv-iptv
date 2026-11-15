import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlayerEngine } from '@elv/playback';
import { ENGINE_CONTRACT_CASES, type EngineContractHarness } from '@elv/playback/testing';
import { describe, expect, it, vi } from 'vitest';
import type { PresenterKind } from '../../shared/player-ipc.ts';
import { createMpvEngine, type MpvEngineDeps } from './engine.ts';
import { createFakeMpv, FAKE_PLAYING, fakeHttpError } from './mpv/fake-mpv.ts';
import { launchArgs } from './mpv/options.ts';
import { type MpvProcess, spawnMpv } from './mpv/process.ts';
import type { VideoPresenter } from './presenter/types.ts';
import { mpvRuntimePaths } from './runtime-path.ts';
import { SIM_URL, simLiveUrl, simulatorAnswers } from './testing/sim-streams.ts';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = mpvRuntimePaths({
  isPackaged: false,
  resourcesPath: '',
  appPath: resolve(here, '../../..'),
  platform: process.platform,
  arch: process.arch,
});
// Opt-in like the spike: it opens an mpv window per case and needs the simulator (`ELV_SIM_URL`).
const realReady =
  process.env['ELV_MPV_SPIKE'] === '1' && runtime !== null && (await simulatorAnswers());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A presenter that only hands mpv its window arguments; surface events are the presenter tests' business. */
function argsPresenter(kind: PresenterKind, args: readonly string[]): VideoPresenter {
  return {
    kind,
    coversArea: kind === 'child-window',
    prepare: async () => args,
    attach: () => undefined,
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    onEvent: () => () => undefined,
    dispose: () => undefined,
  };
}

function engineFor(
  spawn: MpvEngineDeps['spawn'],
  presenter: VideoPresenter,
  baseArgs: readonly string[],
) {
  return createMpvEngine({
    spawn,
    presenter,
    baseArgs,
    loadMode: 'replace',
    now: () => Date.now(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    onUi: () => undefined,
  });
}

/** Real-time settle: at least `minMs`, then until no event for `quietMs`, at most `maxMs`. */
function quietSettle(engine: PlayerEngine, o: { minMs: number; quietMs: number; maxMs: number }) {
  let last = Date.now();
  engine.subscribe(() => {
    last = Date.now();
  });
  return async (): Promise<void> => {
    const start = Date.now();
    last = Math.max(last, start);
    for (;;) {
      await sleep(10);
      const now = Date.now();
      if (now - start >= o.maxMs) return;
      if (now - start >= o.minMs && now - last >= o.quietMs) return;
    }
  };
}

async function fakeHarness(): Promise<EngineContractHarness> {
  const urls = {
    plays: 'http://fake.test/live/u/p/1.ts',
    playsToo: 'http://fake.test/live/u/p/2.ts',
    notFound: 'http://fake.test/live/u/p/404.ts',
  };
  const fake = createFakeMpv({
    scripts: {
      [urls.plays]: FAKE_PLAYING,
      [urls.playsToo]: FAKE_PLAYING,
      [urls.notFound]: fakeHttpError(404, 'Not Found'),
    },
    transport: 'socket',
  });
  const engine = engineFor(
    (args, signal) => fake.spawn(args, signal),
    argsPresenter('child-window', ['--wid=1']),
    ['--no-config'],
  );
  const settle = quietSettle(engine, { minMs: 200, quietMs: 100, maxMs: 3000 });
  await vi.waitFor(() => expect(fake.connections).toBe(1));
  await settle();
  return {
    engine,
    urls,
    settle,
    maxConcurrentMedias: () => fake.maxOpenEntries(),
    dispose: async () => {
      engine.release();
      await fake.dispose();
    },
  };
}

interface SimEntry {
  t: string;
  path: string;
  status: number;
  openConnections?: number;
}

/**
 * Real mpv against the simulator. Open medias are counted from mpv's own `start-file`/`end-file`, since the
 * simulator logs a request only when its response ends; dispose then checks that log for overlap and limits.
 */
async function realHarness(): Promise<EngineContractHarness> {
  const since = new Date().toISOString();
  const processes: MpvProcess[] = [];
  const open = new Set<unknown>();
  let maxOpen = 0;
  const engine = engineFor(
    async (args, signal) => {
      const p = await spawnMpv({
        executable: runtime?.executable ?? '',
        args,
        platform: process.platform,
        parentPid: process.pid,
        signal,
      });
      p.client.onEvent((e) => {
        if (e.event === 'start-file') open.add(e['playlist_entry_id']);
        if (e.event === 'end-file') open.delete(e['playlist_entry_id']);
        maxOpen = Math.max(maxOpen, open.size);
      });
      processes.push(p);
      return p;
    },
    argsPresenter('own-window', ['--geometry=320x180+20+20']),
    [
      ...launchArgs({
        inputConf: runtime?.inputConf ?? '',
        presenterArgs: [],
        transportArgs: [],
        platform: process.platform,
      }),
      '--ao=null',
    ],
  );
  const settle = quietSettle(engine, { minMs: 1500, quietMs: 400, maxMs: 5000 });
  await vi.waitFor(() => expect(processes).toHaveLength(1), { timeout: 5000 });
  await sleep(500);
  return {
    engine,
    urls: {
      plays: simLiveUrl(1001),
      playsToo: simLiveUrl(1004),
      notFound: simLiveUrl(1001, 'status=404'),
    },
    settle,
    maxConcurrentMedias: () => maxOpen,
    dispose: async () => {
      engine.release();
      await Promise.race([Promise.all(processes.map((p) => p.exited)), sleep(3000)]);
      await sleep(500);
      const log = (await (await fetch(`${SIM_URL}/_sim/requests`)).json()) as SimEntry[];
      const mine = log.filter((r) => r.t >= since && r.path.includes('/live/demo/'));
      expect(mine.filter((r) => r.status === 509 || r.status === 403)).toEqual([]);
      expect(Math.max(0, ...mine.map((r) => r.openConnections ?? 0))).toBeLessThanOrEqual(1);
    },
  };
}

describe('engine contract against MpvEngine over FakeMpv', () => {
  for (const c of ENGINE_CONTRACT_CASES) {
    it(c.name, async () => {
      const h = await fakeHarness();
      try {
        await c.run(h);
      } finally {
        await h.dispose();
      }
    });
  }
});

describe.skipIf(!realReady)('engine contract against MpvEngine over the real mpv runtime', () => {
  for (const c of ENGINE_CONTRACT_CASES) {
    it(c.name, { timeout: 60000 }, async () => {
      const h = await realHarness();
      try {
        await c.run(h);
      } finally {
        await h.dispose();
      }
    });
  }
});
