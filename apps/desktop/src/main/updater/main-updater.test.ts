import type { BrowserWindowConstructorOptions, IpcMain, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { UPDATER_CHANNELS } from '../../shared/updater-ipc.ts';
import { startDesktopUpdater } from './main-updater.ts';
import type { ReleaseBrowserWindowLike } from './release-window.ts';

function trustedEvent() {
  const frame: { url: string; top?: unknown } = { url: 'app://elv/' };
  frame.top = frame;
  return { senderFrame: frame, sender: {} };
}

describe('startDesktopUpdater (sandboxed release-window wiring)', () => {
  it('registers updater IPC with a sandboxed release window and cleans up on dispose', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn((ch: string) => {
        handlers.delete(ch);
      }),
    } as unknown as IpcMain;

    const fakeWindow: ReleaseBrowserWindowLike = {
      isDestroyed: () => false,
      loadURL: vi.fn(async () => undefined),
      focus: vi.fn(),
      show: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
      },
    };
    const createWindow = vi.fn((_opts: BrowserWindowConstructorOptions) => fakeWindow);

    const dispose = startDesktopUpdater({
      ipcMain,
      currentVersion: '1.0.0',
      platform: 'win32',
      isPackaged: true,
      devOrigin: null,
      createWindow,
      getBroadcastTargets: () => [] as WebContents[],
      beforeShutdown: async () => undefined,
      shutdownCatalog: async () => undefined,
      quitAndInstall: vi.fn(),
    });

    const state = await handlers.get(UPDATER_CHANNELS.getState)?.(trustedEvent());
    expect(state).toEqual({ status: 'idle', currentVersion: '1.0.0' });
    expect(await handlers.get(UPDATER_CHANNELS.openReleasePage)?.(trustedEvent())).toBe(false);
    expect(createWindow).not.toHaveBeenCalled();

    dispose();
    expect(handlers.size).toBe(0);
  });
});
