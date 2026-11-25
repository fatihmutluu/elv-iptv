import { describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import { createWindowBridge, type WindowIpcRendererLike } from './window-bridge.ts';

function fakeIpcRenderer() {
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
  const invoke = vi.fn<WindowIpcRendererLike['invoke']>();
  const ipc: WindowIpcRendererLike = {
    invoke,
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
  return {
    ipc,
    invoke,
    emit: (channel: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, ...args);
    },
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
  };
}

describe('createWindowBridge (#408)', () => {
  it('exposes a frozen bridge forwarding set/get always-on-top and change notifications', async () => {
    const fake = fakeIpcRenderer();
    const bridge = createWindowBridge(fake.ipc);
    expect(Object.isFrozen(bridge)).toBe(true);

    fake.invoke.mockResolvedValueOnce(true);
    expect(await bridge.setAlwaysOnTop(true)).toBe(true);
    expect(fake.invoke).toHaveBeenCalledWith(WINDOW_CHANNELS.setAlwaysOnTop, true);

    fake.invoke.mockResolvedValueOnce(false);
    expect(await bridge.getAlwaysOnTop()).toBe(false);
    expect(fake.invoke).toHaveBeenCalledWith(WINDOW_CHANNELS.getAlwaysOnTop);

    fake.invoke.mockResolvedValueOnce(true);
    expect(await bridge.setAspectRatioLock(true)).toBe(true);
    expect(fake.invoke).toHaveBeenCalledWith(WINDOW_CHANNELS.setAspectRatioLock, true);

    const received: boolean[] = [];
    const off = bridge.onAlwaysOnTopChanged((enabled) => received.push(enabled));
    expect(fake.listenerCount(WINDOW_CHANNELS.alwaysOnTopChanged)).toBe(1);

    fake.emit(WINDOW_CHANNELS.alwaysOnTopChanged, true);
    fake.emit(WINDOW_CHANNELS.alwaysOnTopChanged, 'bogus');
    fake.emit(WINDOW_CHANNELS.alwaysOnTopChanged, false);
    expect(received).toEqual([true, false]);

    off();
    expect(fake.listenerCount(WINDOW_CHANNELS.alwaysOnTopChanged)).toBe(0);
    fake.emit(WINDOW_CHANNELS.alwaysOnTopChanged, true);
    expect(received).toEqual([true, false]);
  });

  it('rejects non-boolean IPC replies cleanly', async () => {
    const fake = fakeIpcRenderer();
    const bridge = createWindowBridge(fake.ipc);

    fake.invoke.mockResolvedValueOnce('invalid');
    await expect(bridge.getAlwaysOnTop()).rejects.toThrow('unexpected reply');

    fake.invoke.mockResolvedValueOnce(123);
    await expect(bridge.setAlwaysOnTop(true)).rejects.toThrow('unexpected reply');

    fake.invoke.mockResolvedValueOnce('nope');
    await expect(bridge.setAspectRatioLock(false)).rejects.toThrow('unexpected reply');

    fake.invoke.mockResolvedValueOnce('nope');
    await expect(bridge.setMinimizeToTray(true)).rejects.toThrow('unexpected reply');

    fake.invoke.mockResolvedValueOnce('nope');
    await expect(
      bridge.openPopout({ itemKey: 'live:1', kind: 'live', title: 'Ch' }),
    ).rejects.toThrow('unexpected reply');

    fake.invoke.mockResolvedValueOnce({ bad: true });
    await expect(bridge.getPopoutPayload()).rejects.toThrow('unexpected reply');
  });

  it('forwards minimize-to-tray, popout launch/dock/close, and tray restore/hidden events (#158)', async () => {
    const fake = fakeIpcRenderer();
    const bridge = createWindowBridge(fake.ipc);

    fake.invoke.mockResolvedValueOnce(true);
    expect(await bridge.setMinimizeToTray(true)).toBe(true);
    expect(fake.invoke).toHaveBeenLastCalledWith(WINDOW_CHANNELS.setMinimizeToTray, true);

    fake.invoke.mockResolvedValueOnce(true);
    expect(
      await bridge.setMinimizeToTray(true, { restore: 'Restore ELV IPTV', quit: 'Quit' }),
    ).toBe(true);
    expect(fake.invoke).toHaveBeenLastCalledWith(WINDOW_CHANNELS.setMinimizeToTray, true, {
      restore: 'Restore ELV IPTV',
      quit: 'Quit',
    });

    const launch = { itemKey: 'live:s1:1', kind: 'live' as const, title: 'News' };
    fake.invoke.mockResolvedValueOnce(true);
    expect(await bridge.openPopout(launch)).toBe(true);
    expect(fake.invoke).toHaveBeenLastCalledWith(WINDOW_CHANNELS.openPopout, launch);

    fake.invoke.mockResolvedValueOnce(launch);
    expect(await bridge.getPopoutPayload()).toEqual(launch);

    fake.invoke.mockResolvedValueOnce(null);
    expect(await bridge.getPopoutPayload()).toBeNull();

    await bridge.dockPopout({ itemKey: 'live:s1:1', kind: 'live', title: 'News', positionMs: 500 });
    expect(fake.invoke).toHaveBeenLastCalledWith(WINDOW_CHANNELS.dockPopout, {
      itemKey: 'live:s1:1',
      kind: 'live',
      title: 'News',
      positionMs: 500,
    });

    await bridge.closePopout();
    expect(fake.invoke).toHaveBeenLastCalledWith(WINDOW_CHANNELS.closePopout);

    const seenPopout: unknown[] = [];
    const seenDocked: unknown[] = [];
    let restoredCount = 0;
    let hiddenCount = 0;
    const offPopout = bridge.onPopoutPayload((p) => seenPopout.push(p));
    const offDocked = bridge.onPopoutDocked((p) => seenDocked.push(p));
    const offRestored = bridge.onWindowRestored(() => {
      restoredCount += 1;
    });
    const offHidden = bridge.onHiddenToTray(() => {
      hiddenCount += 1;
    });

    fake.emit(WINDOW_CHANNELS.popoutPayload, launch);
    fake.emit(WINDOW_CHANNELS.popoutPayload, { bad: 1 });
    fake.emit(WINDOW_CHANNELS.popoutDocked, { itemKey: 'live:s1:1', kind: 'live', title: 'News' });
    fake.emit(WINDOW_CHANNELS.popoutDocked, { bad: 1 });
    fake.emit(WINDOW_CHANNELS.windowRestored);
    fake.emit(WINDOW_CHANNELS.hiddenToTray);

    expect(seenPopout).toEqual([launch]);
    expect(seenDocked).toEqual([{ itemKey: 'live:s1:1', kind: 'live', title: 'News' }]);
    expect(restoredCount).toBe(1);
    expect(hiddenCount).toBe(1);

    offPopout();
    offDocked();
    offRestored();
    offHidden();
    expect(fake.listenerCount(WINDOW_CHANNELS.popoutPayload)).toBe(0);
    expect(fake.listenerCount(WINDOW_CHANNELS.popoutDocked)).toBe(0);
    expect(fake.listenerCount(WINDOW_CHANNELS.windowRestored)).toBe(0);
    expect(fake.listenerCount(WINDOW_CHANNELS.hiddenToTray)).toBe(0);
  });
});
