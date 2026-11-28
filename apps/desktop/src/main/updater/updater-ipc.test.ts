import { describe, expect, it, vi } from 'vitest';
import { type DesktopUpdateState, UPDATER_CHANNELS } from '../../shared/updater-ipc.ts';
import type { DesktopUpdaterService } from './desktop-updater.ts';
import { registerUpdaterIpc } from './updater-ipc.ts';

function trustedEvent() {
  const frame: { url: string; top?: unknown } = { url: 'app://elv/' };
  frame.top = frame;
  return { senderFrame: frame, sender: {} };
}

function untrustedEvent() {
  const frame: { url: string; top?: unknown } = { url: 'https://evil.invalid/' };
  frame.top = frame;
  return { senderFrame: frame, sender: {} };
}

describe('registerUpdaterIpc', () => {
  it('enforces trusted sender frame, handles all updater channels, broadcasts state changes, and validates openExternal URL', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn((ch: string) => {
        handlers.delete(ch);
      }),
    };

    let listener: ((s: DesktopUpdateState) => void) | undefined;
    let state: DesktopUpdateState = {
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      manualDownloadUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.1.0',
    };
    let manualUrl: string | null = 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.1.0';

    const service: DesktopUpdaterService = {
      support: 'direct',
      getState: vi.fn(() => state),
      checkForUpdates: vi.fn(async () => state),
      downloadUpdate: vi.fn(async () => ({
        ...state,
        status: 'downloaded' as const,
        downloadPercent: 100,
      })),
      installUpdate: vi.fn(async () => undefined),
      getManualDownloadUrl: vi.fn(() => manualUrl),
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      }),
    };

    const trustedTarget = {
      isDestroyed: () => false,
      getURL: () => 'app://elv/',
      send: vi.fn(),
    };
    const untrustedTarget = {
      isDestroyed: () => false,
      getURL: () => 'https://untrusted.invalid/',
      send: vi.fn(),
    };
    const openExternal = vi.fn(async () => undefined);

    const dispose = registerUpdaterIpc({
      ipcMain,
      service,
      openExternal,
      getBroadcastTargets: () => [trustedTarget, untrustedTarget],
    });

    // Reject untrusted senders on every handler
    for (const ch of [
      UPDATER_CHANNELS.getState,
      UPDATER_CHANNELS.check,
      UPDATER_CHANNELS.download,
      UPDATER_CHANNELS.install,
      UPDATER_CHANNELS.openReleasePage,
    ]) {
      await expect(handlers.get(ch)?.(untrustedEvent())).rejects.toThrow(/untrusted sender/i);
    }

    expect(await handlers.get(UPDATER_CHANNELS.getState)?.(trustedEvent())).toEqual(state);
    expect(await handlers.get(UPDATER_CHANNELS.check)?.(trustedEvent())).toEqual(state);
    expect(await handlers.get(UPDATER_CHANNELS.download)?.(trustedEvent())).toMatchObject({
      status: 'downloaded',
    });
    await handlers.get(UPDATER_CHANNELS.install)?.(trustedEvent());
    expect(service.installUpdate).toHaveBeenCalledTimes(1);

    // Valid release URL opens externally
    expect(await handlers.get(UPDATER_CHANNELS.openReleasePage)?.(trustedEvent())).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.1.0',
    );

    // Disallowed URL never opens externally
    openExternal.mockClear();
    manualUrl = 'https://evil.invalid/download';
    state = { status: 'available', currentVersion: '1.0.0', availableVersion: '1.1.0' };
    expect(await handlers.get(UPDATER_CHANNELS.openReleasePage)?.(trustedEvent())).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();

    // State changes broadcast ONLY to trusted windows
    const nextState: DesktopUpdateState = {
      status: 'up-to-date',
      currentVersion: '1.0.0',
    };
    listener?.(nextState);
    expect(trustedTarget.send).toHaveBeenCalledWith(UPDATER_CHANNELS.stateChanged, nextState);
    expect(untrustedTarget.send).not.toHaveBeenCalled();

    // Clean disposal
    dispose();
    expect(handlers.size).toBe(0);
    expect(listener).toBeUndefined();
  });
});
