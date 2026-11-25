import { describe, expect, it, vi } from 'vitest';
import { isAlwaysOnTopFlag, WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import {
  type AlwaysOnTopWindowLike,
  type ChildZOrderWindowLike,
  registerWindowIpc,
  type WindowIpcMainLike,
} from './window-ipc.ts';

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain: WindowIpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
  };
  return {
    ipcMain,
    handlers,
    invoke: (channel: string, sender: unknown, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({ sender }, ...args)),
  };
}

function fakeChild(visible = true) {
  let destroyed = false;
  const calls: unknown[][] = [];
  const child: ChildZOrderWindowLike = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    setAlwaysOnTop: (flag, level, relativeLevel) => {
      calls.push(['setAlwaysOnTop', flag, level, relativeLevel]);
    },
    moveTop: () => {
      calls.push(['moveTop']);
    },
  };
  return {
    child,
    calls,
    destroy: () => {
      destroyed = true;
    },
  };
}

function fakeWindow(children: ChildZOrderWindowLike[] = []) {
  let pinned = false;
  let destroyed = false;
  const setCalls: unknown[][] = [];
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sender = { id: 1 };
  const win: AlwaysOnTopWindowLike = {
    isDestroyed: () => destroyed,
    isAlwaysOnTop: () => pinned,
    setAlwaysOnTop: (flag, level) => {
      pinned = flag;
      setCalls.push([flag, level]);
    },
    getChildWindows: () => children,
    on: (event, listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener as (...args: unknown[]) => void);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
    },
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel, ...args) => {
        sent.push({ channel, args });
      },
    },
  };
  return {
    win,
    sender,
    setCalls,
    sent,
    emitAlwaysOnTopChanged: (nextPinned: boolean) => {
      pinned = nextPinned;
      for (const listener of [...(listeners.get('always-on-top-changed') ?? [])]) {
        listener({}, nextPinned);
      }
    },
    listenerCount: () => listeners.get('always-on-top-changed')?.size ?? 0,
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('window-ipc (#408)', () => {
  it('exposes exact frozen WINDOW_CHANNELS and boolean guard', () => {
    expect(Object.isFrozen(WINDOW_CHANNELS)).toBe(true);
    expect(WINDOW_CHANNELS).toEqual({
      setAlwaysOnTop: 'window:set-always-on-top',
      getAlwaysOnTop: 'window:get-always-on-top',
      alwaysOnTopChanged: 'window:always-on-top-changed',
      setAspectRatioLock: 'window:set-aspect-ratio-lock',
      setMinimizeToTray: 'window:set-minimize-to-tray',
      windowRestored: 'window:restored',
      hiddenToTray: 'window:hidden-to-tray',
      openPopout: 'window:open-popout',
      closePopout: 'window:close-popout',
      getPopoutPayload: 'window:get-popout-payload',
      popoutPayload: 'window:popout-payload',
      dockPopout: 'window:dock-popout',
      popoutDocked: 'window:popout-docked',
    });
    expect(isAlwaysOnTopFlag(true)).toBe(true);
    expect(isAlwaysOnTopFlag(false)).toBe(true);
    expect(isAlwaysOnTopFlag('true')).toBe(false);
    expect(isAlwaysOnTopFlag(1)).toBe(false);
    expect(isAlwaysOnTopFlag(null)).toBe(false);
  });

  it('toggles always-on-top with floating level, syncs child presenter z-order, and emits changed event', async () => {
    const ipc = fakeIpcMain();
    const child = fakeChild(true);
    const hiddenChild = fakeChild(false);
    const fw = fakeWindow([child.child, hiddenChild.child]);
    const logs: string[] = [];

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      log: (line) => logs.push(line),
    });

    expect(await ipc.invoke(WINDOW_CHANNELS.getAlwaysOnTop, fw.sender)).toBe(false);

    expect(await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, fw.sender, true)).toBe(true);
    expect(fw.setCalls).toEqual([[true, 'floating']]);
    expect(child.calls).toEqual([['setAlwaysOnTop', true, 'floating', 1], ['moveTop']]);
    expect(hiddenChild.calls).toEqual([['setAlwaysOnTop', true, 'floating', 1]]);
    expect(fw.sent).toEqual([{ channel: WINDOW_CHANNELS.alwaysOnTopChanged, args: [true] }]);
    expect(await ipc.invoke(WINDOW_CHANNELS.getAlwaysOnTop, fw.sender)).toBe(true);

    // Repeating same value does not spam duplicate changed events.
    expect(await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, fw.sender, true)).toBe(true);
    expect(fw.sent).toHaveLength(1);

    // Unpinning resets both main and child HWNDs cleanly.
    expect(await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, fw.sender, false)).toBe(false);
    expect(fw.setCalls).toEqual([
      [true, 'floating'],
      [false, 'floating'],
    ]);
    expect(child.calls.at(-1)).toEqual(['setAlwaysOnTop', false, 'normal', undefined]);
    expect(fw.sent).toEqual([
      { channel: WINDOW_CHANNELS.alwaysOnTopChanged, args: [true] },
      { channel: WINDOW_CHANNELS.alwaysOnTopChanged, args: [false] },
    ]);

    expect(logs).toEqual([]);
    dispose();
    expect(ipc.handlers.size).toBe(0);
  });

  it('drops invalid payloads and handles missing or destroyed windows cleanly', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const log = vi.fn();

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      log,
    });

    expect(await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, fw.sender, 'yes')).toBe(false);
    expect(fw.setCalls).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);

    expect(await ipc.invoke(WINDOW_CHANNELS.getAlwaysOnTop, { id: 999 })).toBe(false);
    expect(await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, { id: 999 }, true)).toBe(false);

    fw.destroy();
    expect(await ipc.invoke(WINDOW_CHANNELS.getAlwaysOnTop, fw.sender)).toBe(false);
    expect(await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, fw.sender, true)).toBe(false);

    dispose();
  });

  it('syncs external always-on-top-changed events (e.g. fullscreen exit restore) without duplicate pushes', async () => {
    const ipc = fakeIpcMain();
    const child = fakeChild(true);
    const fw = fakeWindow([child.child]);

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
    });

    // Initial getAlwaysOnTop attaches the window listener cleanly
    expect(await ipc.invoke(WINDOW_CHANNELS.getAlwaysOnTop, fw.sender)).toBe(false);
    expect(fw.listenerCount()).toBe(1);

    // Pin via IPC
    expect(await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, fw.sender, true)).toBe(true);
    expect(fw.sent).toEqual([{ channel: WINDOW_CHANNELS.alwaysOnTopChanged, args: [true] }]);

    // Electron/Windows emits always-on-top-changed(false) on fullscreen entry, then (true) on exit restore
    fw.emitAlwaysOnTopChanged(false);
    fw.emitAlwaysOnTopChanged(false);
    fw.emitAlwaysOnTopChanged(true);

    expect(fw.sent).toEqual([
      { channel: WINDOW_CHANNELS.alwaysOnTopChanged, args: [true] },
      { channel: WINDOW_CHANNELS.alwaysOnTopChanged, args: [false] },
      { channel: WINDOW_CHANNELS.alwaysOnTopChanged, args: [true] },
    ]);
    expect(child.calls.at(-2)).toEqual(['setAlwaysOnTop', true, 'floating', 1]);
    expect(child.calls.at(-1)).toEqual(['moveTop']);

    dispose();
    expect(fw.listenerCount()).toBe(0);
  });

  it('validates and forwards window:set-aspect-ratio-lock to onSetAspectRatioLock (#332)', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const logs: string[] = [];
    const lockChanges: boolean[] = [];

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      onSetAspectRatioLock: (_win, enabled) => lockChanges.push(enabled),
      log: (line) => logs.push(line),
    });

    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, true)).toBe(true);
    expect(lockChanges).toEqual([true]);

    // Invalid payload is dropped and returns current lock state
    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, 'invalid')).toBe(true);
    expect(logs).toHaveLength(1);
    expect(lockChanges).toEqual([true]);

    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, false)).toBe(false);
    expect(lockChanges).toEqual([true, false]);

    fw.destroy();
    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, true)).toBe(false);

    dispose();
  });

  it('validates and forwards tray and popout IPC channels while dropping malformed payloads (#158)', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const logs: string[] = [];
    let trayEnabled = false;
    const openedPayloads: unknown[] = [];
    const dockedPayloads: unknown[] = [];
    const onClosePopout = vi.fn();

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      getMinimizeToTray: () => trayEnabled,
      onSetMinimizeToTray: (enabled) => {
        trayEnabled = enabled;
        return enabled;
      },
      onOpenPopout: (payload) => {
        openedPayloads.push(payload);
        return true;
      },
      onClosePopout,
      onGetPopoutPayload: (sender) =>
        sender === fw.sender ? { itemKey: 'live:s1:ch1', kind: 'live', title: 'News HD' } : null,
      onDockPopout: (_sender, payload) => {
        dockedPayloads.push(payload);
      },
      log: (line) => logs.push(line),
    });

    // Minimize-to-tray valid & invalid
    expect(await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, true)).toBe(true);
    expect(trayEnabled).toBe(true);
    expect(await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, 'yes')).toBe(true);

    // Popout launch strips credential query params from logo, accepts valid transferEngineId, and rejects raw URL itemKeys or invalid engineIds
    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'News HD',
        logo: 'https://user:secret@cdn.example.test/logo.png?token=abc&size=2x',
        resumePositionMs: 1200,
        pinned: true,
        transferEngineId: 'engine-4',
      }),
    ).toBe(true);
    expect(openedPayloads).toEqual([
      {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'News HD',
        logo: 'https://cdn.example.test/logo.png?size=2x',
        resumePositionMs: 1200,
        pinned: true,
        transferEngineId: 'engine-4',
      },
    ]);

    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'Bad transferEngineId',
        transferEngineId: 'x'.repeat(65),
      }),
    ).toBe(false);

    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'http://secret.panel/live/u/p/1.ts',
        kind: 'live',
        title: 'Raw URL forbidden',
      }),
    ).toBe(false);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'Extra key forbidden',
        url: 'http://leak.example/stream.ts',
      }),
    ).toBe(false);

    // Pull payload & dock & close
    expect(await ipc.invoke(WINDOW_CHANNELS.getPopoutPayload, fw.sender)).toEqual({
      itemKey: 'live:s1:ch1',
      kind: 'live',
      title: 'News HD',
    });
    await ipc.invoke(WINDOW_CHANNELS.dockPopout, fw.sender, {
      itemKey: 'movie:s1:m1',
      kind: 'movie',
      title: 'Cinema Film',
      positionMs: 42_500.4,
      transferEngineId: 'engine-4',
    });
    expect(dockedPayloads).toEqual([
      {
        itemKey: 'movie:s1:m1',
        kind: 'movie',
        title: 'Cinema Film',
        positionMs: 42_500,
        transferEngineId: 'engine-4',
      },
    ]);
    await ipc.invoke(WINDOW_CHANNELS.dockPopout, fw.sender, {
      itemKey: 'movie:s1:m1',
      kind: 'movie',
      title: 'Bad transferEngineId',
      transferEngineId: '',
    });
    await ipc.invoke(WINDOW_CHANNELS.dockPopout, fw.sender, {
      itemKey: 'movie:s1:m1',
      kind: 'movie',
      title: 'Negative pos',
      positionMs: -10,
    });
    expect(dockedPayloads).toHaveLength(1);

    await ipc.invoke(WINDOW_CHANNELS.closePopout, fw.sender);
    expect(onClosePopout).toHaveBeenCalledTimes(1);
    expect(logs.length).toBeGreaterThanOrEqual(4);

    dispose();
  });

  it('validates and sanitizes localized tray labels on window:set-minimize-to-tray (LOW #11)', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const logs: string[] = [];
    const received: Array<{ enabled: boolean; labels?: { restore: string; quit: string } }> = [];
    let trayEnabled = false;

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      getMinimizeToTray: () => trayEnabled,
      onSetMinimizeToTray: (enabled, labels) => {
        trayEnabled = enabled;
        received.push(labels ? { enabled, labels } : { enabled });
        return enabled;
      },
      log: (line) => logs.push(line),
    });

    // Valid localized labels are trimmed and forwarded
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, true, {
        restore: '  ELV IPTV Geri Yükle  ',
        quit: ' Çıkış ',
      }),
    ).toBe(true);
    expect(received).toEqual([
      { enabled: true, labels: { restore: 'ELV IPTV Geri Yükle', quit: 'Çıkış' } },
    ]);

    // Malformed labels (extra keys, control chars, empty, oversized) are dropped cleanly
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: 'Restore',
        quit: 'Quit',
        extra: 'nope',
      }),
    ).toBe(true);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: 'Line\nBreak',
        quit: 'Quit',
      }),
    ).toBe(true);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: '   ',
        quit: 'Quit',
      }),
    ).toBe(true);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: 'a'.repeat(200),
        quit: 'Quit',
      }),
    ).toBe(true);

    expect(received).toHaveLength(1);
    expect(logs).toHaveLength(4);

    dispose();
  });
});
