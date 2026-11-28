import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS, type PlayerUiEvent } from '../../shared/player-ipc.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';
import {
  createPlayerWindowHostHooks,
  createPlayerWindowVisibilityHooks,
  schedulePostPaintMpvWarmUp,
  type VisibilityWindowLike,
  type WarmUpWindowLike,
} from './window-lifecycle.ts';

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
    invoke: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({ sender }, ...args)),
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
    navigate() {
      for (const l of onNavigate) l({ isMainFrame: true, isSameDocument: false });
    },
  };
}

function stubWarmUpEngine(
  withWarmUp = true,
  presenterKind: 'canvas' | 'own-window' | 'child-window' = 'canvas',
) {
  const listeners = new Set<(e: EngineEvent) => void>();
  let released = 0;
  let started = 0;
  let warmedUp = 0;
  const engine = {
    get released() {
      return released;
    },
    get started() {
      return started;
    },
    get warmedUp() {
      return warmedUp;
    },
    capabilities: {},
    spawns: 1,
    maxHoldMs: 0,
    loadMode: 'replace' as const,
    presenterKind,
    lastArea: undefined,
    start: () => {
      started += 1;
    },
    ...(withWarmUp
      ? {
          warmUp: () => {
            warmedUp += 1;
          },
        }
      : {}),
    load: (_cmd: LoadCommand) => undefined,
    retry: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    seek: () => undefined,
    stop: () => undefined,
    recreate: () => undefined,
    release: () => {
      released += 1;
    },
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    toggleMute: () => undefined,
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

describe('registerPlayerIpc idle warm-up standby engine', () => {
  it('prewarms one standby engine, replays buffered presenter/surface events on player:open, and avoids a second spawn', async () => {
    const ipc = fakeIpcMain();
    const engines: Array<ReturnType<typeof stubWarmUpEngine>> = [];
    const uiSinks: Array<(e: PlayerUiEvent) => void> = [];
    let triggerWarmUp: ((owner: WebContentsLike) => void) | undefined;

    const createEngine = vi.fn(
      async (_owner: WebContentsLike, onUi: (e: PlayerUiEvent) => void) => {
        const eng = stubWarmUpEngine(true);
        engines.push(eng);
        uiSinks.push(onUi);
        onUi({ type: 'presenter', kind: 'canvas', coversArea: false });
        return eng as unknown as MpvEngine;
      },
    );

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 1_000,
      log: () => undefined,
      createEngine,
      bindWarmUp: (fn) => {
        triggerWarmUp = fn;
      },
    });

    const win = fakeContents(1);
    triggerWarmUp?.(win.wc);
    await Promise.resolve();
    await Promise.resolve();

    expect(createEngine).toHaveBeenCalledTimes(1);
    const standby = engines[0];
    if (!standby) throw new Error('expected standby engine');
    expect(standby.warmedUp).toBe(1);
    expect(standby.released).toBe(0);
    // Nothing sent to renderer before player:open
    expect(win.sent).toEqual([]);

    // Emit surface event and audio-devices while warming up
    standby.emit({ attempt: 0, type: 'surface', change: 'created' });
    uiSinks[0]?.({
      type: 'audio-devices',
      devices: [{ name: 'auto', description: 'Default' }],
      active: 'auto',
    });
    expect(win.sent).toEqual([]);

    // Now renderer invokes player:open -> claims standby immediately with zero second createEngine!
    const reply = (await ipc.invoke(PLAYER_CHANNELS.open, win.wc)) as { engineId: string };
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(reply.engineId).toBe('engine-1');
    expect(standby.started).toBe(1);

    const uiTypes = win.sent
      .filter((m) => m.channel === PLAYER_CHANNELS.ui)
      .map((m) => (m.payload as { ui: PlayerUiEvent }).ui.type);
    expect(uiTypes).toEqual(['presenter', 'audio-devices']);
    const eventTypes = win.sent
      .filter((m) => m.channel === PLAYER_CHANNELS.event)
      .map((m) => (m.payload as { event: EngineEvent }).event.type);
    expect(eventTypes).toEqual(['surface']);

    // Subsequent UI events continue flowing live through the claimed engine
    uiSinks[0]?.({ type: 'fullscreen-changed', fullscreen: true });
    expect(win.sent.at(-1)).toMatchObject({
      channel: PLAYER_CHANNELS.ui,
      payload: { engineId: reply.engineId, ui: { type: 'fullscreen-changed', fullscreen: true } },
    });

    dispose();
    expect(standby.released).toBe(1);
  });

  it('releases unused standby engine after idle TTL, on owner destroy/navigate, or on dispose', async () => {
    vi.useFakeTimers();
    try {
      const ipc = fakeIpcMain();
      const engines: Array<ReturnType<typeof stubWarmUpEngine>> = [];
      let triggerWarmUp: ((owner: WebContentsLike) => void) | undefined;

      const dispose = registerPlayerIpc({
        ipcMain: ipc.ipcMain,
        now: () => 500,
        log: () => undefined,
        warmUpIdleTtlMs: 30_000,
        bindWarmUp: (fn) => {
          triggerWarmUp = fn;
        },
        createEngine: async () => {
          const eng = stubWarmUpEngine(false);
          engines.push(eng);
          return eng as unknown as MpvEngine;
        },
      });

      const win1 = fakeContents(1);
      triggerWarmUp?.(win1.wc);
      await Promise.resolve();
      await Promise.resolve();
      expect(engines[0]?.started).toBe(1);
      expect(engines[0]?.released).toBe(0);

      // Expires cleanly after idle TTL
      vi.advanceTimersByTime(30_000);
      expect(engines[0]?.released).toBe(1);

      // Re-warm and destroy window before open -> released immediately
      triggerWarmUp?.(win1.wc);
      await Promise.resolve();
      await Promise.resolve();
      expect(engines[1]?.released).toBe(0);
      win1.destroy();
      expect(engines[1]?.released).toBe(1);

      // Warm for win2 and dispose IPC -> released cleanly
      const win2 = fakeContents(2);
      triggerWarmUp?.(win2.wc);
      await Promise.resolve();
      await Promise.resolve();
      expect(engines[2]?.released).toBe(0);
      dispose();
      expect(engines[2]?.released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('immediately releases a non-canvas fallback engine during warm-up without calling warmUp or start', async () => {
    const ipc = fakeIpcMain();
    const engines: Array<ReturnType<typeof stubWarmUpEngine>> = [];
    let triggerWarmUp: ((owner: WebContentsLike) => void) | undefined;

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 500,
      log: () => undefined,
      bindWarmUp: (fn) => {
        triggerWarmUp = fn;
      },
      createEngine: async () => {
        const eng = stubWarmUpEngine(true, 'own-window');
        engines.push(eng);
        return eng as unknown as MpvEngine;
      },
    });

    const win = fakeContents(1);
    triggerWarmUp?.(win.wc);
    await Promise.resolve();
    await Promise.resolve();

    expect(engines).toHaveLength(1);
    expect(engines[0]?.released).toBe(1);
    expect(engines[0]?.warmedUp).toBe(0);
    expect(engines[0]?.started).toBe(0);
    dispose();
  });

  it('discards unclaimed standby engines on non-primary Multi-View open and on player:adopt', async () => {
    const ipc = fakeIpcMain();
    const engines: Array<ReturnType<typeof stubWarmUpEngine>> = [];
    let triggerWarmUp: ((owner: WebContentsLike) => void) | undefined;

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 500,
      log: () => undefined,
      retargetOwner: () => true,
      bindWarmUp: (fn) => {
        triggerWarmUp = fn;
      },
      createEngine: async () => {
        const eng = stubWarmUpEngine(true, 'canvas');
        engines.push(eng);
        return eng as unknown as MpvEngine;
      },
    });

    // Case 1: non-primary replaceExisting:false open discards standby instead of leaking it
    const win1 = fakeContents(1);
    triggerWarmUp?.(win1.wc);
    await Promise.resolve();
    await Promise.resolve();
    expect(engines[0]?.released).toBe(0);

    await ipc.invoke(PLAYER_CHANNELS.open, win1.wc, { replaceExisting: false, primary: false });
    expect(engines[0]?.released).toBe(1);
    expect(engines[1]?.released).toBe(0);

    // Case 2: adopting a parked popout engine into a window discards any standby on that window
    const win2 = fakeContents(2);
    const openedOnWin2 = (await ipc.invoke(PLAYER_CHANNELS.open, win2.wc)) as { engineId: string };
    expect(await ipc.invoke(PLAYER_CHANNELS.park, win2.wc, openedOnWin2.engineId)).toBe(true);

    const win3 = fakeContents(3);
    triggerWarmUp?.(win3.wc);
    await Promise.resolve();
    await Promise.resolve();
    const win3Standby = engines.at(-1);
    expect(win3Standby?.released).toBe(0);

    const adopted = await ipc.invoke(PLAYER_CHANNELS.adopt, win3.wc, openedOnWin2.engineId);
    expect(adopted).not.toBeNull();
    expect(win3Standby?.released).toBe(1);

    dispose();
  });
});

describe('window-lifecycle helpers (visibility hooks & post-paint warm-up)', () => {
  function fakeWindow(initial?: { minimized?: boolean; visible?: boolean }) {
    let destroyed = false;
    let minimized = initial?.minimized ?? false;
    let visible = initial?.visible ?? true;
    const winListeners = new Map<string, Set<() => void>>();
    const wcListeners = new Map<string, Set<() => void>>();
    const wc = {
      id: 1,
      isDestroyed: () => destroyed,
      once(ev: string, fn: () => void) {
        let s = wcListeners.get(ev);
        if (!s) {
          s = new Set();
          wcListeners.set(ev, s);
        }
        s.add(fn);
      },
      removeListener(ev: string, fn: () => void) {
        wcListeners.get(ev)?.delete(fn);
      },
    };
    const addWinListener = (ev: string, fn: () => void): void => {
      let s = winListeners.get(ev);
      if (!s) {
        s = new Set();
        winListeners.set(ev, s);
      }
      s.add(fn);
    };
    const win: VisibilityWindowLike & WarmUpWindowLike = {
      isDestroyed: () => destroyed,
      isMinimized: () => minimized,
      isVisible: () => visible,
      webContents: wc,
      on: addWinListener,
      once: addWinListener,
      removeListener(ev: string, fn: () => void) {
        winListeners.get(ev)?.delete(fn);
      },
    };
    return {
      win,
      wc,
      emitWin(ev: string) {
        for (const fn of [...(winListeners.get(ev) ?? [])]) fn();
      },
      emitWc(ev: string) {
        for (const fn of [...(wcListeners.get(ev) ?? [])]) {
          wcListeners.get(ev)?.delete(fn);
          fn();
        }
      },
      setMinimized(v: boolean) {
        minimized = v;
      },
      setVisible(v: boolean) {
        visible = v;
      },
      destroy() {
        destroyed = true;
      },
      winListenerCount: () => [...winListeners.values()].reduce((a, s) => a + s.size, 0),
    };
  }

  it('tracks minimize/hide/restore/show and unsubscribes all listeners cleanly', () => {
    const f = fakeWindow();
    const hooks = createPlayerWindowVisibilityHooks(() => f.win);
    const changes: boolean[] = [];

    expect(hooks.isWindowMinimized(f.wc)).toBe(false);
    const off = hooks.onWindowVisibilityChange(f.wc, (m) => changes.push(m));
    expect(f.winListenerCount()).toBe(4);

    f.setMinimized(true);
    f.emitWin('minimize');
    expect(hooks.isWindowMinimized(f.wc)).toBe(true);

    f.setMinimized(false);
    f.emitWin('restore');
    expect(hooks.isWindowMinimized(f.wc)).toBe(false);

    f.setVisible(false);
    f.emitWin('hide');
    expect(hooks.isWindowMinimized(f.wc)).toBe(true);

    f.setVisible(true);
    f.emitWin('show');
    expect(changes).toEqual([true, false, true, false]);

    off();
    expect(f.winListenerCount()).toBe(0);
  });

  it('createPlayerWindowHostHooks guards destroyed windows across display, aspect ratio, and retarget hooks', () => {
    const f = fakeWindow();
    const aspects: Array<number | undefined> = [];
    const hooks = createPlayerWindowHostHooks({
      getWindow: () => f.win,
      getDisplayId: () => 'disp-1',
      onAspectRatio: (_w, ratio) => aspects.push(ratio),
    });
    const retargetWindow = vi.fn(() => true);

    expect(hooks.getDisplayId(f.wc)).toBe('disp-1');
    hooks.onVideoAspectRatioChange(f.wc, 16 / 9);
    expect(aspects).toEqual([16 / 9]);
    expect(hooks.retargetOwner({ retargetWindow }, f.wc)).toBe(true);
    expect(retargetWindow).toHaveBeenCalledWith(f.win);

    f.destroy();
    expect(hooks.isWindowMinimized(f.wc)).toBe(true);
    expect(hooks.getDisplayId(f.wc)).toBeUndefined();
    hooks.onVideoAspectRatioChange(f.wc, 4 / 3);
    expect(aspects).toEqual([16 / 9]);
    expect(hooks.retargetOwner({ retargetWindow }, f.wc)).toBe(false);
  });

  it('schedules post-paint canvas warm-up after did-finish-load and skips gate or non-canvas presenters', () => {
    vi.useFakeTimers();
    try {
      const f = fakeWindow();
      const onWarmUp = vi.fn();

      // Skips gate mode
      schedulePostPaintMpvWarmUp(f.win, {
        gate: true,
        presenter: 'canvas',
        delayMs: 1_500,
        onWarmUp,
      });
      f.emitWc('did-finish-load');
      vi.advanceTimersByTime(5_000);
      expect(onWarmUp).not.toHaveBeenCalled();

      // Skips own-window presenter
      schedulePostPaintMpvWarmUp(f.win, {
        gate: false,
        presenter: 'own-window',
        delayMs: 1_500,
        onWarmUp,
      });
      f.emitWc('did-finish-load');
      vi.advanceTimersByTime(5_000);
      expect(onWarmUp).not.toHaveBeenCalled();

      // Fires once after did-finish-load + idle delay for visible canvas window
      const cancel = schedulePostPaintMpvWarmUp(f.win, {
        gate: false,
        presenter: 'canvas',
        delayMs: 1_500,
        onWarmUp,
      });
      f.emitWc('did-finish-load');
      vi.advanceTimersByTime(1_499);
      expect(onWarmUp).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWarmUp).toHaveBeenCalledTimes(1);
      expect(onWarmUp).toHaveBeenCalledWith(f.wc);
      cancel();

      // Closing before timer fires cancels cleanly
      const f2 = fakeWindow();
      const onWarmUp2 = vi.fn();
      schedulePostPaintMpvWarmUp(f2.win, {
        gate: false,
        presenter: 'canvas',
        delayMs: 1_500,
        onWarmUp: onWarmUp2,
      });
      f2.emitWc('did-finish-load');
      f2.emitWin('closed');
      vi.advanceTimersByTime(5_000);
      expect(onWarmUp2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
