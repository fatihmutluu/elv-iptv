/** The part of Electron's `app` the single-instance lock uses. */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

/** The part of a `BrowserWindow` that `focusWindow` uses. */
export interface FocusableWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/**
 * Takes the single-instance lock. Without it the app quits at once and the caller must create nothing (no sweep of
 * the running instance's mpv, no window); with it, a later launch calls `onSecond` in this instance.
 */
export function startSingleInstance(app: SingleInstanceApp, opts: { onSecond(): void }): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', opts.onSecond);
  return true;
}

/** Brings the window back from the task bar and to the front. */
export function focusWindow(window: FocusableWindow | undefined): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}
