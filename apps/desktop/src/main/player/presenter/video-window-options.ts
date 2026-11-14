import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/**
 * Options of the frameless, sandboxed video window mpv draws into with `--wid`; it never loads a page.
 * Transparent because Chromium's DirectComposition output lies above child windows: an opaque background hides
 * mpv's child completely (measured in the go/no-go), a transparent one lets it show.
 */
export function buildVideoWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
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
}

/** Creates the video window with `Window` (Electron's `BrowserWindow` in the app) and loads nothing into it. */
export function createVideoWindow<W>(
  parent: BrowserWindow,
  Window: new (options: BrowserWindowConstructorOptions) => W,
): W {
  return new Window(buildVideoWindowOptions(parent));
}

/** The window's HWND as the unsigned 32-bit number mpv's `--wid` takes. */
export function nativeHwnd(window: { getNativeWindowHandle(): Buffer }): number {
  return window.getNativeWindowHandle().readUInt32LE(0);
}
