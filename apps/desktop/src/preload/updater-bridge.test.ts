import { describe, expect, it, vi } from 'vitest';
import { type DesktopUpdateState, UPDATER_CHANNELS } from '../shared/updater-ipc.ts';
import { createUpdaterBridge } from './updater-bridge.ts';

describe('createUpdaterBridge', () => {
  it('returns a frozen bridge, validates state replies, strips IpcRendererEvent, and unsubscribes strictly its own callback', async () => {
    const state: DesktopUpdateState = {
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
    };
    const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
    const invoke = vi.fn(async (channel: string) => {
      if (
        channel === UPDATER_CHANNELS.getState ||
        channel === UPDATER_CHANNELS.check ||
        channel === UPDATER_CHANNELS.download
      ) {
        return state;
      }
      if (channel === UPDATER_CHANNELS.install) return undefined;
      if (channel === UPDATER_CHANNELS.openReleasePage) return true;
      return null;
    });
    const ipc = {
      invoke,
      on: vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        const set = listeners.get(ch) ?? new Set();
        set.add(fn);
        listeners.set(ch, set);
      }),
      removeListener: vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        listeners.get(ch)?.delete(fn);
      }),
    };

    const bridge = createUpdaterBridge(ipc);
    expect(Object.isFrozen(bridge)).toBe(true);

    expect(await bridge.getState()).toEqual(state);
    expect(await bridge.checkForUpdates()).toEqual(state);
    expect(await bridge.downloadUpdate()).toEqual(state);
    await expect(bridge.installUpdate()).resolves.toBeUndefined();
    expect(await bridge.openReleasePage()).toBe(true);

    const seenA: DesktopUpdateState[] = [];
    const seenB: DesktopUpdateState[] = [];
    const unsubA = bridge.onStateChanged((s) => seenA.push(s));
    const unsubB = bridge.onStateChanged((s) => seenB.push(s));

    const fakeEvent = { sender: { secret: true } };
    const next: DesktopUpdateState = {
      status: 'downloaded',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      downloadPercent: 100,
    };
    for (const fn of [...(listeners.get(UPDATER_CHANNELS.stateChanged) ?? [])]) {
      fn(fakeEvent, next);
      fn(fakeEvent, { status: 'invalid-state' });
    }
    expect(seenA).toEqual([next]);
    expect(seenB).toEqual([next]);

    // Unsubscribing A leaves B intact
    unsubA();
    const afterUnsub: DesktopUpdateState = { status: 'up-to-date', currentVersion: '1.0.0' };
    for (const fn of [...(listeners.get(UPDATER_CHANNELS.stateChanged) ?? [])]) {
      fn(fakeEvent, afterUnsub);
    }
    expect(seenA).toEqual([next]);
    expect(seenB).toEqual([next, afterUnsub]);
    unsubB();
    expect(listeners.get(UPDATER_CHANNELS.stateChanged)?.size).toBe(0);
  });

  it('rejects malformed replies and propagates IPC rejections intact', async () => {
    const bridgeMalformed = createUpdaterBridge({
      invoke: vi.fn(async () => ({ bad: true })),
      on: vi.fn(),
      removeListener: vi.fn(),
    });
    await expect(bridgeMalformed.getState()).rejects.toThrow(/unexpected/i);
    await expect(bridgeMalformed.checkForUpdates()).rejects.toThrow(/unexpected/i);
    await expect(bridgeMalformed.downloadUpdate()).rejects.toThrow(/unexpected/i);
    await expect(bridgeMalformed.openReleasePage()).rejects.toThrow(/unexpected/i);

    const ipcErr = new Error('untrusted sender for updater:check');
    const bridgeRejected = createUpdaterBridge({
      invoke: vi.fn(async () => {
        throw ipcErr;
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    });
    await expect(bridgeRejected.checkForUpdates()).rejects.toBe(ipcErr);
    await expect(bridgeRejected.installUpdate()).rejects.toBe(ipcErr);
  });
});
