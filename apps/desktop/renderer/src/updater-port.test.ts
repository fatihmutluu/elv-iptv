import { describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateState, UpdaterBridge } from '../../src/shared/updater-ipc.ts';
import { createDesktopUpdaterPort } from './updater-port.ts';

describe('createDesktopUpdaterPort', () => {
  it('delegates updater calls and state subscriptions to window.elv.updater bridge', async () => {
    let listener: ((s: DesktopUpdateState) => void) | undefined;
    const state: DesktopUpdateState = {
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.2.0',
    };
    const bridge: UpdaterBridge = {
      getState: vi.fn(async () => state),
      checkForUpdates: vi.fn(async () => state),
      downloadUpdate: vi.fn(async () => ({
        ...state,
        status: 'downloaded' as const,
        downloadPercent: 100,
      })),
      installUpdate: vi.fn(async () => undefined),
      openReleasePage: vi.fn(async () => true),
      onStateChanged: vi.fn((cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      }),
    };

    const port = createDesktopUpdaterPort(bridge);
    expect(await port.getState()).toEqual(state);
    expect(await port.checkForUpdates()).toEqual(state);
    expect(await port.downloadUpdate()).toMatchObject({ status: 'downloaded' });
    await port.installUpdate();
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    expect(await port.openReleasePage()).toBe(true);

    const received: DesktopUpdateState[] = [];
    const unsub = port.subscribe((s) => received.push(s));
    const updated: DesktopUpdateState = { status: 'up-to-date', currentVersion: '1.0.0' };
    listener?.(updated);
    expect(received).toEqual([updated]);
    unsub();
    expect(listener).toBeUndefined();
  });

  it('degrades cleanly to unsupported when bridge is absent', async () => {
    const port = createDesktopUpdaterPort(undefined);
    expect(await port.getState()).toEqual({ status: 'unsupported', currentVersion: '0.0.0' });
    expect(await port.checkForUpdates()).toEqual({
      status: 'unsupported',
      currentVersion: '0.0.0',
    });
    expect(await port.downloadUpdate()).toEqual({
      status: 'unsupported',
      currentVersion: '0.0.0',
    });
    await expect(port.installUpdate()).resolves.toBeUndefined();
    expect(await port.openReleasePage()).toBe(false);
    const unsub = port.subscribe(() => undefined);
    unsub();
  });
});
