import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAppWindow, fakeVideoWindow } from '../testing/fake-windows.ts';

const electron = vi.hoisted(() => ({
  made: [] as Array<{ options: unknown; openHandler?: () => { action: string } }>,
  screenListeners: new Map<string, Set<() => void>>(),
  dipCalls: [] as unknown[],
  displays: [{ id: 1, workArea: { x: 0, y: 30, width: 2056, height: 1299 }, scaleFactor: 2 }],
  matchingId: 1,
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
  electron.displays = [
    { id: 1, workArea: { x: 0, y: 30, width: 2056, height: 1299 }, scaleFactor: 2 },
  ];
  electron.matchingId = 1;
});

describe('createPresenter', () => {
  it('child-window makes one video window owned by the app window and follows displays', async () => {
    const app = fakeAppWindow();
    const appWindow = app.window as unknown as BrowserWindow;
    const presenter = createPresenter('child-window', appWindow, 'win32');
    expect(await presenter.prepare()).toEqual(['--wid=2748', '--auto-window-resize=no']);
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
    expect(await windows.prepare()).toEqual(['--geometry=1280x720+20+100']);
    const mac = createPresenter('own-window', appWindow, 'darwin');
    mac.setArea(AREA);
    expect(await mac.prepare()).toEqual(['--geometry=1280x720+20+40']);
    expect(electron.dipCalls).toHaveLength(1);

    electron.displays = [
      { id: 1, workArea: { x: 0, y: 30, width: 2056, height: 1299 }, scaleFactor: 2 },
      { id: 2, workArea: { x: -1920, y: 25, width: 1920, height: 1055 }, scaleFactor: 1 },
    ];
    electron.matchingId = 2;
    const multiApp = fakeAppWindow({ x: -1820, y: 125, width: 1280, height: 720 });
    const macMulti = createPresenter(
      'own-window',
      multiApp.window as unknown as BrowserWindow,
      'darwin',
    );
    macMulti.setArea(AREA);
    expect(await macMulti.prepare()).toEqual(['--geometry=640x360+100+100', '--screen=1']);
  });
});
