import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { buildVideoWindowOptions, createVideoWindow, nativeHwnd } from './video-window-options.ts';

const parent = { id: 7 } as unknown as BrowserWindow;

class FakeWindow {
  static made: FakeWindow[] = [];
  loads = 0;
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
  it('match the exact values and load no page', () => {
    const expected = {
      parent,
      frame: false,
      show: false,
      skipTaskbar: true,
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
  });
});

describe('nativeHwnd', () => {
  it('reads the handle as an unsigned 32-bit little-endian number', () => {
    const handle = Buffer.alloc(8);
    handle.writeUInt32LE(0xf0000001, 0);
    expect(nativeHwnd({ getNativeWindowHandle: () => handle })).toBe(4026531841);
  });
});
