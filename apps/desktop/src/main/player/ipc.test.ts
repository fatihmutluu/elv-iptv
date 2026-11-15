import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS, type PlayerUiEvent } from '../../shared/player-ipc.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';

type Listener = (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown;

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
      Promise.resolve(handlers.get(channel)?.({ sender }, ...args)),
    emit: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      void listeners.get(channel)?.({ sender }, ...args),
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
    stop: (a: number) => e.calls.push(['stop', a]),
    recreate: (a: number) => e.calls.push(['recreate', a]),
    release: () => {
      e.released += 1;
    },
    setArea: (area: unknown) => e.calls.push(['setArea', area]),
    toggleFullscreen: () => e.calls.push(['fullscreen']),
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

function setup(extra: { gateReport?: (line: string, engine: MpvEngine | undefined) => void } = {}) {
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
  it('open returns engineId and mainNowMs', async () => {
    const t = setup();
    const a = fakeContents(1);
    const reply = await open(t, a);
    expect(reply.engineId).toEqual(expect.any(String));
    expect(reply.mainNowMs).toBe(777);
    expect(t.createEngine).toHaveBeenCalledWith(a, expect.any(Function));
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
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'load', cmd: LOAD },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'retry', attempt: 2 },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'play', attempt: 2 },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'pause', attempt: 2 },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'seek', attempt: 2, positionMs: 900 },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'stop', attempt: 3 },
    });
    t.emit(PLAYER_CHANNELS.command, a, {
      engineId: ra.engineId,
      command: { name: 'recreate', attempt: 3 },
    });
    t.emit(PLAYER_CHANNELS.command, a, { engineId: ra.engineId, command: { name: 'fullscreen' } });
    expect(t.engines[0]?.calls).toEqual([
      ['load', LOAD],
      ['retry', 2],
      ['play', 2],
      ['pause', 2],
      ['seek', 2, 900],
      ['stop', 3],
      ['recreate', 3],
      ['fullscreen'],
    ]);
    expect(t.engines[1]?.calls).toEqual([]);
    // b names a's engine: not its own, so it is dropped
    t.emit(PLAYER_CHANNELS.command, b, {
      engineId: ra.engineId,
      command: { name: 'stop', attempt: 9 },
    });
    expect(t.engines[0]?.calls).toHaveLength(8);
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
