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
  });
});
