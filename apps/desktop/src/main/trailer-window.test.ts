import type { BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTrailerWindowOptions,
  createTrailerWindowController,
  type TrailerBrowserWindowLike,
} from './trailer-window.ts';

function makeFakeWindow() {
  let destroyed = false;
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  let willNavigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
  let closedHandler: (() => void) | undefined;

  const win: TrailerBrowserWindowLike = {
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async () => undefined),
    focus: vi.fn(),
    show: vi.fn(),
    on: vi.fn((event, listener) => {
      if (event === 'closed') closedHandler = listener;
    }),
    webContents: {
      setWindowOpenHandler: vi.fn((handler) => {
        openHandler = handler;
      }),
      on: vi.fn((event, listener) => {
        if (event === 'will-navigate') willNavigateHandler = listener;
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
  };
}

describe('trailer-window (#512)', () => {
  it('enforces sandboxed, isolated, non-node window options with no preload', () => {
    const opts = buildTrailerWindowOptions();
    expect(opts.webPreferences?.contextIsolation).toBe(true);
    expect(opts.webPreferences?.nodeIntegration).toBe(false);
    expect(opts.webPreferences?.sandbox).toBe(true);
    expect(opts.webPreferences?.preload).toBeUndefined();
    expect(opts.webPreferences?.partition).toBe('trailer');
  });

  it('rejects non-YouTube URLs without creating a window', async () => {
    const createWindow = vi.fn();
    const controller = createTrailerWindowController({ createWindow });
    expect(await controller.open('https://example.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(await controller.open('file:///C:/Windows/win.ini')).toBe(false);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('opens an allowlisted YouTube URL, denies popups, blocks non-YouTube navigations, and reuses the window', async () => {
    const fake = makeFakeWindow();
    const createdOpts: BrowserWindowConstructorOptions[] = [];
    const createWindow = vi.fn((opts: BrowserWindowConstructorOptions) => {
      createdOpts.push(opts);
      return fake.win;
    });
    const controller = createTrailerWindowController({ createWindow });

    const ok1 = await controller.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(ok1).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createdOpts[0]?.webPreferences?.sandbox).toBe(true);
    expect(fake.win.loadURL).toHaveBeenCalledWith('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(fake.win.focus).toHaveBeenCalledTimes(1);

    expect(fake.getOpenHandler()?.({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).toEqual(
      { action: 'deny' },
    );

    const preventBlocked = vi.fn();
    fake.getWillNavigateHandler()?.({ preventDefault: preventBlocked }, 'https://evil.example/x');
    expect(preventBlocked).toHaveBeenCalledTimes(1);

    const preventAllowed = vi.fn();
    fake.getWillNavigateHandler()?.(
      { preventDefault: preventAllowed },
      'https://youtu.be/dQw4w9WgXcQ',
    );
    expect(preventAllowed).not.toHaveBeenCalled();

    const ok2 = await controller.open('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(ok2).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(1);

    fake.destroy();
    const fake2 = makeFakeWindow();
    createWindow.mockReturnValueOnce(fake2.win);
    expect(await controller.open('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(2);
  });
});
