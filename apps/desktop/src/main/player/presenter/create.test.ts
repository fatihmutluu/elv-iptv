import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAppWindow, fakeVideoWindow } from '../testing/fake-windows.ts';

const electron = vi.hoisted(() => ({
  made: [] as Array<{ options: unknown }>,
  screenListeners: new Map<string, Set<() => void>>(),
  dipCalls: [] as unknown[],
}));

vi.mock('electron', () => {
  class BrowserWindow {
    readonly video = fakeVideoWindowForMock();
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
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 30, width: 2056, height: 1299 },
        scaleFactor: 2,
      }),
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
});

describe('createPresenter', () => {
  it('child-window makes one video window owned by the app window and follows displays', async () => {
    const app = fakeAppWindow();
    const appWindow = app.window as unknown as BrowserWindow;
    const presenter = createPresenter('child-window', appWindow, 'win32');
    expect(await presenter.prepare()).toEqual(['--wid=2748']);
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
  });
});
