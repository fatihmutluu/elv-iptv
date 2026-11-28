import type { EngineEvent, MediaTracks } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_CAPABILITIES, PLAYER_CHANNELS } from '../../shared/player-ipc.ts';
import { createMpvEngine, type MpvEngine, type MpvEngineDeps } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';
import type { MpvClient } from './mpv/client.ts';
import { createFakeMpv, type FakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { LAUNCH_OPTIONS } from './mpv/options.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_MUX = 'http://sim.test/live/demo/mux.ts';
const URL_NEXT = 'http://sim.test/live/demo/single.ts';

const MULTI_PROGRAM_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  {
    afterMs: 2,
    property: 'track-list',
    value: [
      { id: 1, type: 'video', codec: 'h264', 'program-id': 101, selected: true },
      { id: 2, type: 'video', codec: 'h264', 'program-id': 202, selected: false },
      { id: 1, type: 'audio', lang: 'eng', 'program-id': 101, selected: true },
      { id: 2, type: 'audio', lang: 'tur', 'program-id': 202, selected: false },
    ],
  },
  { afterMs: 2, property: 'aid', value: 1 },
  { afterMs: 2, property: 'program', value: 101 },
  { afterMs: 4, event: 'file-loaded' },
  { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 6, property: 'time-pos', value: 1.0 },
  { afterMs: 6, event: 'playback-restart' },
];

const SINGLE_PROGRAM_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  {
    afterMs: 2,
    property: 'track-list',
    value: [
      { id: 1, type: 'video', codec: 'h264', selected: true },
      { id: 1, type: 'audio', lang: 'eng', selected: true },
    ],
  },
  { afterMs: 2, property: 'aid', value: 1 },
  { afterMs: 4, event: 'file-loaded' },
];

const timers: MpvEngineDeps['timers'] = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function stubPresenter(onAttach: (client: MpvClient) => void): VideoPresenter {
  return {
    kind: 'child-window',
    coversArea: true,
    prepare: async () => ['--wid=4660'],
    attach: onAttach,
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    onEvent: () => () => undefined,
    dispose: () => undefined,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setupEngine() {
  const fake: FakeMpv = createFakeMpv({
    scripts: { [URL_MUX]: MULTI_PROGRAM_SCRIPT, [URL_NEXT]: SINGLE_PROGRAM_SCRIPT },
    transport: 'socket',
  });
  let client: MpvClient | undefined;
  const engine = createMpvEngine({
    spawn: (args, signal) => fake.spawn(args, signal),
    presenter: stubPresenter((c) => {
      client = c;
    }),
    baseArgs: LAUNCH_OPTIONS,
    loadMode: 'replace',
    now: () => Date.now(),
    timers,
    onUi: () => undefined,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  cleanups.push(async () => {
    engine.release();
    await fake.dispose();
  });
  await vi.waitFor(() => {
    expect(fake.sent).toContainEqual(['request_log_messages', 'v']);
    expect(client).toBeDefined();
  });
  await client?.command(['get_property', 'pause']);
  return { fake, engine, events };
}

const tracksEvents = (events: readonly EngineEvent[]): MediaTracks[] =>
  events.flatMap((e) => (e.type === 'tracks' ? [e.tracks] : []));

function fakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const ipcMain: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn as (...args: unknown[]) => unknown),
    on: (ch, fn) => {
      let set = listeners.get(ch);
      if (!set) {
        set = new Set();
        listeners.set(ch, set);
      }
      set.add(fn as (...args: unknown[]) => void);
    },
    removeHandler: (ch) => void handlers.delete(ch),
    removeListener: (ch, fn) => void listeners.get(ch)?.delete(fn as (...args: unknown[]) => void),
  };
  const senderFrame: { url: string; top?: unknown } = { url: 'app://elv/index.html' };
  senderFrame.top = senderFrame;
  return {
    ipcMain,
    invoke: (ch: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(ch)?.({ sender, senderFrame }, ...args)),
    send: (ch: string, sender: WebContentsLike, ...args: unknown[]) => {
      for (const l of [...(listeners.get(ch) ?? [])]) l({ sender, senderFrame }, ...args);
    },
  };
}

function fakeOwner(id = 1): WebContentsLike {
  return {
    id,
    isDestroyed: () => false,
    send: () => undefined,
    once: () => undefined,
    on: () => undefined,
  };
}

describe('Wave F7B MpvEngine & IPC multi-program selection (#304)', () => {
  it('dispatches selectProgram over player IPC and ignores invalid payloads', async () => {
    const ipc = fakeIpcMain();
    const owner = fakeOwner(41);
    const selectProgram = vi.fn();
    const engine = {
      capabilities: DESKTOP_CAPABILITIES,
      spawns: 1,
      maxHoldMs: 0,
      loadMode: 'replace',
      presenterKind: 'canvas',
      lastArea: undefined,
      start: vi.fn(),
      setArea: vi.fn(),
      toggleFullscreen: vi.fn(),
      toggleMute: vi.fn(),
      setVolume: vi.fn(),
      setAudioDelay: vi.fn(),
      setSubtitleDelay: vi.fn(),
      setAudioDevice: vi.fn(),
      setDeinterlace: vi.fn(),
      setDeinterlaceMode: vi.fn(),
      setPitchLock: vi.fn(),
      setAudioNormalization: vi.fn(),
      queueNext: vi.fn(),
      clearQueue: vi.fn(),
      onQueueAdvanced: () => () => undefined,
      setHwdec: vi.fn(),
      setResizeMode: vi.fn(),
      setFilterSdh: vi.fn(),
      setSubtitleFontFamily: vi.fn(),
      load: vi.fn(),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      selectProgram,
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(),
      subscribe: () => () => undefined,
    } as unknown as MpvEngine;

    const log = vi.fn();
    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 100,
      log,
      createEngine: async () => engine,
    });

    const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, owner)) as { engineId: string };
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'selectProgram', attempt: 3, id: '202' },
    });
    expect(selectProgram).toHaveBeenCalledWith(3, '202');

    // Invalid payload is dropped without invoking engine
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'selectProgram', attempt: 4, id: 'bad;id' },
    });
    expect(selectProgram).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();

    dispose();
  });

  it('passes program=<num> on loadfile, executes set_property program on selectProgram, and resets program on next channel', async () => {
    const { fake, engine, events } = await setupEngine();

    engine.load({
      attempt: 1,
      url: URL_MUX,
      headers: {},
      kind: 'live',
      options: { programId: '202' },
    });

    await vi.waitFor(() => {
      const loadCmd = fake.sent.find((cmd) => cmd[0] === 'loadfile');
      expect(loadCmd).toBeDefined();
      expect((loadCmd?.[4] as Record<string, string> | undefined)?.['program']).toBe('202');
    });

    await vi.waitFor(() => {
      expect(tracksEvents(events).at(-1)).toMatchObject({
        selectedProgramId: '202',
        programs: [
          { id: '101', label: 'Program 101', programNumber: 101 },
          { id: '202', label: 'Program 202', programNumber: 202 },
        ],
      });
    });

    engine.selectProgram?.(2, '101');
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'program', 101]));
    await vi.waitFor(() => {
      expect(tracksEvents(events).at(-1)?.selectedProgramId).toBe('101');
    });

    // Loading a new single-program channel must NOT pass previous programId
    engine.load({
      attempt: 3,
      url: URL_NEXT,
      headers: {},
      kind: 'live',
    });

    await vi.waitFor(() => {
      const nextLoad = fake.sent.filter((cmd) => cmd[0] === 'loadfile')[1];
      expect(nextLoad).toBeDefined();
      expect(nextLoad?.[4]).not.toHaveProperty('program');
    });

    await vi.waitFor(() => {
      const last = tracksEvents(events).at(-1);
      expect(last?.programs).toBeUndefined();
      expect(last?.selectedProgramId).toBeUndefined();
    });
  });
});
