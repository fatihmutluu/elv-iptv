import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import {
  buildPopoutWindowOptions,
  createPopoutWindowController,
  POPOUT_BOUNDS_DEFAULTS,
  type PopoutBrowserWindowLike,
} from './popout-window.ts';
import type { TrayRestorableWindow } from './tray.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-popout-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakePopoutWindow() {
  let destroyed = false;
  let pinned = true;
  let bounds = { x: 100, y: 100, width: 640, height: 360 };
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const loadedUrls: string[] = [];
  const calls: string[] = [];
  const winListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const wcListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let windowOpenHandler: (() => { action: 'deny' }) | undefined;

  const webContents = {
    isDestroyed: () => destroyed,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args });
    },
    sendInputEvent: () => undefined,
    setWindowOpenHandler: (handler: () => { action: 'deny' }) => {
      windowOpenHandler = handler;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const set = wcListeners.get(event) ?? new Set();
      set.add(listener);
      wcListeners.set(event, set);
    },
  } as unknown as PopoutBrowserWindowLike['webContents'];

  const win = {
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ ...bounds }),
    setMenuBarVisibility: (visible: boolean) => {
      calls.push(`menuBar:${visible}`);
    },
    setTitle: (title: string) => {
      calls.push(`title:${title}`);
    },
    setAlwaysOnTop: (flag: boolean, level?: 'normal' | 'floating') => {
      pinned = flag;
      calls.push(`aot:${flag}:${level ?? ''}`);
    },
    isAlwaysOnTop: () => pinned,
    show: () => {
      calls.push('show');
    },
    restore: () => {
      calls.push('restore');
    },
    focus: () => {
      calls.push('focus');
    },
    close: () => {
      calls.push('close');
      for (const l of [...(winListeners.get('close') ?? [])]) l();
      destroyed = true;
      for (const l of [...(winListeners.get('closed') ?? [])]) l();
    },
    loadURL: async (url: string) => {
      loadedUrls.push(url);
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const set = winListeners.get(event) ?? new Set();
      set.add(listener);
      winListeners.set(event, set);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      winListeners.get(event)?.delete(listener);
    },
    webContents,
  } as unknown as PopoutBrowserWindowLike;

  return {
    win,
    sent,
    loadedUrls,
    calls,
    getWindowOpenHandler: () => windowOpenHandler,
    wcListeners,
    resizeTo: (next: typeof bounds) => {
      bounds = next;
      for (const l of [...(winListeners.get('resize') ?? [])]) l();
    },
  };
}

function fakeMainWindow() {
  const calls: string[] = [];
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const win: TrayRestorableWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => false,
    show: () => calls.push('show'),
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus'),
    webContents: {
      isDestroyed: () => false,
      send: (channel, ...args) => sent.push({ channel, args }),
    },
  };
  return { win, calls, sent };
}

describe('popout-window (#158)', () => {
  it('builds hardened frameless popout window options with 640x360 default and 320x180 minimums', () => {
    const opts = buildPopoutWindowOptions('/app/preload.js', { presenter: 'canvas' });
    expect(opts.width).toBe(POPOUT_BOUNDS_DEFAULTS.width);
    expect(opts.height).toBe(POPOUT_BOUNDS_DEFAULTS.height);
    expect(opts.minWidth).toBe(320);
    expect(opts.minHeight).toBe(180);
    expect(opts.frame).toBe(false);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.webPreferences).toMatchObject({
      preload: '/app/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: ['--elv-presenter=canvas'],
    });
  });

  it('creates hardened popout window, persists separate bounds, updates existing popout, and docks back cleanly', () => {
    const dir = makeTempDir();
    const popoutStatePath = join(dir, 'popout-window-state.json');
    const createdOpts: BrowserWindowConstructorOptions[] = [];
    const createdWins: Array<ReturnType<typeof fakePopoutWindow>> = [];
    const mainWin = fakeMainWindow();

    const screen = {
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    };

    const controller = createPopoutWindowController({
      preloadPath: '/app/preload.js',
      appBaseUrl: 'app://elv/',
      popoutStatePath,
      screen,
      presenter: 'canvas',
      getMainWindow: () => mainWin.win,
      createWindow: (opts) => {
        createdOpts.push(opts);
        const fw = fakePopoutWindow();
        createdWins.push(fw);
        return fw.win;
      },
    });

    const payload1 = {
      itemKey: 'live:src1:101',
      kind: 'live' as const,
      title: 'Channel One',
      subtitle: 'News',
      logo: 'https://user:pass@cdn.example.test/ch1.png?token=secret',
    };
    expect(controller.open(payload1)).toBe(true);
    expect(controller.isOpen()).toBe(true);
    expect(createdWins).toHaveLength(1);
    const pop = createdWins[0];
    if (!pop) throw new Error('expected popout window');

    // Security lockdown verified
    expect(pop.getWindowOpenHandler()?.()).toEqual({ action: 'deny' });
    expect(pop.wcListeners.has('will-navigate')).toBe(true);
    expect(pop.wcListeners.has('render-process-gone')).toBe(true);
    expect(pop.loadedUrls).toEqual(['app://elv/?popout=1']);
    expect(pop.calls).toContain('aot:true:floating');
    expect(pop.calls).toContain('menuBar:false');

    // Pull payload returns sanitized payload ONLY to popout webContents
    expect(controller.getPayloadForSender(pop.win.webContents)).toEqual({
      itemKey: 'live:src1:101',
      kind: 'live',
      title: 'Channel One',
      subtitle: 'News',
      logo: 'https://cdn.example.test/ch1.png',
    });
    expect(controller.getPayloadForSender({ other: true })).toBeNull();

    // Updating an already-open popout reuses the window and pushes popout-payload
    const payload2 = {
      itemKey: 'movie:src1:42',
      kind: 'movie' as const,
      title: 'Cinema Feature',
      resumePositionMs: 12_345,
      pinned: false,
    };
    expect(controller.open(payload2)).toBe(true);
    expect(createdWins).toHaveLength(1);
    expect(pop.sent).toContainEqual({
      channel: WINDOW_CHANNELS.popoutPayload,
      args: [payload2],
    });
    expect(pop.calls).toContain('aot:false:floating');

    // Resizing popout persists bounds to dedicated popout-window-state.json on close
    pop.resizeTo({ x: 300, y: 200, width: 800, height: 450 });

    // Docking from wrong sender is ignored
    controller.dock({ wrong: true }, { itemKey: 'movie:src1:42', kind: 'movie', title: 'X' });
    expect(mainWin.sent).toEqual([]);

    // Docking from popout restores mainWindow, sends PopoutDockPayload, and closes popout
    controller.dock(pop.win.webContents, {
      itemKey: 'movie:src1:42',
      kind: 'movie',
      title: 'Cinema Feature',
      positionMs: 99_000,
    });
    expect(controller.isOpen()).toBe(false);
    expect(mainWin.calls).toEqual(['restore', 'show', 'focus']);
    expect(mainWin.sent).toEqual([
      { channel: WINDOW_CHANNELS.windowRestored, args: [] },
      {
        channel: WINDOW_CHANNELS.popoutDocked,
        args: [
          {
            itemKey: 'movie:src1:42',
            kind: 'movie',
            title: 'Cinema Feature',
            positionMs: 99_000,
          },
        ],
      },
    ]);

    // Dedicated popout bounds file written cleanly
    const persisted = JSON.parse(readFileSync(popoutStatePath, 'utf8'));
    expect(persisted).toEqual({
      x: 300,
      y: 200,
      width: 800,
      height: 450,
      isMaximized: false,
    });

    // dispose is safe after close
    controller.dispose();
  });

  it('closePopout closes an open popout cleanly without docking to main', () => {
    const dir = makeTempDir();
    const mainWin = fakeMainWindow();
    const onLog = vi.fn();
    const controller = createPopoutWindowController({
      preloadPath: '/app/preload.js',
      appBaseUrl: 'app://elv/',
      popoutStatePath: join(dir, 'popout-window-state.json'),
      screen: {
        getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      },
      getMainWindow: () => mainWin.win,
      createWindow: () => fakePopoutWindow().win,
      log: onLog,
    });

    controller.open({ itemKey: 'live:s1:1', kind: 'live', title: 'Ch 1' });
    expect(controller.isOpen()).toBe(true);
    controller.close();
    expect(controller.isOpen()).toBe(false);
    expect(mainWin.sent).toEqual([]);
  });
});
