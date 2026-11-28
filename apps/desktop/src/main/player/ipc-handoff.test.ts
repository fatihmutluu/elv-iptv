import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  PLAYER_CHANNELS,
  type PlayerUiEvent,
  type PresenterKind,
} from '../../shared/player-ipc.ts';
import type { TaskbarController } from '../taskbar-controls.ts';
import type { TrustedSenderEventLike } from '../trusted-sender.ts';
import type { MpvEngine } from './engine.ts';
import {
  type IpcMainLike,
  type PlayerIpcDeps,
  registerPlayerIpc,
  type WebContentsLike,
} from './ipc.ts';

type Listener = (
  event: TrustedSenderEventLike & { sender: WebContentsLike },
  ...args: unknown[]
) => unknown;

function trustedEvent(sender: WebContentsLike) {
  const frame: { url: string; top?: unknown } = { url: 'app://elv/index.html' };
  frame.top = frame;
  return { sender, senderFrame: frame };
}

function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    on: (channel, listener) => void listeners.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
    removeListener: (channel) => void listeners.delete(channel),
  };
  return {
    ipcMain,
    invoke: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.(trustedEvent(sender), ...args)),
    emit: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      void listeners.get(channel)?.(trustedEvent(sender), ...args),
  };
}

function fakeContents(id: number) {
  let destroyed = false;
  const onDestroyed: Array<() => void> = [];
  const onNavigate: Array<(d: { isMainFrame: boolean; isSameDocument: boolean }) => void> = [];
  const onCrash: Array<() => void> = [];
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const wc: WebContentsLike = {
    id,
    isDestroyed: () => destroyed,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    once: (_event, listener) => void onDestroyed.push(listener),
    on(event: string, listener: unknown) {
      if (event === 'did-start-navigation') {
        onNavigate.push(listener as (d: { isMainFrame: boolean; isSameDocument: boolean }) => void);
      } else {
        onCrash.push(listener as () => void);
      }
    },
  };
  return {
    wc,
    sent,
    destroy() {
      destroyed = true;
      for (const l of onDestroyed) l();
    },
    navigate(isMainFrame = true, isSameDocument = false) {
      for (const l of onNavigate) l({ isMainFrame, isSameDocument });
    },
  };
}

function stubEngine(presenterKind: PresenterKind = 'canvas') {
  const listeners = new Set<(e: EngineEvent) => void>();
  const calls: unknown[][] = [];
  let released = 0;
  const engine = {
    calls,
    get released() {
      return released;
    },
    capabilities: {},
    spawns: 1,
    maxHoldMs: 0,
    loadMode: 'replace' as const,
    presenterKind,
    lastArea: undefined,
    start: vi.fn(),
    load: (cmd: LoadCommand) => calls.push(['load', cmd]),
    retry: (a: number) => calls.push(['retry', a]),
    play: (a: number) => calls.push(['play', a]),
    pause: (a: number) => calls.push(['pause', a]),
    seek: (a: number, ms: number) => calls.push(['seek', a, ms]),
    stop: (a: number) => calls.push(['stop', a]),
    recreate: (a: number) => calls.push(['recreate', a]),
    release: () => {
      released += 1;
    },
    setArea: (area: unknown) => calls.push(['setArea', area]),
    toggleFullscreen: () => calls.push(['fullscreen']),
    toggleMute: () => calls.push(['mute']),
    retargetWindow: presenterKind === 'canvas' ? vi.fn(() => true) : undefined,
    subscribe(l: (ev: EngineEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(ev: EngineEvent) {
      for (const l of [...listeners]) l(ev);
    },
  };
  return engine;
}

function fakeTimers() {
  let seq = 0;
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        scheduled.set(id, { fn, ms });
        return id;
      },
      clearTimeout(handle: unknown) {
        scheduled.delete(handle as number);
      },
    },
    scheduled,
    fireAll() {
      for (const [id, entry] of [...scheduled]) {
        scheduled.delete(id);
        entry.fn();
      }
    },
  };
}

describe('player IPC park & adopt handoff (Wave P3)', () => {
  it('parks a live canvas engine, survives old owner destruction, retargets & replays snapshots on adopt', async () => {
    const ipc = fakeIpcMain();
    const t = fakeTimers();
    const engines: Array<ReturnType<typeof stubEngine>> = [];
    const uiSinks: Array<(e: PlayerUiEvent) => void> = [];
    const aspectChanges: Array<{ ownerId: number; ratio: number | undefined }> = [];
    const taskbarClears: number[] = [];
    const taskbarUpdates: Array<{ ownerId: number; active: boolean }> = [];
    const retargets: Array<{ engine: MpvEngine; nextOwnerId: number }> = [];
    let clockMs = 1000;

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => {
        clockMs += 10;
        return clockMs;
      },
      log: () => undefined,
      timers: t.timers,
      createTaskbarController: (owner): TaskbarController => ({
        updatePlayback: (state) => {
          taskbarUpdates.push({ ownerId: owner.id, active: state.active });
        },
        clear: () => {
          taskbarClears.push(owner.id);
        },
      }),
      onVideoAspectRatioChange: (owner, ratio) => {
        aspectChanges.push({ ownerId: owner.id, ratio });
      },
      retargetOwner: (engine, nextOwner) => {
        retargets.push({ engine, nextOwnerId: nextOwner.id });
        return true;
      },
      createEngine: async (_owner, onUi) => {
        const eng = stubEngine('canvas');
        engines.push(eng);
        uiSinks.push(onUi);
        onUi({ type: 'presenter', kind: 'canvas', coversArea: false });
        onUi({
          type: 'audio-devices',
          devices: [{ name: 'auto', description: 'Default' }],
          active: 'auto',
        });
        return eng as unknown as MpvEngine;
      },
    });

    const mainWin = fakeContents(1);
    const popoutWin = fakeContents(2);

    const openReply = (await ipc.invoke(PLAYER_CHANNELS.open, mainWin.wc)) as {
      engineId: string;
      mainNowMs: number;
    };
    const eng = engines[0];
    if (!eng) throw new Error('expected engine');

    // Emit live state, clock, tracks, and mediaInfo while owned by mainWin
    eng.emit({ attempt: 3, type: 'state', state: 'playing' });
    eng.emit({
      attempt: 3,
      type: 'clock',
      anchor: { positionMs: 12_500, durationMs: 60_000, atMs: 1050, rate: 1 },
    });
    eng.emit({
      attempt: 3,
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a:1', label: 'English' }],
        subtitles: [],
        selectedAudioId: 'a:1',
        selectedSubtitleId: null,
      },
    });
    eng.emit({
      attempt: 3,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, aspectRatio: 16 / 9, fps: 25 },
    });

    // Park engine from mainWin
    const parked = await ipc.invoke(PLAYER_CHANNELS.park, mainWin.wc, openReply.engineId);
    expect(parked).toBe(true);
    expect(eng.released).toBe(0);
    expect(taskbarClears).toContain(1);
    expect(aspectChanges.at(-1)).toEqual({ ownerId: 1, ratio: undefined });
    expect(t.scheduled.size).toBe(1);
    expect([...t.scheduled.values()][0]?.ms).toBe(15_000);

    // Even if mainWin tries to close or navigates while parked, the parked engine stays alive!
    await ipc.invoke(PLAYER_CHANNELS.close, mainWin.wc, openReply.engineId);
    mainWin.navigate(true, false);
    expect(eng.released).toBe(0);

    // Popout adopts the parked engine
    const adoptReply = (await ipc.invoke(
      PLAYER_CHANNELS.adopt,
      popoutWin.wc,
      openReply.engineId,
    )) as {
      engineId: string;
      mainNowMs: number;
    } | null;
    expect(adoptReply).not.toBeNull();
    expect(adoptReply?.engineId).toBe(openReply.engineId);
    expect(t.scheduled.size).toBe(0);
    expect(retargets).toEqual([{ engine: eng as unknown as MpvEngine, nextOwnerId: 2 }]);
    expect(aspectChanges.at(-1)).toEqual({ ownerId: 2, ratio: 16 / 9 });
    expect(taskbarUpdates.at(-1)).toEqual({ ownerId: 2, active: true });

    // Replayed UI events and engine event snapshots reached popoutWin
    const popoutUiTypes = popoutWin.sent
      .filter((m) => m.channel === PLAYER_CHANNELS.ui)
      .map((m) => (m.payload as { ui: PlayerUiEvent }).ui.type);
    expect(popoutUiTypes).toContain('presenter');
    expect(popoutUiTypes).toContain('fullscreen-changed');
    expect(popoutUiTypes).toContain('audio-devices');

    const popoutEventTypes = popoutWin.sent
      .filter((m) => m.channel === PLAYER_CHANNELS.event)
      .map((m) => (m.payload as { event: EngineEvent }).event.type);
    expect(popoutEventTypes).toEqual(['state', 'clock', 'tracks', 'mediaInfo']);

    // Subsequent commands from mainWin are dropped; commands from popoutWin reach mpv
    ipc.emit(PLAYER_CHANNELS.command, mainWin.wc, {
      engineId: openReply.engineId,
      command: { name: 'pause', attempt: 3 },
    });
    expect(eng.calls).toEqual([]);

    ipc.emit(PLAYER_CHANNELS.command, popoutWin.wc, {
      engineId: openReply.engineId,
      command: { name: 'pause', attempt: 3 },
    });
    expect(eng.calls).toEqual([['pause', 3]]);

    // Subsequent engine & UI events route to popoutWin, NOT mainWin
    const mainCountBefore = mainWin.sent.length;
    eng.emit({ attempt: 3, type: 'state', state: 'paused' });
    uiSinks[0]?.({ type: 'fullscreen-changed', fullscreen: true });
    expect(mainWin.sent.length).toBe(mainCountBefore);
    expect(popoutWin.sent.at(-2)).toMatchObject({
      channel: PLAYER_CHANNELS.event,
      payload: { engineId: openReply.engineId, event: { type: 'state', state: 'paused' } },
    });
    expect(popoutWin.sent.at(-1)).toMatchObject({
      channel: PLAYER_CHANNELS.ui,
      payload: {
        engineId: openReply.engineId,
        ui: { type: 'fullscreen-changed', fullscreen: true },
      },
    });

    // Closing popoutWin releases the adopted engine cleanly
    popoutWin.destroy();
    expect(eng.released).toBe(1);

    dispose();
  });

  it('returns false on park for non-canvas presenters and releases orphaned parked engines after 15s', async () => {
    const ipc = fakeIpcMain();
    const t = fakeTimers();
    let kind: PresenterKind = 'child-window';
    const engines: Array<ReturnType<typeof stubEngine>> = [];
    const logs: string[] = [];

    const deps: PlayerIpcDeps = {
      ipcMain: ipc.ipcMain,
      now: () => 500,
      log: (line) => logs.push(line),
      timers: t.timers,
      retargetOwner: () => true,
      createEngine: async () => {
        const eng = stubEngine(kind);
        engines.push(eng);
        return eng as unknown as MpvEngine;
      },
    };
    const dispose = registerPlayerIpc(deps);
    const win = fakeContents(1);

    // Non-canvas presenter cannot be parked
    const nonCanvas = (await ipc.invoke(PLAYER_CHANNELS.open, win.wc)) as { engineId: string };
    expect(await ipc.invoke(PLAYER_CHANNELS.park, win.wc, nonCanvas.engineId)).toBe(false);

    // Canvas presenter parks and auto-releases if never adopted within 15s
    kind = 'canvas';
    const canvasReply = (await ipc.invoke(PLAYER_CHANNELS.open, win.wc)) as { engineId: string };
    const canvasEng = engines[1];
    if (!canvasEng) throw new Error('expected canvas engine');

    expect(await ipc.invoke(PLAYER_CHANNELS.park, win.wc, canvasReply.engineId)).toBe(true);
    expect(canvasEng.released).toBe(0);

    // Adopt of unknown or invalid engineId returns null
    expect(await ipc.invoke(PLAYER_CHANNELS.adopt, win.wc, 'missing')).toBeNull();
    expect(await ipc.invoke(PLAYER_CHANNELS.adopt, win.wc, 42)).toBeNull();

    // Firing the 15s orphan timer releases the parked engine
    t.fireAll();
    expect(canvasEng.released).toBe(1);
    expect(await ipc.invoke(PLAYER_CHANNELS.adopt, win.wc, canvasReply.engineId)).toBeNull();

    dispose();
  });

  it('releases parked engines and clears orphan timers on dispose() (Wave P3 review #3)', async () => {
    const ipc = fakeIpcMain();
    const t = fakeTimers();
    const engines: Array<ReturnType<typeof stubEngine>> = [];

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 500,
      log: () => undefined,
      timers: t.timers,
      retargetOwner: () => true,
      createEngine: async () => {
        const eng = stubEngine('canvas');
        engines.push(eng);
        return eng as unknown as MpvEngine;
      },
    });
    const win = fakeContents(1);
    const reply = (await ipc.invoke(PLAYER_CHANNELS.open, win.wc)) as { engineId: string };
    const eng = engines[0];
    if (!eng) throw new Error('expected engine');

    expect(await ipc.invoke(PLAYER_CHANNELS.park, win.wc, reply.engineId)).toBe(true);
    expect(t.scheduled.size).toBe(1);
    expect(eng.released).toBe(0);

    dispose();

    expect(t.scheduled.size).toBe(0);
    expect(eng.released).toBe(1);
  });

  it('resolves getMultiViewTileCount from the current adopted owner rather than initial sender (Wave P3 review #9)', async () => {
    const ipc = fakeIpcMain();
    const t = fakeTimers();
    const tileCountGetters: Array<(() => number) | undefined> = [];

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 1000,
      log: () => undefined,
      timers: t.timers,
      retargetOwner: () => true,
      createEngine: async (_owner, _onUi, _engineId, getMultiViewTileCount) => {
        tileCountGetters.push(getMultiViewTileCount);
        return stubEngine('canvas') as unknown as MpvEngine;
      },
    });

    const mainWin = fakeContents(1);
    const popoutWin = fakeContents(2);

    // Open two concurrent tiles on mainWin
    const first = (await ipc.invoke(PLAYER_CHANNELS.open, mainWin.wc, {
      replaceExisting: false,
      primary: true,
    })) as { engineId: string };
    await ipc.invoke(PLAYER_CHANNELS.open, mainWin.wc, {
      replaceExisting: false,
      primary: false,
    });
    const firstGetter = tileCountGetters[0];
    expect(firstGetter?.()).toBe(2);

    // Park first engine and adopt it into popoutWin (which owns 1 tile, while mainWin owns 1 tile)
    expect(await ipc.invoke(PLAYER_CHANNELS.park, mainWin.wc, first.engineId)).toBe(true);
    expect(await ipc.invoke(PLAYER_CHANNELS.adopt, popoutWin.wc, first.engineId)).not.toBeNull();
    expect(firstGetter?.()).toBe(1);

    // Opening a 2nd tile on popoutWin updates firstGetter to 2; opening on mainWin does not affect it
    await ipc.invoke(PLAYER_CHANNELS.open, mainWin.wc, {
      replaceExisting: false,
      primary: false,
    });
    expect(firstGetter?.()).toBe(1);
    await ipc.invoke(PLAYER_CHANNELS.open, popoutWin.wc, {
      replaceExisting: false,
      primary: false,
    });
    expect(firstGetter?.()).toBe(2);

    dispose();
  });
});
