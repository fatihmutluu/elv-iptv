import type { BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReleaseWindowOptions,
  createReleasePageWindowController,
  type ReleaseBrowserWindowLike,
} from './release-window.ts';

function makeFakeReleaseWindow() {
  let destroyed = false;
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  let willNavigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
  let willRedirectHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
  let closedHandler: (() => void) | undefined;

  const win: ReleaseBrowserWindowLike = {
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async () => undefined),
    focus: vi.fn(),
    show: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
      closedHandler?.();
    }),
    on: vi.fn((event, listener) => {
      if (event === 'closed') closedHandler = listener;
    }),
    webContents: {
      setWindowOpenHandler: vi.fn((handler) => {
        openHandler = handler;
      }),
      on: vi.fn((event, listener) => {
        if (event === 'will-navigate') willNavigateHandler = listener;
        if (event === 'will-redirect') willRedirectHandler = listener;
      }),
    },
  };

  return {
    win,
    destroy: () => {
      destroyed = true;
      closedHandler?.();
    },
    getOpenHandler: () => openHandler,
    getWillNavigateHandler: () => willNavigateHandler,
    getWillRedirectHandler: () => willRedirectHandler,
  };
}

describe('release-window (F-13 sandboxed in-app releases viewer)', () => {
  it('enforces sandboxed, isolated, non-node window options with updater-releases partition and no preload', () => {
    const opts = buildReleaseWindowOptions();
    expect(opts.webPreferences?.contextIsolation).toBe(true);
    expect(opts.webPreferences?.nodeIntegration).toBe(false);
    expect(opts.webPreferences?.sandbox).toBe(true);
    expect(opts.webPreferences?.preload).toBeUndefined();
    expect(opts.webPreferences?.partition).toBe('updater-releases');
  });

  it('rejects non-allowlisted URLs without creating a window', async () => {
    const createWindow = vi.fn();
    const controller = createReleasePageWindowController({ createWindow });

    expect(await controller.open('https://example.invalid/releases')).toBe(false);
    expect(await controller.open('http://github.com/fatihmutluu/elv-iptv/releases/latest')).toBe(
      false,
    );
    expect(await controller.open('https://github.com/other/repo/releases/tag/v1.0.0')).toBe(false);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('opens an allowlisted release URL, denies popups, blocks untrusted navigations/redirects, reuses window, and closes cleanly', async () => {
    const fake = makeFakeReleaseWindow();
    const createdOpts: BrowserWindowConstructorOptions[] = [];
    const createWindow = vi.fn((opts: BrowserWindowConstructorOptions) => {
      createdOpts.push(opts);
      return fake.win;
    });
    const controller = createReleasePageWindowController({ createWindow });

    const releaseUrl = 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0';
    expect(await controller.open(releaseUrl)).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createdOpts[0]?.webPreferences?.sandbox).toBe(true);
    expect(createdOpts[0]?.webPreferences?.partition).toBe('updater-releases');
    expect(fake.win.loadURL).toHaveBeenCalledWith(releaseUrl);
    expect(fake.win.focus).toHaveBeenCalledTimes(1);

    // Popups denied
    expect(fake.getOpenHandler()?.({ url: releaseUrl })).toEqual({ action: 'deny' });

    // Non-release navigations and redirects blocked
    const preventNavBlocked = vi.fn();
    fake.getWillNavigateHandler()?.(
      { preventDefault: preventNavBlocked },
      'https://evil.invalid/phish',
    );
    expect(preventNavBlocked).toHaveBeenCalledTimes(1);

    const preventRedirectBlocked = vi.fn();
    fake.getWillRedirectHandler()?.(
      { preventDefault: preventRedirectBlocked },
      'https://github.com/login',
    );
    expect(preventRedirectBlocked).toHaveBeenCalledTimes(1);

    // Allowlisted release navigation permitted
    const preventAllowed = vi.fn();
    fake.getWillNavigateHandler()?.(
      { preventDefault: preventAllowed },
      'https://github.com/fatihmutluu/elv-iptv/releases/latest',
    );
    expect(preventAllowed).not.toHaveBeenCalled();

    // Window reused while open
    expect(await controller.open('https://github.com/fatihmutluu/elv-iptv/releases/latest')).toBe(
      true,
    );
    expect(createWindow).toHaveBeenCalledTimes(1);

    // close() tears down the window and subsequent open recreates it
    controller.close();
    expect(fake.win.close).toHaveBeenCalledTimes(1);

    const fake2 = makeFakeReleaseWindow();
    createWindow.mockReturnValueOnce(fake2.win);
    expect(await controller.open(releaseUrl)).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(2);
  });
});
