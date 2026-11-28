/** Minimal Electron event shape carrying `preventDefault`. */
export interface AppCommandEventLike {
  preventDefault?: () => void;
}

/** Minimal `will-navigate` event shape for in-place/same-document history traversal checks. */
export interface WillNavigateEventLike {
  readonly isInPlace?: boolean;
  readonly isSameDocument?: boolean;
  preventDefault(): void;
}

/** Minimal Electron `WebContents` surface required by {@link attachBrowserBackGuard}. */
interface BrowserBackWebContentsLike {
  isDestroyed(): boolean;
  sendInputEvent(event: { type: 'keyDown' | 'keyUp'; keyCode: string }): void;
  readonly navigationHistory?: { clear(): void };
  clearHistory?(): void;
  on(event: 'will-navigate', listener: (details: WillNavigateEventLike) => void): unknown;
  on(event: 'did-finish-load', listener: () => void): unknown;
  on(event: 'did-navigate-in-page', listener: () => void): unknown;
}

/** Minimal Electron `BrowserWindow` surface required by {@link attachBrowserBackGuard}. */
export interface BrowserBackGuardWindow {
  isDestroyed(): boolean;
  on(event: 'app-command', listener: (event: AppCommandEventLike, cmd: string) => void): unknown;
  on(event: 'swipe', listener: (event: AppCommandEventLike, direction: string) => void): unknown;
  readonly webContents: BrowserBackWebContentsLike;
}

function clearHistory(contents: BrowserBackWebContentsLike): void {
  if (typeof contents.navigationHistory?.clear === 'function') {
    contents.navigationHistory.clear();
  } else {
    contents.clearHistory?.();
  }
}

function dispatchEscapeKey(contents: BrowserBackWebContentsLike): void {
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
}

/**
 * Intercepts Electron `app-command` `'browser-backward'` / `'browser-forward'`, macOS trackpad
 * `swipe` left, and in-place history navigation, keeping Chromium's navigation history cleared
 * and routing Back into the renderer as an `Escape` key press (or optional `onBack` callback) (#139).
 */
export function attachBrowserBackGuard(win: BrowserBackGuardWindow, onBack?: () => void): void {
  const triggerBack = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    clearHistory(win.webContents);
    if (onBack !== undefined) onBack();
    else dispatchEscapeKey(win.webContents);
  };

  win.on('app-command', (event, cmd) => {
    if (cmd === 'browser-backward') {
      event.preventDefault?.();
      triggerBack();
    } else if (cmd === 'browser-forward') {
      event.preventDefault?.();
    }
  });

  try {
    win.on('swipe', (event, direction) => {
      if (direction === 'left') {
        event?.preventDefault?.();
        triggerBack();
      }
    });
  } catch {
    // Ignore hosts/fakes without macOS trackpad swipe event support.
  }

  win.webContents.on('will-navigate', (details) => {
    if (details.isInPlace === true || details.isSameDocument === true) {
      details.preventDefault();
      triggerBack();
    }
  });

  const keepHistoryEmpty = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    clearHistory(win.webContents);
  };
  win.webContents.on('did-finish-load', keepHistoryEmpty);
  win.webContents.on('did-navigate-in-page', keepHistoryEmpty);
}
