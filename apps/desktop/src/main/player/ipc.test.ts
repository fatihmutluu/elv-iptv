import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS, type PlayerUiEvent } from '../../shared/player-ipc.ts';
import type { TrustedSenderEventLike } from '../trusted-sender.ts';
import type { MpvEngine } from './engine.ts';
import {
  type IpcMainLike,
  type PlayerIpcDeps,
  registerPlayerIpc,
  type WebContentsLike,
} from './ipc.ts';
import { createPowerBlocker } from './power-blocker.ts';

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
    handlers,
    listeners,
    invoke: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.(trustedEvent(sender), ...args)),
    emit: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      void listeners.get(channel)?.(trustedEvent(sender), ...args),
  };
}

interface Navigation {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

interface FakeContents extends WebContentsLike {
  sent: Array<{ channel: string; payload: unknown }>;
  destroy(): void;
  navigate(details: Navigation): void;
  crash(): void;
}

function fakeContents(id: number): FakeContents {
  let destroyed = false;
  const onDestroyed: Array<() => void> = [];
  const onNavigate: Array<(d: Navigation) => void> = [];
  const onCrash: Array<() => void> = [];
  return {
    id,
    sent: [],
    isDestroyed: () => destroyed,
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
    once: (_event, listener) => void onDestroyed.push(listener),
    on(event: string, listener: unknown) {
      if (event === 'did-start-navigation') onNavigate.push(listener as (d: Navigation) => void);
      else onCrash.push(listener as () => void);
    },
    navigate(details: Navigation) {
      for (const l of onNavigate) l(details);
    },
    crash() {
      for (const l of onCrash) l();
    },
    destroy() {
      destroyed = true;
      for (const l of onDestroyed) l();
    },
  } as FakeContents;
}

interface StubEngine extends MpvEngine {
  calls: unknown[][];
  released: number;
  started: number;
  onStart?: () => void;
  emit(event: EngineEvent): void;
}

function stubEngine(): StubEngine {
  const listeners = new Set<(e: EngineEvent) => void>();
  const e = {
    calls: [] as unknown[][],
    released: 0,
    started: 0,
    onStart: undefined as (() => void) | undefined,
    start: () => {
      e.started += 1;
      e.onStart?.();
    },
    capabilities: {},
    spawns: 0,
    loadMode: 'replace',
    presenterKind: 'child-window',
    load: (cmd: LoadCommand) => e.calls.push(['load', cmd]),
    retry: (a: number) => e.calls.push(['retry', a]),
    play: (a: number) => e.calls.push(['play', a]),
    pause: (a: number) => e.calls.push(['pause', a]),
    seek: (a: number, ms: number) => e.calls.push(['seek', a, ms]),
    setSpeed: (a: number, rate: number) => e.calls.push(['setSpeed', a, rate]),
    selectAudioTrack: (a: number, id: string) => e.calls.push(['selectAudioTrack', a, id]),
    selectSubtitleTrack: (a: number, id: string | null) =>
      e.calls.push(['selectSubtitleTrack', a, id]),
    setVolume: (volume: number) => e.calls.push(['setVolume', volume]),
    setAudioDelay: (delaySec: number) => e.calls.push(['setAudioDelay', delaySec]),
    setSubtitleDelay: (delaySec: number) => e.calls.push(['setSubtitleDelay', delaySec]),
    setAudioDevice: (device: string) => e.calls.push(['setAudioDevice', device]),
    setDeinterlace: (enabled: boolean) => e.calls.push(['setDeinterlace', enabled]),
    setHwdec: (profile: string) => e.calls.push(['setHwdec', profile]),
    setResizeMode: (mode: string) => e.calls.push(['setResizeMode', mode]),
    setFilterSdh: (enabled: boolean) => e.calls.push(['setFilterSdh', enabled]),
    setSubtitleFontFamily: (family: string) => e.calls.push(['setSubtitleFontFamily', family]),
    stop: (a: number) => e.calls.push(['stop', a]),
    recreate: (a: number) => e.calls.push(['recreate', a]),
    release: () => {
      e.released += 1;
    },
    setArea: (area: unknown) => e.calls.push(['setArea', area]),
    toggleFullscreen: () => e.calls.push(['fullscreen']),
    toggleMute: () => e.calls.push(['mute']),
    subscribe(l: (ev: EngineEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (ev: EngineEvent) => {
      for (const l of [...listeners]) l(ev);
    },
  };
  return e as unknown as StubEngine;
}

const LOAD: LoadCommand = {
  attempt: 1,
  url: 'http://sim.test/live/demo/demo/1001.ts',
  headers: { 'User-Agent': 'elv' },
  kind: 'live',
};

function setup(
  extra: Partial<
    Pick<PlayerIpcDeps, 'gateReport' | 'powerBlocker' | 'bufferingReleaseMs' | 'timers'>
  > = {},
) {
  const ipc = fakeIpcMain();
  const engines: StubEngine[] = [];
  const uiSinks: Array<(e: PlayerUiEvent) => void> = [];
  const logs: string[] = [];
  const createEngine = vi.fn(async (_owner: WebContentsLike, onUi: (e: PlayerUiEvent) => void) => {
    const engine = stubEngine();
    engines.push(engine);
    uiSinks.push(onUi);
    return engine;
  });
  const dispose = registerPlayerIpc({
    ipcMain: ipc.ipcMain,
    createEngine,
    now: () => 777,
    log: (line) => logs.push(line),
    ...extra,
  });
  return { ...ipc, engines, uiSinks, logs, createEngine, dispose };
}

const open = async (t: ReturnType<typeof setup>, owner: WebContentsLike) =>
  (await t.invoke(PLAYER_CHANNELS.open, owner)) as { engineId: string; mainNowMs: number };

describe('registerPlayerIpc', () => {
  it('open returns engineId and mainNowMs and passes engineId to createEngine', async () => {
    const t = setup();
    const a = fakeContents(1);
    const reply = await open(t, a);
    expect(reply.engineId).toEqual(expect.any(String));
    expect(reply.mainNowMs).toBe(777);
    expect(t.createEngine).toHaveBeenCalledWith(
      a,
      expect.any(Function),
      reply.engineId,
      expect.any(Function),
    );
  });

  it('a second open from the same window releases the first engine', async () => {
    const t = setup();
    const a = fakeContents(1);
    const b = fakeContents(2);
    const first = await open(t, a);
    await open(t, b);
    const second = await open(t, a);
    expect(second.engineId).not.toBe(first.engineId);
    expect(t.engines.map((e) => e.released)).toEqual([1, 0, 0]);
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: first.engineId,
      command: { name: 'stop', attempt: 1 },
    });
    expect(t.engines[0]?.calls).toEqual([]);
  });

  it('starts the engine after subscribing, so its first events reach the renderer', async () => {
    const t = setup();
    const a = fakeContents(1);
    t.createEngine.mockImplementationOnce(async () => {
      const engine = stubEngine();
      engine.onStart = () => engine.emit({ attempt: 0, type: 'surface', change: 'created' });
      t.engines.push(engine);
      return engine;
    });
    const reply = await open(t, a);
    expect(t.engines[0]?.started).toBe(1);
    expect(a.sent).toEqual([
      {
        channel: PLAYER_CHANNELS.event,
        payload: {
          engineId: reply.engineId,
          event: { attempt: 0, type: 'surface', change: 'created' },
        },
      },
    ]);
  });

  it('does not start an engine whose window died while it was being created', async () => {
    const t = setup();
    const a = fakeContents(1);
    t.createEngine.mockImplementationOnce(async () => {
      const engine = stubEngine();
      t.engines.push(engine);
      a.destroy();
      return engine;
    });
    await expect(open(t, a)).rejects.toThrow();
    expect(t.engines[0]?.started).toBe(0);
  });

  it('a main-frame cross-document navigation releases the window engines', async () => {
    const t = setup();
    const a = fakeContents(1);
    await open(t, a);
    a.navigate({ isMainFrame: false, isSameDocument: false });
    a.navigate({ isMainFrame: true, isSameDocument: true });
    expect(t.engines[0]?.released).toBe(0);
    a.navigate({ isMainFrame: true, isSameDocument: false });
    expect(t.engines[0]?.released).toBe(1);
    await open(t, a);
    expect(t.engines[1]?.released).toBe(0);
  });

  it('a renderer crash releases the window engines', async () => {
    const t = setup();
    const a = fakeContents(1);
    const b = fakeContents(2);
    await open(t, a);
    await open(t, b);
    a.crash();
    expect(t.engines.map((e) => e.released)).toEqual([1, 0]);
  });

  it('samples the clock on arrival and at the reply and sends the mean', async () => {
    const ipc = fakeIpcMain();
    const times = [100, 300];
    registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      createEngine: async () => stubEngine(),
      now: () => times.shift() ?? 0,
      log: () => undefined,
    });
    const reply = (await ipc.invoke(PLAYER_CHANNELS.open, fakeContents(1))) as {
      mainNowMs: number;
    };
    expect(reply.mainNowMs).toBe(200);
  });

  it('a throwing engine does not escape the handlers and only the channel is logged', async () => {
    const t = setup();
    const a = fakeContents(1);
    const ra = await open(t, a);
    const engine = t.engines[0];
    if (!engine) throw new Error('no engine');
    engine.load = () => {
      throw new Error('boom http://sim.test/live/demo/demo/1.ts');
    };
    engine.setArea = () => {
      throw new Error('boom');
    };
    expect(() =>
      t.emit(PLAYER_CHANNELS.command, a, {
        engineId: ra.engineId,
        command: { name: 'load', cmd: LOAD },
      }),
    ).not.toThrow();
    expect(() =>
      t.emit(PLAYER_CHANNELS.area, a, {
        engineId: ra.engineId,
        area: { x: 0, y: 0, width: 1, height: 1, visible: true },
      }),
    ).not.toThrow();
    expect(t.logs).toHaveLength(2);
    for (const line of t.logs) expect(line).not.toContain('demo');
  });

  it("commands reach only the sender's engine", async () => {
    const t = setup();
    const a = fakeContents(1);
    const b = fakeContents(2);
    const ra = await open(t, a);
    await open(t, b);
    const commands: unknown[] = [
      { name: 'load', cmd: LOAD },
      { name: 'retry', attempt: 2 },
      { name: 'play', attempt: 2 },
      { name: 'pause', attempt: 2 },
      { name: 'seek', attempt: 2, positionMs: 900 },
      { name: 'setSpeed', attempt: 2, rate: 1.5 },
      { name: 'selectAudioTrack', attempt: 2, id: 'a:2' },
      { name: 'selectSubtitleTrack', attempt: 2, id: null },
      { name: 'setVolume', volume: 75 },
      { name: 'setAudioDelay', delaySec: 0.25 },
      { name: 'setSubtitleDelay', delaySec: -0.5 },
      { name: 'setAudioDevice', device: 'wasapi/usb' },
      { name: 'setDeinterlace', enabled: true },
      { name: 'setHwdec', profile: 'darwin-compat' },
      { name: 'stop', attempt: 3 },
      { name: 'recreate', attempt: 3 },
      { name: 'fullscreen' },
      { name: 'mute' },
    ];
    for (const command of commands) {
      t.emit(PLAYER_CHANNELS.command, a, { engineId: ra.engineId, command });
    }
    expect(t.engines[0]?.calls).toEqual([
      ['load', LOAD],
      ['retry', 2],
      ['play', 2],
      ['pause', 2],
      ['seek', 2, 900],
      ['setSpeed', 2, 1.5],
      ['selectAudioTrack', 2, 'a:2'],
      ['selectSubtitleTrack', 2, null],
      ['setVolume', 75],
      ['setAudioDelay', 0.25],
      ['setSubtitleDelay', -0.5],
      ['setAudioDevice', 'wasapi/usb'],
      ['setDeinterlace', true],
      ['setHwdec', 'darwin-compat'],
      ['stop', 3],
      ['recreate', 3],
      ['fullscreen'],
      ['mute'],
    ]);
    expect(t.engines[1]?.calls).toEqual([]);
    // b names a's engine: not its own, so it is dropped
    t.emit(PLAYER_CHANNELS.command, b, {
      engineId: ra.engineId,
      command: { name: 'stop', attempt: 9 },
    });
    expect(t.engines[0]?.calls).toHaveLength(18);
    expect(t.logs.length).toBeGreaterThan(0);
  });

  it('area messages reach the sender engine', async () => {
    const t = setup();
    const a = fakeContents(1);
    const ra = await open(t, a);
    const area = { x: 0, y: 40, width: 800, height: 450, visible: true };
    t.emit(PLAYER_CHANNELS.area, a, { engineId: ra.engineId, area });
    expect(t.engines[0]?.calls).toEqual([['setArea', area]]);
  });

  it('events go only to the owning webContents', async () => {
    const t = setup();
    const a = fakeContents(1);
    const b = fakeContents(2);
    const ra = await open(t, a);
    await open(t, b);
    const event: EngineEvent = { attempt: 1, type: 'state', state: 'playing' };
    t.engines[0]?.emit(event);
    expect(a.sent).toEqual([
      { channel: PLAYER_CHANNELS.event, payload: { engineId: ra.engineId, event } },
    ]);
    expect(b.sent).toEqual([]);
    const ui: PlayerUiEvent = { type: 'closed' };
    t.uiSinks[0]?.(ui);
    expect(a.sent[1]).toEqual({
      channel: PLAYER_CHANNELS.ui,
      payload: { engineId: ra.engineId, ui },
    });
    expect(b.sent).toEqual([]);
  });

  it('does not send to a destroyed webContents', async () => {
    const t = setup();
    const a = fakeContents(1);
    await open(t, a);
    Object.assign(a, { isDestroyed: () => true });
    t.engines[0]?.emit({ attempt: 1, type: 'state', state: 'playing' });
    t.uiSinks[0]?.({ type: 'closed' });
    expect(a.sent).toEqual([]);
  });

  it('close releases the engine', async () => {
    const t = setup();
    const a = fakeContents(1);
    const b = fakeContents(2);
    const ra = await open(t, a);
    await t.invoke(PLAYER_CHANNELS.close, b, ra.engineId);
    expect(t.engines[0]?.released).toBe(0);
    await t.invoke(PLAYER_CHANNELS.close, a, ra.engineId);
    expect(t.engines[0]?.released).toBe(1);
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'stop', attempt: 1 },
    });
    t.engines[0]?.emit({ attempt: 1, type: 'state', state: 'playing' });
    expect(t.engines[0]?.calls).toEqual([]);
    expect(a.sent).toEqual([]);
    await t.invoke(PLAYER_CHANNELS.close, a, ra.engineId);
    expect(t.engines[0]?.released).toBe(1);
  });

  it('a release command releases and forgets the engine', async () => {
    const t = setup();
    const a = fakeContents(1);
    const ra = await open(t, a);
    t.emit(PLAYER_CHANNELS.command, a, { engineId: ra.engineId, command: { name: 'release' } });
    expect(t.engines[0]?.released).toBe(1);
    t.emit(PLAYER_CHANNELS.command, a, { engineId: ra.engineId, command: { name: 'release' } });
    expect(t.engines[0]?.released).toBe(1);
  });

  it('a destroyed webContents releases its engines', async () => {
    const t = setup();
    const a = fakeContents(1);
    const b = fakeContents(2);
    await open(t, a);
    await open(t, b);
    a.destroy();
    expect(t.engines.map((e) => e.released)).toEqual([1, 0]);
  });

  it('releases an engine whose webContents died while it was being created', async () => {
    const t = setup();
    const a = fakeContents(1);
    t.createEngine.mockImplementationOnce(async () => {
      const engine = stubEngine();
      t.engines.push(engine);
      a.destroy();
      return engine;
    });
    await expect(open(t, a)).rejects.toThrow(/closed/);
    expect(t.engines[0]?.released).toBe(1);
  });

  it('open rejects with the factory error and registers nothing', async () => {
    const t = setup();
    const a = fakeContents(1);
    t.createEngine.mockRejectedValueOnce(new Error('mpv runtime missing; run pnpm mpv fetch'));
    await expect(open(t, a)).rejects.toThrow('mpv runtime missing; run pnpm mpv fetch');
    const ok = await open(t, a);
    expect(ok.engineId).toEqual(expect.any(String));
  });

  it('an invalid message is dropped and logged without its payload', async () => {
    const t = setup();
    const a = fakeContents(1);
    const ra = await open(t, a);
    const bad = {
      engineId: ra.engineId,
      command: { name: 'load', cmd: { ...LOAD, url: 'file:///C:/demo/demo/1001.ts' } },
    };
    t.emit(PLAYER_CHANNELS.command, a, bad);
    t.emit(PLAYER_CHANNELS.area, a, { engineId: ra.engineId, area: 'demo/demo' });
    t.emit(PLAYER_CHANNELS.command, a, { engineId: 'nope', command: { name: 'release' } });
    expect(t.engines[0]?.calls).toEqual([]);
    expect(t.logs).toHaveLength(3);
    for (const line of t.logs) {
      expect(line).not.toContain('demo');
      expect(line).not.toContain('file:');
    }
  });

  it('forwards valid gate reports and drops others when a sink is given', async () => {
    const reports: string[] = [];
    const t = setup({ gateReport: (line) => reports.push(line) });
    const a = fakeContents(1);
    t.emit(PLAYER_CHANNELS.gateReport, a, 'ELV_GATE_PLAYER {"ok":true}');
    t.emit(PLAYER_CHANNELS.gateReport, a, 'something else');
    expect(reports).toEqual(['ELV_GATE_PLAYER {"ok":true}']);
    expect(t.logs).toHaveLength(1);
  });

  it('hands a gate report the engine of the window that sent it, or none without one', async () => {
    const seen: Array<MpvEngine | undefined> = [];
    const t = setup({ gateReport: (_line, engine) => seen.push(engine) });
    const a = fakeContents(1);
    const b = fakeContents(2);
    await open(t, a);
    t.emit(PLAYER_CHANNELS.gateReport, a, 'ELV_GATE_PLAYER {"ok":true}');
    t.emit(PLAYER_CHANNELS.gateReport, b, 'ELV_GATE_PLAYER {"ok":true}');
    expect(seen).toEqual([t.engines[0], undefined]);
  });

  it('has no gate channel without a sink', () => {
    expect(setup().listeners.has(PLAYER_CHANNELS.gateReport)).toBe(false);
  });

  it('the disposer unregisters the channels and releases every engine', async () => {
    const t = setup();
    await open(t, fakeContents(1));
    t.dispose();
    expect(t.engines[0]?.released).toBe(1);
    expect(t.handlers.size).toBe(0);
    expect(t.listeners.size).toBe(0);
  });

  it('concurrent opens from the same webContents release the superseded engine without starting it and fence its onUi', async () => {
    const t = setup();
    const a = fakeContents(1);
    let resolveFirst!: (e: StubEngine) => void;
    t.createEngine.mockImplementationOnce(async (_owner, onUi) => {
      const engine = stubEngine();
      t.engines.push(engine);
      t.uiSinks.push(onUi);
      return await new Promise<StubEngine>((r) => {
        resolveFirst = r;
      });
    });

    const p1 = open(t, a);
    const p2 = open(t, a);
    const r2 = await p2;
    const first = t.engines[0];
    const second = t.engines[1];
    if (!first || !second) throw new Error('expected two engine creations');
    t.uiSinks[0]?.({ type: 'presenter', kind: 'child-window', coversArea: true });
    resolveFirst(first);
    await expect(p1).rejects.toThrow(/superseded|closed/);

    expect(first.released).toBe(1);
    expect(first.started).toBe(0);
    expect(second.released).toBe(0);
    expect(second.started).toBe(1);
    t.uiSinks[0]?.({ type: 'closed' });
    expect(a.sent).toEqual([]);

    t.uiSinks[1]?.({ type: 'closed' });
    expect(a.sent).toEqual([
      { channel: PLAYER_CHANNELS.ui, payload: { engineId: r2.engineId, ui: { type: 'closed' } } },
    ]);
  });

  it('navigation, renderer crash, or ipc disposal during createEngine releases the in-flight engine without starting it', async () => {
    for (const interrupt of ['navigate', 'crash', 'dispose'] as const) {
      const t = setup();
      const a = fakeContents(1);
      t.createEngine.mockImplementationOnce(async (_owner, onUi) => {
        const engine = stubEngine();
        t.engines.push(engine);
        t.uiSinks.push(onUi);
        a.navigate({ isMainFrame: true, isSameDocument: true });
        a.navigate({ isMainFrame: false, isSameDocument: false });
        if (interrupt === 'navigate') a.navigate({ isMainFrame: true, isSameDocument: false });
        else if (interrupt === 'crash') a.crash();
        else t.dispose();
        onUi({ type: 'presenter', kind: 'own-window', coversArea: false });
        return engine;
      });
      await expect(open(t, a)).rejects.toThrow();
      expect(t.engines[0]?.released).toBe(1);
      expect(t.engines[0]?.started).toBe(0);
      expect(a.sent).toEqual([]);
    }
  });
});

describe('registerPlayerIpc powerBlocker buffering stall timeout (#435)', () => {
  function fakePowerBlocker() {
    let nextId = 0;
    const active = new Set<number>();
    const starts: string[] = [];
    const stops: number[] = [];
    const blocker = createPowerBlocker({
      start(type) {
        const id = ++nextId;
        starts.push(type);
        active.add(id);
        return id;
      },
      stop(id) {
        stops.push(id);
        return active.delete(id);
      },
    });
    return { blocker, active, starts, stops };
  }

  it('releases powerBlocker after buffering stall grace timeout and re-acquires when playing resumes', async () => {
    vi.useFakeTimers();
    try {
      const pb = fakePowerBlocker();
      const t = setup({ powerBlocker: pb.blocker, bufferingReleaseMs: 30_000 });
      const a = fakeContents(1);
      await open(t, a);
      const engine = t.engines[0];
      if (!engine) throw new Error('missing engine');

      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      expect(pb.active.size).toBe(1);

      engine.emit({ attempt: 1, type: 'state', state: 'buffering' });
      vi.advanceTimersByTime(29_999);
      expect(pb.active.size).toBe(1);

      vi.advanceTimersByTime(1);
      expect(pb.active.size).toBe(0);
      expect(pb.blocker.activeCount).toBe(0);

      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      expect(pb.active.size).toBe(1);
      expect(pb.blocker.activeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels buffering stall timer when playing resumes before timeout', async () => {
    vi.useFakeTimers();
    try {
      const pb = fakePowerBlocker();
      const t = setup({ powerBlocker: pb.blocker, bufferingReleaseMs: 30_000 });
      const a = fakeContents(1);
      await open(t, a);
      const engine = t.engines[0];
      if (!engine) throw new Error('missing engine');

      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({ attempt: 1, type: 'state', state: 'buffering' });
      vi.advanceTimersByTime(15_000);
      expect(pb.active.size).toBe(1);

      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      vi.advanceTimersByTime(45_000);
      expect(pb.active.size).toBe(1);
      expect(pb.stops).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels buffering stall timer on paused, ended, opening, error, commands, close and dispose', async () => {
    vi.useFakeTimers();
    try {
      const clearSpy = vi.fn((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
      const setSpy = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms));
      const pb = fakePowerBlocker();
      const t = setup({
        powerBlocker: pb.blocker,
        bufferingReleaseMs: 30_000,
        timers: { setTimeout: setSpy, clearTimeout: clearSpy },
      });
      const a = fakeContents(1);
      const ra = await open(t, a);
      const engine = t.engines[0];
      if (!engine) throw new Error('missing engine');

      const cancelEvents: EngineEvent[] = [
        { attempt: 1, type: 'state', state: 'paused' },
        { attempt: 1, type: 'state', state: 'ended' },
        { attempt: 1, type: 'state', state: 'opening' },
        { attempt: 1, type: 'error', error: { code: 'network' } },
      ];
      for (const ev of cancelEvents) {
        engine.emit({ attempt: 1, type: 'state', state: 'playing' });
        engine.emit({ attempt: 1, type: 'state', state: 'buffering' });
        const clearsBefore = clearSpy.mock.calls.length;
        engine.emit(ev);
        expect(clearSpy.mock.calls.length).toBe(clearsBefore + 1);
        expect(pb.active.size).toBe(0);
      }

      const cancelCommands = [
        { name: 'load', cmd: LOAD },
        { name: 'pause', attempt: 2 },
        { name: 'stop', attempt: 2 },
        { name: 'recreate', attempt: 2 },
      ] as const;
      for (const command of cancelCommands) {
        engine.emit({ attempt: 2, type: 'state', state: 'playing' });
        engine.emit({ attempt: 2, type: 'state', state: 'buffering' });
        const clearsBefore = clearSpy.mock.calls.length;
        t.emit(PLAYER_CHANNELS.command, a, { engineId: ra.engineId, command });
        expect(clearSpy.mock.calls.length).toBe(clearsBefore + 1);
        expect(pb.active.size).toBe(0);
      }

      // Close clears armed buffering timer cleanly
      engine.emit({ attempt: 3, type: 'state', state: 'playing' });
      engine.emit({ attempt: 3, type: 'state', state: 'buffering' });
      const clearsBeforeClose = clearSpy.mock.calls.length;
      await t.invoke(PLAYER_CHANNELS.close, a, ra.engineId);
      expect(clearSpy.mock.calls.length).toBe(clearsBeforeClose + 1);
      expect(pb.active.size).toBe(0);

      // Dispose clears armed buffering timer cleanly
      await open(t, a);
      const engine2 = t.engines[1];
      if (!engine2) throw new Error('missing second engine');
      engine2.emit({ attempt: 4, type: 'state', state: 'playing' });
      engine2.emit({ attempt: 4, type: 'state', state: 'buffering' });
      const clearsBeforeDispose = clearSpy.mock.calls.length;
      t.dispose();
      expect(clearSpy.mock.calls.length).toBe(clearsBeforeDispose + 1);
      vi.advanceTimersByTime(60_000);
      expect(pb.active.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches valid setSubtitleFontFamily commands and drops invalid ones (#163)', async () => {
    const t = setup();
    const a = fakeContents(1);
    const { engineId } = await open(t, a);
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId,
      command: { name: 'setSubtitleFontFamily', family: 'atkinson' },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId,
      command: { name: 'setSubtitleFontFamily', family: 'opendyslexic' },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId,
      command: { name: 'setSubtitleFontFamily', family: 'system' },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId,
      command: { name: 'setSubtitleFontFamily', family: 'invalid-font' },
    });
    expect(t.engines[0]?.calls).toEqual([
      ['setSubtitleFontFamily', 'atkinson'],
      ['setSubtitleFontFamily', 'opendyslexic'],
      ['setSubtitleFontFamily', 'system'],
    ]);
    expect(t.logs).toHaveLength(1);
    t.dispose();
  });
});
