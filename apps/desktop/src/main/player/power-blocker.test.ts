import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { PLAYER_CHANNELS } from '../../shared/player-ipc.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';
import { createPowerBlocker } from './power-blocker.ts';

function fakeBlockerApi() {
  let nextId = 10;
  const active = new Set<number>();
  const starts: string[] = [];
  const stops: number[] = [];
  return {
    api: {
      start(type: 'prevent-display-sleep') {
        const id = ++nextId;
        starts.push(type);
        active.add(id);
        return id;
      },
      stop(id: number) {
        stops.push(id);
        return active.delete(id);
      },
      isStarted: (id: number) => active.has(id),
    },
    active,
    starts,
    stops,
  };
}

describe('createPowerBlocker (#135)', () => {
  it('reference-counts keys idempotently and stops prevent-display-sleep on 1 -> 0 or releaseAll', () => {
    const f = fakeBlockerApi();
    const blocker = createPowerBlocker(f.api);

    blocker.acquire('e1');
    blocker.acquire('e1');
    expect(f.starts).toEqual(['prevent-display-sleep']);
    expect(f.active.size).toBe(1);
    expect(blocker.activeCount).toBe(1);

    blocker.acquire('e2');
    expect(f.starts).toHaveLength(1);
    expect(blocker.activeCount).toBe(2);

    blocker.release('e1');
    blocker.release('e1');
    expect(f.active.size).toBe(1);
    expect(blocker.activeCount).toBe(1);

    blocker.release('e2');
    expect(f.active.size).toBe(0);
    expect(f.stops).toHaveLength(1);

    blocker.acquire('e3');
    expect(f.active.size).toBe(1);
    blocker.releaseAll();
    expect(f.active.size).toBe(0);
    expect(blocker.activeCount).toBe(0);
  });

  it('registerPlayerIpc acquires blocker on playing and releases on paused, ended, error, stop and crash', async () => {
    const f = fakeBlockerApi();
    const powerBlocker = createPowerBlocker(f.api);
    const handlers = new Map<
      string,
      (
        ev: { sender: WebContentsLike; senderFrame?: { url?: string; top?: unknown } | null },
        ...a: unknown[]
      ) => unknown
    >();
    const listeners = new Map<
      string,
      (
        ev: { sender: WebContentsLike; senderFrame?: { url?: string; top?: unknown } | null },
        ...a: unknown[]
      ) => unknown
    >();
    const ipcMain: IpcMainLike = {
      handle: (c, l) => void handlers.set(c, l),
      on: (c, l) => void listeners.set(c, l),
      removeHandler: (c) => void handlers.delete(c),
      removeListener: (c) => void listeners.delete(c),
    };

    const engineListeners = new Set<(e: EngineEvent) => void>();
    const crashHandlers: Array<() => void> = [];
    const sender: WebContentsLike = {
      id: 1,
      isDestroyed: () => false,
      send: () => undefined,
      once: () => undefined,
      on(ev: string, l: unknown) {
        if (ev === 'render-process-gone') crashHandlers.push(l as () => void);
      },
    };

    const stub = {
      start: () => undefined,
      load: (_c: LoadCommand) => undefined,
      retry: () => undefined,
      play: () => undefined,
      pause: () => undefined,
      seek: () => undefined,
      stop: () => undefined,
      recreate: () => undefined,
      release: () => undefined,
      setArea: () => undefined,
      toggleFullscreen: () => undefined,
      subscribe(l: (e: EngineEvent) => void) {
        engineListeners.add(l);
        return () => engineListeners.delete(l);
      },
    } as unknown as MpvEngine;

    registerPlayerIpc({
      ipcMain,
      createEngine: async () => stub,
      now: () => 0,
      log: () => undefined,
      powerBlocker,
    });

    const openHandler = handlers.get(PLAYER_CHANNELS.open);
    if (!openHandler) throw new Error('missing open handler');
    const senderFrame: { url: string; top?: unknown } = { url: 'app://elv/index.html' };
    senderFrame.top = senderFrame;
    const { engineId } = (await openHandler({ sender, senderFrame })) as {
      engineId: string;
    };
    const emit = (ev: EngineEvent) => {
      for (const l of [...engineListeners]) l(ev);
    };

    emit({ attempt: 1, type: 'state', state: 'playing' });
    expect(f.active.size).toBe(1);

    emit({ attempt: 1, type: 'state', state: 'paused' });
    expect(f.active.size).toBe(0);

    emit({ attempt: 1, type: 'state', state: 'playing' });
    expect(f.active.size).toBe(1);

    emit({ attempt: 1, type: 'error', error: { code: 'network' } });
    expect(f.active.size).toBe(0);

    emit({ attempt: 2, type: 'state', state: 'playing' });
    expect(f.active.size).toBe(1);

    listeners.get(PLAYER_CHANNELS.command)?.(
      { sender, senderFrame },
      { engineId, command: { name: 'stop', attempt: 3 } },
    );
    expect(f.active.size).toBe(0);

    emit({ attempt: 4, type: 'state', state: 'playing' });
    expect(f.active.size).toBe(1);

    for (const h of crashHandlers) h();
    expect(f.active.size).toBe(0);
  });
});
