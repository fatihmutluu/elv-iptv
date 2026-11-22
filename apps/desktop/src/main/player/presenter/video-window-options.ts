import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/** Minimal webContents surface used to lock down the page-less child video window. */
export interface VideoWebContentsTarget {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(
    event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate',
    listener: (details: { preventDefault(): void }) => void,
  ): unknown;
}

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
}

/** Blocks new windows and every navigation on the page-less video window (including OS file/URL drag-and-drop). */
function lockDownVideoWebContents(contents: VideoWebContentsTarget): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (details: { preventDefault(): void }): void => {
    details.preventDefault();
  };
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-frame-navigate', block);
}

/** Creates the video window with `Window` (Electron's `BrowserWindow` in the app), locks down its webContents, and loads nothing into it. */
export function createVideoWindow<W extends { readonly webContents: VideoWebContentsTarget }>(
  parent: BrowserWindow,
  Window: new (options: BrowserWindowConstructorOptions) => W,
): W {
  const window = new Window(buildVideoWindowOptions(parent));
  lockDownVideoWebContents(window.webContents);
  return window;
}

/** The window's HWND as the unsigned 32-bit number mpv's `--wid` takes; throws if missing or zero. */
export function nativeHwnd(window: { getNativeWindowHandle(): Buffer }): number {
  const buf = window.getNativeWindowHandle();
  if (buf.length < 4) throw new Error('invalid native window handle buffer');
  const handle = buf.readUInt32LE(0);
  if (handle === 0) throw new Error('native window handle is 0');
  return handle;
}
