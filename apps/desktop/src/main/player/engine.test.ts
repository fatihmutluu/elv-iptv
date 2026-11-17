import type { EngineEvent, EngineState, LoadCommand } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  type PlayerArea,
  type PlayerUiEvent,
  type PresenterKind,
} from '../../shared/player-ipc.ts';
import { createMpvEngine, type LoadMode, type MpvEngineDeps } from './engine.ts';
import type { MpvClient } from './mpv/client.ts';
import type { MpvCommand } from './mpv/codec.ts';
import {
  createFakeMpv,
  FAKE_PLAYING,
  type FakeMpv,
  type FakeMpvScript,
  fakeHttpError,
} from './mpv/fake-mpv.ts';
import { loadfileCommand } from './mpv/options.ts';
import type { PresenterEvent, VideoPresenter } from './presenter/types.ts';

const BASE = ['--no-config', '--idle=yes'];
const URL_A = 'http://sim.test/live/demo/demo/1001.ts';
const URL_B = 'http://sim.test/live/demo/demo/1004.ts';
const URL_VOD = 'http://sim.test/movie/demo/demo/200001.mp4';
const URL_NOTICE = 'http://sim.test/live/demo/demo/1001.ts?fault=text-notice';
const OBSERVED = [
  'pause',
  'paused-for-cache',
  'core-idle',
  'seeking',
  'time-pos',
  'duration',
  'speed',
  'demuxer-cache-state',
  'video-params',
  'vid',
];

const VOD: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 3, property: 'duration', value: 600 },
  { afterMs: 4, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 6, property: 'time-pos', value: 12.5 },
  { afterMs: 6, event: 'playback-restart' },
];

/** Real mpv opens a simulator stream about 380 ms after `start-file` (measured); a little slower here. */
const SLOW_OPEN: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 500, event: 'file-loaded' },
  { afterMs: 500, property: 'vid', value: 1 },
  { afterMs: 502, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 505, property: 'time-pos', value: 0 },
  { afterMs: 505, event: 'playback-restart' },
];
const URL_NEVER_STARTS = 'http://sim.test/live/demo/demo/1007.ts';
const URL_NEVER_OPENS = 'http://sim.test/live/demo/demo/1008.ts';

const noise = Array.from({ length: 60 }, (_, i) => ({
  afterMs: 5,
  log: { prefix: 'cplayer', level: 'v', text: `Set property: osd-margin-y-offset=${i} -> 1` },
}));
const NOTICE: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 4, log: { prefix: 'ffmpeg', level: 'v', text: "Mime-type: 'text/plain'" } },
  ...noise,
  { afterMs: 8, event: 'end-file', reason: 'error', fileError: 'unrecognized file format' },
];

const live = (attempt: number, url = URL_A, headers: Record<string, string> = {}): LoadCommand => ({
  attempt,
  url,
  headers,
  kind: 'live',
});

interface FakePresenter extends VideoPresenter {
  attached: MpvClient[];
  fullscreen: number;
  areas: PlayerArea[];
  disposed: boolean;
  emit(event: PresenterEvent): void;
}

function fakePresenter(kind: PresenterKind): FakePresenter {
  const listeners = new Set<(event: PresenterEvent) => void>();
  const p: FakePresenter = {
    kind,
    coversArea: kind === 'child-window',
    attached: [],
    fullscreen: 0,
    areas: [],
    disposed: false,
    prepare: async () => (kind === 'child-window' ? ['--wid=4660'] : ['--geometry=320x180+0+0']),
    attach: (client) => void p.attached.push(client),
    setArea: (area) => void p.areas.push(area),
    toggleFullscreen: () => {
      p.fullscreen += 1;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      p.disposed = true;
      listeners.clear();
    },
    emit: (event) => {
      for (const l of [...listeners]) l(event);
    },
  };
  return p;
}

const timers: MpvEngineDeps['timers'] = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Waits on real I/O only, so it also works while setTimeout is faked. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 20000 && !check(); i += 1) await new Promise((r) => setImmediate(r));
  expect(check()).toBe(true);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) await c();
});

interface SetupOptions {
  scripts?: Record<string, FakeMpvScript>;
  kind?: PresenterKind;
  loadMode?: LoadMode;
  spawnDelayMs?: number;
  spawn?: (fake: FakeMpv) => MpvEngineDeps['spawn'];
  timers?: MpvEngineDeps['timers'];
  ready?: boolean;
  deferStart?: boolean;
}

async function setup(o: SetupOptions = {}) {
  const fake = createFakeMpv({ scripts: o.scripts ?? {}, transport: 'socket' });
  fake.spawnDelayMs = o.spawnDelayMs ?? 0;
  const presenter = fakePresenter(o.kind ?? 'child-window');
  const ui: PlayerUiEvent[] = [];
  const engine = createMpvEngine({
    spawn: o.spawn?.(fake) ?? ((args, signal) => fake.spawn(args, signal)),
    presenter,
    baseArgs: BASE,
    loadMode: o.loadMode ?? 'replace',
    now: () => Date.now(),
    timers: o.timers ?? timers,
    onUi: (event) => ui.push(event),
    ...(o.deferStart ? { deferStart: true } : {}),
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  cleanups.push(async () => {
    engine.release();
    await fake.dispose();
  });
  if (o.ready !== false) {
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['request_log_messages', 'v']));
    await sleep(20);
  }
  return { fake, presenter, engine, events, ui };
}

const loadfiles = (fake: FakeMpv): MpvCommand[] => fake.sent.filter((c) => c[0] === 'loadfile');
const states = (events: readonly EngineEvent[], attempt: number): EngineState[] =>
  events.flatMap((e) => (e.type === 'state' && e.attempt === attempt ? [e.state] : []));
const errors = (events: readonly EngineEvent[]) => events.filter((e) => e.type === 'error');
const playing = (events: readonly EngineEvent[], attempt: number) =>
  vi.waitFor(() => expect(states(events, attempt)).toContain('playing'), { timeout: 3000 });

describe('MpvEngine review focus', () => {
  it('passes custom headers as a typed set_property array and clears them on the next load', async () => {
    const { engine, fake } = await setup();
    const headers = {
      'User-Agent': 'Mozilla/5.0 (KHTML, like Gecko)',
      'X-Elv-A': 'foo\\',
      'X-Elv-B': 'a,b\\c',
    };
    engine.load(live(1, URL_A, headers));
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(1));
    expect(loadfiles(fake)[0]?.[4]).toMatchObject({
      'user-agent': 'Mozilla/5.0 (KHTML, like Gecko)',
    });
    expect(loadfiles(fake)[0]?.[4]).not.toHaveProperty('http-header-fields');
    expect(fake.sent).toContainEqual([
      'set_property',
      'http-header-fields',
      ['X-Elv-A: foo\\', 'X-Elv-B: a,b\\c'],
    ]);
    expect(fake.spawnArgs.flat().join(' ')).not.toContain('sim.test');

    engine.load(live(2, URL_B, {}));
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(2));
    expect(fake.sent).toContainEqual(['set_property', 'http-header-fields', []]);
  });

  it('a burst of ten loads sends at most two loadfile commands and plays the newest', async () => {
    const { engine, fake, events } = await setup();
    fake.replyDelayMs = 1000;
    engine.load(live(1, URL_A));
    for (let i = 2; i <= 10; i += 1) {
      await sleep(15);
      engine.load(live(i, i % 2 === 1 ? URL_A : URL_B));
    }
    await vi.waitFor(() => expect(states(events, 10)).toContain('playing'), { timeout: 6000 });
    expect(loadfiles(fake).length).toBeLessThanOrEqual(2);
    expect(loadfiles(fake).at(-1)?.[1]).toBe(URL_B);
    expect(fake.maxOpenEntries()).toBe(1);
    expect(events.every((e) => e.attempt === 10)).toBe(true);
    expect(events[0]).toEqual({ attempt: 10, type: 'state', state: 'opening' });
  });

  it('ten loads 18 ms apart with fast replies send at most two loadfile commands', async () => {
    const burstOpen: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 750, event: 'file-loaded' },
      { afterMs: 750, property: 'vid', value: 1 },
      { afterMs: 752, property: 'video-params', value: { w: 1280, h: 720 } },
      { afterMs: 755, property: 'time-pos', value: 0 },
      { afterMs: 755, event: 'playback-restart' },
    ];
    const urls = Array.from(
      { length: 10 },
      (_, i) => `http://sim.test/live/demo/demo/${2001 + i}.ts`,
    );
    const { engine, fake, events } = await setup({
      scripts: Object.fromEntries(urls.map((u) => [u, burstOpen])),
    });
    fake.endDelayMs = 15;
    for (let i = 1; i <= 10; i += 1) {
      if (i > 1) await sleep(18);
      engine.load(live(i, urls[i - 1]));
    }
    await vi.waitFor(() => expect(states(events, 10)).toContain('playing'), { timeout: 5000 });
    expect(loadfiles(fake).length).toBeLessThanOrEqual(2);
    expect(loadfiles(fake).at(-1)?.[1]).toBe(urls[9]);
    expect(events.filter((e) => e.attempt > 1 && e.attempt < 10)).toEqual([]);
    expect(states(events, 1).every((s) => s === 'opening')).toBe(true);
    expect(states(events, 10)[0]).toBe('opening');
    expect(fake.maxOpenEntries()).toBe(1);
  });

  it('maxHoldMs is 0 until a load had to wait, then the longest wait of a load that went out', async () => {
    const { engine, fake, events } = await setup({ scripts: { [URL_B]: SLOW_OPEN } });
    expect(engine.maxHoldMs).toBe(0);
    engine.load(live(1));
    await playing(events, 1);
    expect(engine.maxHoldMs).toBe(0);
    engine.load(live(2, URL_B));
    await until(() => loadfiles(fake).length === 2);
    engine.load(live(3));
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(3), { timeout: 3000 });
    expect(engine.maxHoldMs).toBeGreaterThanOrEqual(300);
    expect(engine.maxHoldMs).toBeLessThanOrEqual(1100);
  });

  it('remembers the last area it was given', async () => {
    const { engine } = await setup();
    expect(engine.lastArea).toBeUndefined();
    const area = { x: 1, y: 2, width: 3, height: 4, visible: true };
    engine.setArea(area);
    expect(engine.lastArea).toEqual(area);
  });

  it('stop during a pending load sends nothing more', async () => {
    const { engine, fake, events } = await setup({ scripts: { [URL_B]: SLOW_OPEN } });
    engine.load(live(1));
    await playing(events, 1);
    engine.load(live(2, URL_B));
    await until(() => loadfiles(fake).length === 2);
    engine.load(live(3));
    await sleep(30);
    expect(loadfiles(fake)).toHaveLength(2);
    const before = fake.sent.length;
    const stoppedAt = Date.now();
    engine.stop(4);
    await until(() => fake.sent.length > before);
    expect(Date.now() - stoppedAt).toBeLessThan(250);
    await sleep(700);
    expect(fake.sent.slice(before)).toEqual([['stop']]);
    expect(events.filter((e) => e.attempt >= 3)).toEqual([]);
  });

  it('an external mpv crash reports engine-wedged and recreate plays again', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    const crashedAt = Date.now();
    fake.crash();
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(Date.now() - crashedAt).toBeLessThan(3000);
    expect(errors(events)[0]).toMatchObject({ attempt: 1, error: { code: 'engine-wedged' } });
    engine.recreate(2);
    engine.load(live(3, URL_B));
    await playing(events, 3);
    expect(engine.spawns).toBe(2);
    expect(fake.connections).toBe(2);
    expect(errors(events)).toHaveLength(1);
  });

  it('a user quit is a close, not a crash', async () => {
    const { engine, fake, events, ui } = await setup({ kind: 'own-window' });
    engine.load(live(1));
    await playing(events, 1);
    fake.userQuit();
    await vi.waitFor(() => expect(ui).toContainEqual({ type: 'closed' }));
    engine.load(live(2, URL_B));
    await playing(events, 2);
    expect(engine.spawns).toBe(2);
    expect(errors(events)).toEqual([]);
  });

  it('a clean own-window exit while idle is a user close, not a crash', async () => {
    const { engine, fake, events, ui } = await setup({ kind: 'own-window' });
    fake.userQuit();
    await vi.waitFor(() => expect(ui).toContainEqual({ type: 'closed' }));
    expect(errors(events)).toEqual([]);
    engine.load(live(1, URL_B));
    await playing(events, 1);
    expect(engine.spawns).toBe(2);
  });

  it('a clean own-window exit in a recovery gap is a user close, not engine-wedged', async () => {
    const { engine, fake, events, ui } = await setup({
      kind: 'own-window',
      scripts: { [URL_A]: fakeHttpError(503, 'Service Unavailable') },
    });
    engine.load(live(1, URL_A));
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toMatchObject({ attempt: 1, error: { code: 'http-other' } });
    fake.userQuit();
    await vi.waitFor(() => expect(ui).toContainEqual({ type: 'closed' }));
    await sleep(50);
    expect(errors(events)).toHaveLength(1);
  });

  it('a crash in a recovery gap with own-window still reports engine-wedged', async () => {
    const { engine, fake, events, ui } = await setup({
      kind: 'own-window',
      scripts: { [URL_A]: fakeHttpError(503, 'Service Unavailable') },
    });
    engine.load(live(1, URL_A));
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    fake.crash();
    await vi.waitFor(() => expect(errors(events)).toHaveLength(2));
    expect(errors(events)[1]).toMatchObject({ attempt: 1, error: { code: 'engine-wedged' } });
    expect(ui).toEqual([]);
  });

  it('release during spawn kills the process and emits nothing', async () => {
    const { engine, fake, events, ui, presenter } = await setup({
      spawnDelayMs: 200,
      ready: false,
    });
    await sleep(50);
    expect(() => engine.release()).not.toThrow();
    await sleep(300);
    expect(fake.killed).toBe(1);
    expect(fake.connections).toBe(0);
    expect(presenter.disposed).toBe(true);
    expect(() => engine.load(live(1))).not.toThrow();
    await sleep(50);
    expect(fake.spawnArgs).toHaveLength(1);
    expect(events).toEqual([]);
    expect(ui).toEqual([]);
  });
});

describe('MpvEngine', () => {
  it('spawns with the base and presenter args, observes the properties and asks for log lines', async () => {
    const { fake, presenter } = await setup();
    expect(fake.spawnArgs).toEqual([[...BASE, '--wid=4660']]);
    const observed = fake.sent.filter((c) => c[0] === 'observe_property').map((c) => c[2]);
    expect([...observed].sort()).toEqual([...OBSERVED].sort());
    expect(presenter.attached).toHaveLength(1);
  });

  it('a load waits for the previous loadfile reply before sending', async () => {
    const { engine, fake, events } = await setup();
    fake.replyDelayMs = 300;
    engine.load(live(1));
    await until(() => loadfiles(fake).length === 1);
    engine.load(live(2, URL_B));
    await sleep(150);
    expect(loadfiles(fake)).toHaveLength(1);
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(2), { timeout: 2000 });
    await playing(events, 2);
  });

  it('stop-then-load waits for end-file before loadfile', async () => {
    const { engine, fake, events } = await setup({ loadMode: 'stop-then-load' });
    engine.load(live(1));
    await playing(events, 1);
    expect(fake.trace).not.toContain('> stop');
    fake.endDelayMs = 60;
    engine.load(live(2, URL_B));
    await playing(events, 2);
    const stop = fake.trace.indexOf('> stop');
    const ended = fake.trace.indexOf('< end-file stop 1');
    const load = fake.trace.indexOf(`> loadfile ${URL_B} replace -1`);
    expect(stop).toBeGreaterThan(-1);
    expect(stop < ended && ended < load).toBe(true);
    expect(engine.loadMode).toBe('stop-then-load');
  });

  it('retry reloads the current url and options under the new token', async () => {
    const { engine, fake, events } = await setup();
    const headers = { 'User-Agent': 'UA/1', Referer: 'http://ref.test/' };
    engine.load(live(1, URL_A, headers));
    await playing(events, 1);
    engine.retry(2);
    await playing(events, 2);
    const [first, second] = loadfiles(fake);
    expect(second).toEqual(first);
    expect(second).toEqual(loadfileCommand({ url: URL_A, headers, kind: 'live' }));
    expect(states(events, 2)[0]).toBe('opening');
  });

  it('retry resumes a vod at the last anchored position', async () => {
    const { engine, fake, events } = await setup({ scripts: { [URL_VOD]: VOD } });
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);
    engine.retry(2);
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(2));
    expect(loadfiles(fake)[1]?.[4]).toMatchObject({ start: '12.500' });
  });

  it('seek sends seek <s> absolute', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    engine.seek(2, 12_345);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['seek', 12.345, 'absolute']));
    await vi.waitFor(() =>
      expect(events.some((e) => e.attempt === 2 && e.type === 'clock')).toBe(true),
    );
  });

  it('pause and play set pause', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    engine.pause(2);
    await vi.waitFor(() => expect(states(events, 2)).toEqual(['paused']));
    engine.play(3);
    await vi.waitFor(() => expect(states(events, 3)).toEqual(['playing']));
    expect(fake.sent).toContainEqual(['set', 'pause', 'yes']);
    expect(fake.sent).toContainEqual(['set', 'pause', 'no']);
  });

  it('a load after a pause unpauses mpv after its loadfile', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    engine.pause(2);
    await vi.waitFor(() => expect(states(events, 2)).toEqual(['paused']));
    engine.load(live(3, URL_B));
    await playing(events, 3);
    const load = fake.trace.indexOf(`> loadfile ${URL_B} replace -1`);
    expect(fake.trace.lastIndexOf('> set pause no')).toBeGreaterThan(load);
  });

  it('a newer token before start-file tags the new media and its inherited pause', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    fake.endDelayMs = 400;
    engine.load(live(2, URL_B));
    await until(() => loadfiles(fake).length === 2);
    await sleep(20);
    engine.pause(3);
    await vi.waitFor(() => expect(states(events, 3).at(-1)).toBe('paused'));
    expect(states(events, 3)[0]).toBe('opening');
    expect(states(events, 3)).not.toContain('playing');
    expect(events.filter((e) => e.attempt === 2)).toEqual([]);
  });

  it('stop-then-load reports engine-wedged when the old entry never ends', async () => {
    const shortEnd: MpvEngineDeps['timers'] = {
      setTimeout: (fn, ms) => setTimeout(fn, ms === 3000 ? 100 : ms),
      clearTimeout: timers.clearTimeout,
    };
    const { engine, fake, events } = await setup({ loadMode: 'stop-then-load', timers: shortEnd });
    engine.load(live(1));
    await playing(events, 1);
    fake.endDelayMs = 5000;
    engine.load(live(2, URL_B));
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toMatchObject({ attempt: 2, error: { code: 'engine-wedged' } });
    expect(loadfiles(fake)).toHaveLength(1);
    expect(fake.killed).toBe(1);
  });

  it('a pending load gives up with engine-wedged when the load in flight never starts', async () => {
    const shortStart: MpvEngineDeps['timers'] = {
      setTimeout: (fn, ms) => setTimeout(fn, ms === 3000 ? 100 : ms),
      clearTimeout: timers.clearTimeout,
    };
    const { engine, fake, events } = await setup({
      scripts: { [URL_NEVER_STARTS]: [] },
      timers: shortStart,
    });
    engine.load(live(1, URL_NEVER_STARTS));
    await until(() => loadfiles(fake).length === 1);
    engine.load(live(2));
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toMatchObject({ attempt: 2, error: { code: 'engine-wedged' } });
    expect(fake.killed).toBe(1);
  });

  it('a pending load goes out after 1000 ms when the load in flight never opens', async () => {
    const { engine, fake, events } = await setup({
      scripts: { [URL_NEVER_OPENS]: [{ afterMs: 0, event: 'start-file' }] },
    });
    engine.load(live(1, URL_NEVER_OPENS));
    await until(() => loadfiles(fake).length === 1);
    await sleep(20);
    engine.load(live(2));
    await sleep(600);
    expect(loadfiles(fake)).toHaveLength(1);
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(2), { timeout: 2000 });
    await playing(events, 2);
    expect(errors(events)).toEqual([]);
  });

  it('a process that starts after release is killed at once', async () => {
    const { engine, fake, events } = await setup({
      spawnDelayMs: 100,
      ready: false,
      spawn: (f) => (args) => f.spawn(args, new AbortController().signal),
    });
    await sleep(20);
    engine.release();
    await vi.waitFor(() => expect(fake.killed).toBe(1));
    expect(events).toEqual([]);
  });

  it('elv-key client messages become ui keys', async () => {
    const { fake, presenter, ui } = await setup();
    for (const key of ['channel-up', 'channel-down', 'back', 'fullscreen', 'close', 'bogus'])
      fake.clientMessage('elv-key', key);
    fake.clientMessage('osc-visibility', 'always');
    await vi.waitFor(() => expect(ui).toHaveLength(4));
    await sleep(20);
    expect(ui).toEqual([
      { type: 'key', key: 'channel-up' },
      { type: 'key', key: 'channel-down' },
      { type: 'key', key: 'back' },
      { type: 'key', key: 'close' },
    ]);
    expect(presenter.fullscreen).toBe(1);
  });

  it('a reply timeout of 3000 ms reports engine-wedged', async () => {
    const { engine, fake, events } = await setup();
    fake.hang();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    engine.load(live(1));
    await until(() => loadfiles(fake).length === 1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(errors(events)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors(events)).toEqual([
      { attempt: 1, type: 'error', error: { code: 'engine-wedged', detail: expect.any(String) } },
    ]);
    expect(fake.killed).toBe(1);
  });

  it('spawns counts one spawn per engine without recreate', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    engine.load(live(2, URL_B));
    await playing(events, 2);
    engine.pause(3);
    engine.play(4);
    engine.stop(5);
    engine.load(live(6));
    await playing(events, 6);
    expect(engine.spawns).toBe(1);
    engine.recreate(7);
    engine.load(live(8, URL_B));
    await playing(events, 8);
    expect(engine.spawns).toBe(2);
    expect(fake.spawnArgs).toEqual([
      [...BASE, '--wid=4660'],
      [...BASE, '--wid=4660'],
    ]);
    expect(fake.sent).toContainEqual(['quit']);
  });

  it('capabilities equal DESKTOP_CAPABILITIES', async () => {
    const { engine } = await setup();
    expect(engine.capabilities).toEqual(DESKTOP_CAPABILITIES);
    expect(DESKTOP_CAPABILITIES).toEqual({
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: false,
      softwareAudioFallback: false,
      recreate: true,
      audioTrackSelection: false,
      subtitleTrackSelection: false,
    });
    expect(engine.presenterKind).toBe('child-window');
  });

  it('reads playlist/0/id when the loadfile reply has no entry id', async () => {
    const { engine, fake, events } = await setup();
    fake.entryIdInReply = false;
    fake.replyDelayMs = 20;
    engine.load(live(1));
    await playing(events, 1);
    expect(fake.sent).toContainEqual(['get_property', 'playlist/0/id']);
    expect(states(events, 1)[0]).toBe('opening');
  });

  it('a text notice maps to connection-limit among verbose log lines', async () => {
    const { engine, events } = await setup({ scripts: { [URL_NOTICE]: NOTICE } });
    engine.load(live(1, URL_NOTICE));
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toMatchObject({ attempt: 1, error: { code: 'connection-limit' } });
  });

  it('a missing stream reports http-404 with the load token', async () => {
    const { engine, events } = await setup({
      scripts: { [URL_B]: fakeHttpError(404, 'Not Found') },
    });
    engine.load(live(1, URL_B));
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toMatchObject({
      attempt: 1,
      error: { code: 'http-404', httpStatus: 404 },
    });
  });

  it('surface events come from the presenter with the latest token', async () => {
    const { engine, events, presenter } = await setup({ scripts: { [URL_A]: FAKE_PLAYING } });
    presenter.emit({ type: 'surface', change: 'created' });
    engine.load(live(4));
    presenter.emit({ type: 'surface', change: 'destroyed' });
    expect(events.filter((e) => e.type === 'surface')).toEqual([
      { attempt: 0, type: 'surface', change: 'created' },
      { attempt: 4, type: 'surface', change: 'destroyed' },
    ]);
  });

  it('with the child window an unrequested quit is a crash', async () => {
    const { engine, fake, events, ui } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    fake.userQuit();
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toMatchObject({ attempt: 1, error: { code: 'engine-wedged' } });
    expect(ui).toEqual([]);
  });

  it('a failed spawn reports engine-wedged to the load waiting for it', async () => {
    let failures = 2;
    const { engine, events } = await setup({
      ready: false,
      spawn: (fake) => (args, signal) =>
        failures-- > 0
          ? Promise.reject(new Error('mpv could not start'))
          : fake.spawn(args, signal),
    });
    await sleep(20);
    engine.load(live(1));
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toMatchObject({ attempt: 1, error: { code: 'engine-wedged' } });
    engine.load(live(2));
    await playing(events, 2);
    expect(engine.spawns).toBe(3);
  });

  it('release quits mpv, disposes the presenter and emits nothing afterwards', async () => {
    const { engine, fake, events, presenter } = await setup();
    engine.load(live(1));
    await playing(events, 1);
    engine.release();
    const mark = events.length;
    engine.play(2);
    await sleep(100);
    expect(fake.sent.at(-1)).toEqual(['quit']);
    expect(presenter.disposed).toBe(true);
    expect(events).toHaveLength(mark);
  });
});

describe('MpvEngine presenter commands', () => {
  it('passes the player area and the fullscreen toggle to the presenter', async () => {
    const { engine, presenter } = await setup();
    const area = { x: 1, y: 2, width: 640, height: 360, visible: true };
    engine.setArea(area);
    engine.toggleFullscreen();
    expect(presenter.areas).toEqual([area]);
    expect(presenter.fullscreen).toBe(1);
  });

  it('ignores both after release', async () => {
    const { engine, presenter } = await setup();
    engine.release();
    engine.setArea({ x: 0, y: 0, width: 1, height: 1, visible: false });
    engine.toggleFullscreen();
    expect(presenter.areas).toEqual([]);
    expect(presenter.fullscreen).toBe(0);
  });
});

describe('MpvEngine deferred start', () => {
  it('spawns nothing until start() when deferStart is set', async () => {
    const { fake, engine } = await setup({ deferStart: true, ready: false });
    await sleep(60);
    expect(fake.connections).toBe(0);
    expect(engine.spawns).toBe(0);
    engine.start();
    engine.start();
    await vi.waitFor(() => expect(fake.connections).toBe(1));
    expect(engine.spawns).toBe(1);
  });

  it('start() does nothing after release', async () => {
    const { fake, engine } = await setup({ deferStart: true, ready: false });
    engine.release();
    engine.start();
    await sleep(60);
    expect(fake.connections).toBe(0);
  });

  it('a load before start() still starts mpv once', async () => {
    const { fake, engine, events } = await setup({
      deferStart: true,
      ready: false,
      scripts: { [URL_A]: FAKE_PLAYING },
    });
    engine.load(live(1));
    engine.start();
    await playing(events, 1);
    expect(fake.connections).toBe(1);
  });

  it('does not rebind an entry whose start-file and end-file beat the loadfile reply', async () => {
    let emitEvent!: (e: Record<string, unknown>) => void;
    const { engine, events } = await setup({
      spawn: (fake) => async (args, signal) => {
        const proc = await fake.spawn(args, signal);
        const origOnEvent = proc.client.onEvent.bind(proc.client);
        const origCommand = proc.client.command.bind(proc.client);
        return {
          ...proc,
          client: {
            ...proc.client,
            onEvent: (cb) => {
              emitEvent = cb as (e: Record<string, unknown>) => void;
              return origOnEvent(cb);
            },
            command: async (cmd) => {
              if (cmd[0] === 'loadfile') {
                emitEvent({ event: 'start-file', playlist_entry_id: 99 });
                emitEvent({ event: 'playback-restart' });
                emitEvent({ event: 'end-file', playlist_entry_id: 99, reason: 'eof' });
                return { request_id: 1, error: 'success', data: { playlist_entry_id: 99 } };
              }
              return origCommand(cmd);
            },
          },
        };
      },
    });
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await sleep(30);
    emitEvent({ event: 'start-file', playlist_entry_id: 99 });
    await sleep(20);
    expect(states(events, 1)).toEqual(['opening', 'ended']);
  });
});
