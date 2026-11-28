import { describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import {
  createWindowBridge,
  syncInitialZoomLevel,
  type WindowIpcRendererLike,
  type WindowWebFrameLike,
} from './window-bridge.ts';

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

describe('createWindowBridge (#332, #158)', () => {
  it('exposes a frozen bridge forwarding aspect-ratio lock', async () => {
    const fake = fakeIpcRenderer();
    const bridge = createWindowBridge(fake.ipc);
    expect(Object.isFrozen(bridge)).toBe(true);

    fake.invoke.mockResolvedValueOnce(true);
    expect(await bridge.setAspectRatioLock(true)).toBe(true);
    expect(fake.invoke).toHaveBeenCalledWith(WINDOW_CHANNELS.setAspectRatioLock, true);
  });

  it('rejects non-boolean IPC replies cleanly', async () => {
    const fake = fakeIpcRenderer();
    const bridge = createWindowBridge(fake.ipc);

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

  it('forwards zoom level get/set/changed and syncs initial + live zoom to webFrame (Wave Q7)', async () => {
    const fake = fakeIpcRenderer();
    const appliedZooms: number[] = [];
    const webFrame: WindowWebFrameLike = {
      setZoomLevel: (level) => {
        appliedZooms.push(level);
      },
    };
    const bridge = createWindowBridge(fake.ipc, webFrame);

    fake.invoke.mockResolvedValueOnce(1.5);
    expect(await bridge.getZoomLevel?.()).toBe(1.5);
    expect(fake.invoke).toHaveBeenLastCalledWith(WINDOW_CHANNELS.getZoomLevel);

    fake.invoke.mockResolvedValueOnce(2);
    expect(await bridge.setZoomLevel?.(1.9)).toBe(2);
    expect(fake.invoke).toHaveBeenLastCalledWith(WINDOW_CHANNELS.setZoomLevel, 2);
    expect(appliedZooms).toEqual([2]);

    fake.invoke.mockResolvedValueOnce('bad');
    await expect(bridge.getZoomLevel?.()).rejects.toThrow('unexpected reply');

    fake.invoke.mockResolvedValueOnce(99);
    await expect(bridge.setZoomLevel?.(1)).rejects.toThrow('unexpected reply');

    const seen: number[] = [];
    const off = bridge.onZoomLevelChanged?.((level) => seen.push(level));
    fake.emit(WINDOW_CHANNELS.zoomLevelChanged, -1.5);
    fake.emit(WINDOW_CHANNELS.zoomLevelChanged, 'bogus');
    fake.emit(WINDOW_CHANNELS.zoomLevelChanged, 10);
    expect(seen).toEqual([-1.5]);
    expect(appliedZooms).toEqual([2, -1.5]);
    off?.();
    expect(fake.listenerCount(WINDOW_CHANNELS.zoomLevelChanged)).toBe(0);

    // syncInitialZoomLevel applies persisted zoom on init, DOMContentLoaded, and live events
    const domListeners = new Map<string, Set<() => void>>();
    const fakeDoc = {
      readyState: 'loading',
      addEventListener: (type: string, fn: () => void) => {
        const set = domListeners.get(type) ?? new Set();
        set.add(fn);
        domListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        domListeners.get(type)?.delete(fn);
      },
    };
    appliedZooms.length = 0;
    fake.invoke.mockResolvedValueOnce(1);
    fake.invoke.mockResolvedValueOnce(1);
    const stopSync = syncInitialZoomLevel(fake.ipc, webFrame, fakeDoc);
    await Promise.resolve();
    await Promise.resolve();
    expect(appliedZooms).toEqual([1]);

    for (const fn of domListeners.get('DOMContentLoaded') ?? []) fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(appliedZooms).toEqual([1, 1]);

    fake.emit(WINDOW_CHANNELS.zoomLevelChanged, 2.5);
    expect(appliedZooms).toEqual([1, 1, 2.5]);

    stopSync();
    expect(fake.listenerCount(WINDOW_CHANNELS.zoomLevelChanged)).toBe(0);
    expect(domListeners.get('DOMContentLoaded')?.size ?? 0).toBe(0);
  });
});
