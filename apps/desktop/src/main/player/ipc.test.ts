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

interface FakeContents extends WebContentsLike {
  sent: Array<{ channel: string; payload: unknown }>;
  destroy(): void;
}

function fakeContents(id: number): FakeContents {
  let destroyed = false;
  const onDestroyed: Array<() => void> = [];
  return {
    id,
    sent: [],
    isDestroyed: () => destroyed,
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
    once: (_event, listener) => void onDestroyed.push(listener),
    destroy() {
      destroyed = true;
      for (const l of onDestroyed) l();
    },
  } as FakeContents;
}

interface StubEngine extends MpvEngine {
  calls: unknown[][];
  released: number;
  emit(event: EngineEvent): void;
}

function stubEngine(): StubEngine {
  const listeners = new Set<(e: EngineEvent) => void>();
  const e = {
    calls: [] as unknown[][],
    released: 0,
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

function setup(extra: { gateReport?: (line: string) => void } = {}) {
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
    const other = await open(t, a);
    expect(other.engineId).not.toBe(reply.engineId);
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
    await open(t, a);
    await open(t, b);
    a.destroy();
    expect(t.engines.map((e) => e.released)).toEqual([1, 1, 0]);
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
});
