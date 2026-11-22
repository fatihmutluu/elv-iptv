import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAppWindow, fakeVideoWindow } from '../testing/fake-windows.ts';

const electron = vi.hoisted(() => ({
  made: [] as Array<{ options: unknown; openHandler?: () => { action: string } }>,
  screenListeners: new Map<string, Set<() => void>>(),
  dipCalls: [] as unknown[],
  importedTextures: [] as Array<{ options: unknown; released: number }>,
  sentTextures: [] as Array<{ options: unknown; args: unknown[] }>,
  netServers: [] as Array<{
    listenCalls: Array<{ path: string; exclusive: boolean }>;
    closed: boolean;
    connect: (socket: unknown) => void;
  }>,
  displays: [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 2056, height: 1329 },
      workArea: { x: 0, y: 30, width: 2056, height: 1299 },
      scaleFactor: 2,
    },
  ],
  matchingId: 1,
}));

vi.mock('node:net', () => ({
  createServer: () => {
    const connListeners = new Set<(socket: unknown) => void>();
    const errListeners = new Set<(err: Error) => void>();
    const record = {
      listenCalls: [] as Array<{ path: string; exclusive: boolean }>,
      closed: false,
      connect: (socket: unknown) => {
        for (const fn of [...connListeners]) fn(socket);
      },
    };
    electron.netServers.push(record);
    const server = {
      listen(opts: { path: string; exclusive: boolean }, onListening: () => void) {
        record.listenCalls.push(opts);
        queueMicrotask(onListening);
        return server;
      },
      on(event: string, listener: (...args: never[]) => void) {
        if (event === 'connection') connListeners.add(listener as (socket: unknown) => void);
        else if (event === 'error') errListeners.add(listener as (err: Error) => void);
        return server;
      },
      once(event: string, listener: (err: Error) => void) {
        if (event === 'error') errListeners.add(listener);
        return server;
      },
      removeListener(event: string, listener: (err: Error) => void) {
        if (event === 'error') errListeners.delete(listener);
        return server;
      },
      close() {
        record.closed = true;
        return server;
      },
    };
    return server;
  },
}));

vi.mock('electron', () => {
  class BrowserWindow {
    readonly video = fakeVideoWindowForMock();
    openHandler?: () => { action: string };
    webContents = {
      setWindowOpenHandler: (h: () => { action: 'deny' }) => {
        this.openHandler = h;
      },
      on: () => undefined,
    };
    constructor(readonly options: unknown) {
      electron.made.push(this);
      Object.assign(this, this.video.window);
    }
  }
  return {
    BrowserWindow,
    sharedTexture: {
      importSharedTexture: (options: unknown) => {
        const rec = { options, released: 0 };
        electron.importedTextures.push(rec);
        return {
          release: () => {
            rec.released += 1;
          },
        };
      },
      sendSharedTexture: async (options: unknown, ...args: unknown[]) => {
        electron.sentTextures.push({ options, args });
      },
    },
    screen: {
      on: (event: string, listener: () => void) => {
        const set = electron.screenListeners.get(event) ?? new Set();
        set.add(listener);
        electron.screenListeners.set(event, set);
      },
      removeListener: (event: string, listener: () => void) => {
        electron.screenListeners.get(event)?.delete(listener);
      },
      dipToScreenRect: (
        _window: unknown,
        rect: { x: number; y: number; width: number; height: number },
      ) => {
        electron.dipCalls.push(rect);
        return { x: rect.x * 2, y: rect.y * 2, width: rect.width * 2, height: rect.height * 2 };
      },
      getDisplayMatching: () =>
        electron.displays.find((d) => d.id === electron.matchingId) ?? electron.displays[0],
      getAllDisplays: () => electron.displays,
    },
  };
});

function fakeVideoWindowForMock() {
  return fakeVideoWindow(0xabc);
}

const { createPresenter } = await import('./create.ts');

const AREA = { x: 0, y: 0, width: 640, height: 360, visible: true };
const listenerTotal = () =>
  [...electron.screenListeners.values()].reduce((n, set) => n + set.size, 0);

beforeEach(() => {
  electron.made = [];
  electron.screenListeners.clear();
  electron.dipCalls = [];
  electron.importedTextures = [];
  electron.sentTextures = [];
  electron.netServers = [];
  electron.displays = [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 2056, height: 1329 },
      workArea: { x: 0, y: 30, width: 2056, height: 1299 },
      scaleFactor: 2,
    },
  ];
  electron.matchingId = 1;
});

describe('createPresenter', () => {
  it('canvas wires Electron sharedTexture, net.createServer, screen scaleFactor, mainFrame, and engineId', async () => {
    const app = fakeAppWindow();
    const mainFrame = { frameId: 7 };
    let wcDestroyed = false;
    Object.assign(app.window.webContents, {
      isDestroyed: () => wcDestroyed,
      mainFrame,
    });
    const appWindow = app.window as unknown as BrowserWindow;
    const presenter = createPresenter('canvas', appWindow, 'win32', { engineId: 'engine-9' });
    expect(presenter.kind).toBe('canvas');
    expect(presenter.coversArea).toBe(false);

    const args = await presenter.prepare();
    expect(args).toHaveLength(2);
    expect(args[0]).toMatch(/^--elv-canvas-pipe=\\\\\.\\pipe\\elv-mpv-canvas-[0-9a-f]{16}$/);
    expect(args[1]).toBe('--input-vo-keyboard=no');
    expect(electron.netServers).toHaveLength(1);
    expect(electron.netServers[0]?.listenCalls[0]?.exclusive).toBe(true);
    expect([...electron.screenListeners.keys()].sort()).toEqual([
      'display-added',
      'display-metrics-changed',
      'display-removed',
    ]);

    const written: string[] = [];
    const dataListeners: Array<(chunk: string) => void> = [];
    const fakeSocket = {
      write: (chunk: string) => written.push(chunk),
      destroy: () => undefined,
      on: (event: string, listener: (arg: never) => void) => {
        if (event === 'data') dataListeners.push(listener as (chunk: string) => void);
        return fakeSocket;
      },
    };
    presenter.setArea(AREA);
    electron.netServers[0]?.connect(fakeSocket);
    // scaleFactor is 2 from mock display -> 640*2 x 360*2
    expect(written).toEqual(['R 1280 720\n']);

    for (const fn of dataListeners) fn('S 1 0 1234 1280 720\nF 1 0 1280 720\n');
    expect(electron.importedTextures).toHaveLength(1);
    await vi.waitFor(() => expect(electron.sentTextures).toHaveLength(1));
    expect(electron.sentTextures[0]?.options).toMatchObject({ frame: mainFrame });
    expect(electron.sentTextures[0]?.args).toEqual(['engine-9']);
    await vi.waitFor(() => expect(written).toContain('A 1 0\n'));

    // Destroyed webContents returns null mainFrame and acks without sending
    wcDestroyed = true;
    for (const fn of dataListeners) fn('F 1 0 1280 720\n');
    expect(electron.sentTextures).toHaveLength(1);

    presenter.dispose();
    expect(electron.netServers[0]?.closed).toBe(true);
    expect(listenerTotal()).toBe(0);
  });

  it('canvas on darwin uses a private Unix socket endpoint, resolves IOSurface handles, and cleans up on dispose', async () => {
    const app = fakeAppWindow();
    const mainFrame = { frameId: 11 };
    Object.assign(app.window.webContents, {
      isDestroyed: () => false,
      mainFrame,
    });
    const surfaceBuf = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2]);
    const lookup = vi.fn((id: number) => (id === 4242 ? surfaceBuf : null));
    const release = vi.fn();

    const appWindow = app.window as unknown as BrowserWindow;
    const presenter = createPresenter('canvas', appWindow, 'darwin', {
      engineId: 'engine-mac',
      ioSurfaceResolver: { lookup, release },
    });

    const args = await presenter.prepare();
    expect(args).toHaveLength(2);
    expect(args[0]?.startsWith('--elv-canvas-pipe=')).toBe(true);
    expect(args[1]).toBe('--input-vo-keyboard=no');
    const sockPath = (args[0] ?? '').slice('--elv-canvas-pipe='.length);
    const sockDir = dirname(sockPath);
    expect(sockPath).toBe(join(sockDir, 'c.sock'));
    expect(sockPath.length).toBeLessThanOrEqual(96);
    expect(existsSync(sockDir)).toBe(true);

    const written: string[] = [];
    const dataListeners: Array<(chunk: string) => void> = [];
    const fakeSocket = {
      write: (chunk: string) => written.push(chunk),
      destroy: () => undefined,
      on: (event: string, listener: (arg: never) => void) => {
        if (event === 'data') dataListeners.push(listener as (chunk: string) => void);
        return fakeSocket;
      },
    };
    presenter.setArea(AREA);
    electron.netServers[0]?.connect(fakeSocket);
    written.length = 0;

    for (const fn of dataListeners) fn('S 1 0 4242 1280 720\nF 1 0 1280 720\n');
    expect(lookup).toHaveBeenCalledWith(4242);
    expect(release).toHaveBeenCalledWith(surfaceBuf);
    expect(electron.importedTextures).toHaveLength(1);
    expect(electron.importedTextures[0]?.options).toEqual({
      textureInfo: {
        pixelFormat: 'bgra',
        codedSize: { width: 1280, height: 720 },
        handle: { ioSurface: surfaceBuf },
      },
    });
    expect(written).toContain('I 1 0\n');
    await vi.waitFor(() => expect(electron.sentTextures).toHaveLength(1));
    expect(electron.sentTextures[0]?.options).toMatchObject({ frame: mainFrame });
    expect(electron.sentTextures[0]?.args).toEqual(['engine-mac']);
    await vi.waitFor(() => expect(written).toContain('A 1 0\n'));

    presenter.dispose();
    expect(electron.netServers[0]?.closed).toBe(true);
    expect(existsSync(sockDir)).toBe(false);
    expect(listenerTotal()).toBe(0);
  });

  it('canvas on darwin fails fast when neither ioSurfaceResolver nor ioSurfaceAddon is provided', () => {
    const app = fakeAppWindow();
    const appWindow = app.window as unknown as BrowserWindow;
    expect(() =>
      createPresenter('canvas', appWindow, 'darwin', { engineId: 'engine-mac' }),
    ).toThrow(/ioSurfaceAddon|ioSurfaceResolver|IOSurface/i);
  });

  it('child-window makes one video window owned by the app window and follows displays', async () => {
    const app = fakeAppWindow();
    const appWindow = app.window as unknown as BrowserWindow;
    const presenter = createPresenter('child-window', appWindow, 'win32');
    expect(await presenter.prepare()).toEqual([
      '--wid=2748',
      '--auto-window-resize=no',
      '--input-vo-keyboard=no',
    ]);
    expect(electron.made).toHaveLength(1);
    expect(electron.made[0]?.options).toMatchObject({
      parent: appWindow,
      frame: false,
      show: false,
    });
    expect([...electron.screenListeners.keys()].sort()).toEqual([
      'display-added',
      'display-metrics-changed',
      'display-removed',
    ]);
    presenter.dispose();
    expect(listenerTotal()).toBe(0);
  });

  it('own-window converts DIPs with dipToScreenRect on Windows and display workArea backing pixels on macOS', async () => {
    const app = fakeAppWindow({ x: 10, y: 50, width: 1280, height: 720 });
    const appWindow = app.window as unknown as BrowserWindow;
    const windows = createPresenter('own-window', appWindow, 'win32');
    windows.setArea(AREA);
    expect(await windows.prepare()).toEqual([
      '--geometry=1280x720+20+100',
      '--input-vo-keyboard=yes',
    ]);
    const mac = createPresenter('own-window', appWindow, 'darwin');
    mac.setArea(AREA);
    expect(await mac.prepare()).toEqual(['--geometry=1280x720+20+40', '--input-vo-keyboard=yes']);
    expect(electron.dipCalls).toHaveLength(1);

    electron.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 2056, height: 1329 },
        workArea: { x: 0, y: 30, width: 2056, height: 1299 },
        scaleFactor: 2,
      },
      {
        id: 2,
        bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
        workArea: { x: -1920, y: 25, width: 1920, height: 1055 },
        scaleFactor: 1,
      },
    ];
    electron.matchingId = 2;
    const multiApp = fakeAppWindow({ x: -1820, y: 125, width: 1280, height: 720 });
    const macMulti = createPresenter(
      'own-window',
      multiApp.window as unknown as BrowserWindow,
      'darwin',
    );
    macMulti.setArea(AREA);
    expect(await macMulti.prepare()).toEqual([
      '--geometry=640x360+100+100',
      '--screen=1',
      '--input-vo-keyboard=yes',
    ]);

    // Notched macOS fullscreen: safe-area default keeps workArea, desktop spans full bounds (#269)
    electron.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
        workArea: { x: 0, y: 37, width: 1512, height: 945 },
        scaleFactor: 2,
      },
    ];
    electron.matchingId = 1;
    const notchedApp = fakeAppWindow({ x: 0, y: 0, width: 1512, height: 982 });
    notchedApp.state.fullscreen = true;
    const macSafe = createPresenter(
      'own-window',
      notchedApp.window as unknown as BrowserWindow,
      'darwin',
    );
    macSafe.setArea({ x: 0, y: 0, width: 1512, height: 982, visible: true });
    expect(await macSafe.prepare()).toEqual([
      '--geometry=3024x1890+0+0',
      '--input-vo-keyboard=yes',
    ]);
    macSafe.dispose();

    const macDesktop = createPresenter(
      'own-window',
      notchedApp.window as unknown as BrowserWindow,
      'darwin',
      { fullscreenMode: 'desktop' },
    );
    macDesktop.setArea({ x: 0, y: 0, width: 1512, height: 982, visible: true });
    expect(await macDesktop.prepare()).toEqual([
      '--geometry=3024x1964+0+-74',
      '--input-vo-keyboard=yes',
    ]);
    macDesktop.dispose();
  });
});
