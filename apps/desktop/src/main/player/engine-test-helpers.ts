import type { EngineEvent, EngineState, LoadCommand } from '@elv/playback';
import { expect, vi } from 'vitest';
import type { PlayerArea, PlayerUiEvent, PresenterKind } from '../../shared/player-ipc.ts';
import { createMpvEngine, type LoadMode, type MpvEngineDeps } from './engine.ts';
import type { MpvClient } from './mpv/client.ts';
import type { MpvCommand } from './mpv/codec.ts';
import { createFakeMpv, type FakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import type { PresenterEvent, VideoPresenter } from './presenter/types.ts';

export const BASE = ['--no-config', '--idle=yes'];
export const URL_A = 'http://sim.test/live/demo/demo/1001.ts';
export const URL_B = 'http://sim.test/live/demo/demo/1004.ts';
export const URL_VOD = 'http://sim.test/movie/demo/demo/200001.mp4';
export const URL_NOTICE = 'http://sim.test/live/demo/demo/1001.ts?fault=text-notice';
export const URL_NEVER_STARTS = 'http://sim.test/live/demo/demo/1007.ts';
export const URL_NEVER_OPENS = 'http://sim.test/live/demo/demo/1008.ts';

export const OBSERVED = [
  'pause',
  'paused-for-cache',
  'core-idle',
  'seeking',
  'playback-time',
  'time-pos',
  'duration',
  'speed',
  'demuxer-cache-state',
  'video-params',
  'vid',
  'track-list',
  'aid',
  'sid',
  'audio-device-list',
];

export const VOD: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 3, property: 'duration', value: 600 },
  { afterMs: 4, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 6, property: 'time-pos', value: 12.5 },
  { afterMs: 6, event: 'playback-restart' },
];

export const SLOW_OPEN: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 500, event: 'file-loaded' },
  { afterMs: 500, property: 'vid', value: 1 },
  { afterMs: 502, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 505, property: 'time-pos', value: 0 },
  { afterMs: 505, event: 'playback-restart' },
];

const noise = Array.from({ length: 60 }, (_, i) => ({
  afterMs: 5,
  log: { prefix: 'cplayer', level: 'v', text: `Set property: osd-margin-y-offset=${i} -> 1` },
}));

export const NOTICE: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 4, log: { prefix: 'ffmpeg', level: 'v', text: "Mime-type: 'text/plain'" } },
  ...noise,
  { afterMs: 8, event: 'end-file', reason: 'error', fileError: 'unrecognized file format' },
];

export const live = (
  attempt: number,
  url = URL_A,
  headers: Record<string, string> = {},
): LoadCommand => ({
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

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits on real I/O only, so it also works while setTimeout is faked. */
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 20000 && !check(); i += 1) await new Promise((r) => setImmediate(r));
  expect(check()).toBe(true);
}

/** Advances faked timers while yielding to real socket I/O until `check` holds. */
export async function advanceUntil(
  check: () => boolean,
  stepMs = 20,
  maxSteps = 300,
): Promise<void> {
  for (let i = 0; i < maxSteps && !check(); i += 1) {
    await new Promise((r) => setImmediate(r));
    if (check()) break;
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise((r) => setImmediate(r));
  }
  expect(check()).toBe(true);
}

export interface SetupOptions {
  scripts?: Record<string, FakeMpvScript>;
  kind?: PresenterKind;
  loadMode?: LoadMode;
  spawnDelayMs?: number;
  spawn?: (fake: FakeMpv) => MpvEngineDeps['spawn'];
  timers?: MpvEngineDeps['timers'];
  ready?: boolean;
  deferStart?: boolean;
}

export async function setupEngineTest(cleanups: Array<() => Promise<void>>, o: SetupOptions = {}) {
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
    await vi.waitFor(
      () => {
        expect(fake.sent).toContainEqual(['request_log_messages', 'v']);
        expect(presenter.attached).toHaveLength(1);
      },
      { interval: 5 },
    );
    await presenter.attached[0]?.command(['get_property', 'pause']);
  }
  return { fake, presenter, engine, events, ui };
}

export const loadfiles = (fake: FakeMpv): MpvCommand[] =>
  fake.sent.filter((c) => c[0] === 'loadfile');
export const states = (events: readonly EngineEvent[], attempt: number): EngineState[] =>
  events.flatMap((e) => (e.type === 'state' && e.attempt === attempt ? [e.state] : []));
export const errors = (events: readonly EngineEvent[]) => events.filter((e) => e.type === 'error');
export const playing = (events: readonly EngineEvent[], attempt: number) =>
  vi.waitFor(() => expect(states(events, attempt)).toContain('playing'), {
    timeout: 10_000,
    interval: 5,
  });
