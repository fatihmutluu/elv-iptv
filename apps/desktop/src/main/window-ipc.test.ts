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
  const sender = { id: 1 };
  const win: AlwaysOnTopWindowLike = {
    isDestroyed: () => destroyed,
    isAlwaysOnTop: () => pinned,
    setAlwaysOnTop: (flag, level) => {
      pinned = flag;
      setCalls.push([flag, level]);
    },
    getChildWindows: () => children,
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
});
