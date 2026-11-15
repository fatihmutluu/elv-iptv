import type { EngineEvent, LoadCommand } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMpvEngine } from './engine.ts';
import type { MpvCommand } from './mpv/codec.ts';
import { createFakeMpv, type FakeMpv } from './mpv/fake-mpv.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_A = 'http://sim.test/live/demo/demo/1001.ts';
const URL_B = 'http://sim.test/live/demo/demo/1004.ts';

const live = (
  attempt: number,
  url: string,
  headers: Readonly<Record<string, string>> = {},
): LoadCommand => ({ attempt, url, headers, kind: 'live' });

const presenter = (): VideoPresenter => ({
  kind: 'child-window',
  coversArea: true,
  prepare: async () => ['--wid=1'],
  attach: () => undefined,
  setArea: () => undefined,
  toggleFullscreen: () => undefined,
  onEvent: () => () => undefined,
  dispose: () => undefined,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(
  wrapCommand?: (cmd: MpvCommand, next: () => Promise<unknown>) => Promise<unknown>,
) {
  const fake: FakeMpv = createFakeMpv({ scripts: {}, transport: 'socket' });
  const events: EngineEvent[] = [];
  const engine = createMpvEngine({
    spawn: async (args, signal) => {
      const proc = await fake.spawn(args, signal);
      if (!wrapCommand) return proc;
      const orig = proc.client.command.bind(proc.client);
      return {
        ...proc,
        client: {
          ...proc.client,
          command: (cmd) => wrapCommand(cmd, () => orig(cmd)) as ReturnType<typeof orig>,
        },
      };
    },
    presenter: presenter(),
    baseArgs: ['--no-config', '--idle=yes'],
    loadMode: 'replace',
    now: () => Date.now(),
    timers: {
      setTimeout: (f, m) => setTimeout(f, m),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    onUi: () => undefined,
  });
  engine.subscribe((e) => events.push(e));
  cleanups.push(async () => {
    engine.release();
    await fake.dispose();
  });
  await vi.waitFor(() => expect(fake.sent).toContainEqual(['request_log_messages', 'v']));
  return { fake, engine, events };
}

describe('MpvEngine custom header state races', () => {
  it('clears http-header-fields when an empty-header load supersedes an in-flight set_property', async () => {
    let releaseFirstSet!: () => void;
    let notifyFirstSet!: () => void;
    const firstSetInFlight = new Promise<void>((r) => {
      notifyFirstSet = r;
    });
    let first = true;
    const { fake, engine } = await setup(async (cmd, next) => {
      if (first && cmd[0] === 'set_property' && cmd[1] === 'http-header-fields') {
        first = false;
        notifyFirstSet();
        await new Promise<void>((r) => {
          releaseFirstSet = r;
        });
      }
      return next();
    });

    engine.load(live(1, URL_A, { Authorization: 'Bearer secret-a' }));
    await firstSetInFlight;
    engine.load(live(2, URL_B, {}));
    releaseFirstSet();

    await vi.waitFor(() => expect(fake.sent.filter((c) => c[0] === 'loadfile')).toHaveLength(1));
    const propSets = fake.sent.filter(
      (c) => c[0] === 'set_property' && c[1] === 'http-header-fields',
    );
    expect(propSets).toEqual([
      ['set_property', 'http-header-fields', ['Authorization: Bearer secret-a']],
      ['set_property', 'http-header-fields', []],
    ]);
    expect(fake.sent.find((c) => c[0] === 'loadfile')?.[1]).toBe(URL_B);
  });

  it('clears http-header-fields when stop() supersedes an in-flight set_property', async () => {
    let releaseFirstSet!: () => void;
    let notifyFirstSet!: () => void;
    const firstSetInFlight = new Promise<void>((r) => {
      notifyFirstSet = r;
    });
    let first = true;
    const { fake, engine } = await setup(async (cmd, next) => {
      if (first && cmd[0] === 'set_property' && cmd[1] === 'http-header-fields') {
        first = false;
        notifyFirstSet();
        await new Promise<void>((r) => {
          releaseFirstSet = r;
        });
      }
      return next();
    });

    engine.load(live(1, URL_A, { Authorization: 'Bearer secret-a' }));
    await firstSetInFlight;
    engine.stop(2);
    releaseFirstSet();

    await vi.waitFor(() => expect(fake.sent).toContainEqual(['stop']));
    const propSets = fake.sent.filter(
      (c) => c[0] === 'set_property' && c[1] === 'http-header-fields',
    );
    expect(propSets).toEqual([
      ['set_property', 'http-header-fields', ['Authorization: Bearer secret-a']],
      ['set_property', 'http-header-fields', []],
    ]);
    expect(fake.sent.filter((c) => c[0] === 'loadfile')).toHaveLength(0);
  });

  it('fails closed without calling loadfile when set_property http-header-fields returns an error and retries clearing', async () => {
    let failSet = true;
    let failClear = true;
    const { fake, engine, events } = await setup(async (cmd, next) => {
      if (cmd[0] === 'set_property' && cmd[1] === 'http-header-fields') {
        const arr = cmd[2] as readonly string[];
        if (arr.length > 0 && failSet) {
          failSet = false;
          return { request_id: 1, error: 'error running command' };
        }
        if (arr.length === 0 && failClear) {
          failClear = false;
          return { request_id: 2, error: 'error running command' };
        }
      }
      return next();
    });

    engine.load(live(1, URL_A, { Authorization: 'Bearer secret-a' }));
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        attempt: 1,
        type: 'error',
        error: { code: 'unknown', detail: 'http-header-fields: error running command' },
      }),
    );
    expect(fake.sent.filter((c) => c[0] === 'loadfile')).toHaveLength(0);

    // Load 2 ({}) tries to clear, fails closed once, and keeps hasCustomHeaders=true so Load 3 retries clearing:
    engine.load(live(2, URL_B, {}));
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        attempt: 2,
        type: 'error',
        error: { code: 'unknown', detail: 'http-header-fields: error running command' },
      }),
    );
    expect(fake.sent.filter((c) => c[0] === 'loadfile')).toHaveLength(0);

    engine.load(live(3, URL_B, {}));
    await vi.waitFor(() => expect(fake.sent.filter((c) => c[0] === 'loadfile')).toHaveLength(1));
  });
});
