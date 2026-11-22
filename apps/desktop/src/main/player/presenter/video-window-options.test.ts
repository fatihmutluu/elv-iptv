import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { buildVideoWindowOptions, createVideoWindow, nativeHwnd } from './video-window-options.ts';

const parent = { id: 7 } as unknown as BrowserWindow;

class FakeWindow {
  static made: FakeWindow[] = [];
  loads = 0;
  openHandler?: () => { action: string };
  navListeners = new Map<string, (details: { url: string; preventDefault(): void }) => void>();
  webContents = {
    setWindowOpenHandler: (h: () => { action: 'deny' }) => {
      this.openHandler = h;
    },
    on: (event: string, listener: (details: { url: string; preventDefault(): void }) => void) => {
      this.navListeners.set(event, listener);
    },
  };
  constructor(readonly options: BrowserWindowConstructorOptions) {
    FakeWindow.made.push(this);
  }
  loadURL(): void {
    this.loads += 1;
  }
  loadFile(): void {
    this.loads += 1;
  }
}

describe('buildVideoWindowOptions', () => {
  it('match the exact values, disallow independent close, and block all navigation', () => {
    FakeWindow.made = [];
    const expected = {
      parent,
      frame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      closable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
      },
    };
    expect(buildVideoWindowOptions(parent)).toStrictEqual(expected);

    const window = createVideoWindow(parent, FakeWindow);
    expect(FakeWindow.made).toEqual([window]);
    expect(window.options).toStrictEqual(expected);
    expect(window.loads).toBe(0);
    expect(window.openHandler?.()).toEqual({ action: 'deny' });
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      let prevented = false;
      window.navListeners.get(event)?.({
        url: 'app://elv/',
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
    }
  });
});

describe('nativeHwnd', () => {
  it('reads the handle as an unsigned 32-bit little-endian number and rejects 0 or short buffers', () => {
    const handle = Buffer.alloc(8);
    handle.writeUInt32LE(0xf0000001, 0);
    expect(nativeHwnd({ getNativeWindowHandle: () => handle })).toBe(4026531841);
    expect(() => nativeHwnd({ getNativeWindowHandle: () => Buffer.alloc(8) })).toThrow(/0/);
    expect(() => nativeHwnd({ getNativeWindowHandle: () => Buffer.alloc(2) })).toThrow(/buffer/);
  });
});
