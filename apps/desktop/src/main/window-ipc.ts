import { isAlwaysOnTopFlag, WINDOW_CHANNELS } from '../shared/window-ipc.ts';

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

/** Minimal `ipcMain` surface used by {@link registerWindowIpc}. */
export interface WindowIpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

/** Minimal child window surface used to keep child presenter HWNDs above an always-on-top parent (`#408`). */
export interface ChildZOrderWindowLike {
  isDestroyed(): boolean;
  isVisible?(): boolean;
  setAlwaysOnTop?(flag: boolean, level?: 'normal' | 'floating', relativeLevel?: number): void;
  moveTop?(): void;
}

/** Minimal `BrowserWindow` surface used by {@link registerWindowIpc}. */
export interface AlwaysOnTopWindowLike {
  isDestroyed(): boolean;
  isAlwaysOnTop(): boolean;
  setAlwaysOnTop(flag: boolean, level?: 'normal' | 'floating'): void;
  getChildWindows?(): readonly ChildZOrderWindowLike[];
  on?(
    event: 'always-on-top-changed',
    listener: (event: unknown, isAlwaysOnTop: boolean) => void,
  ): unknown;
  removeListener?(
    event: 'always-on-top-changed',
    listener: (event: unknown, isAlwaysOnTop: boolean) => void,
  ): unknown;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

/** Collaborators injected into {@link registerWindowIpc}. */
export interface WindowIpcDeps {
  ipcMain: WindowIpcMainLike;
  getWindowFromSender(sender: unknown): AlwaysOnTopWindowLike | null | undefined;
  log?(line: string): void;
}

function syncChildWindowZOrder(win: AlwaysOnTopWindowLike, enabled: boolean): void {
  const children = win.getChildWindows?.();
  if (!children) return;
  for (const child of children) {
    if (child.isDestroyed()) continue;
    if (enabled) {
      child.setAlwaysOnTop?.(true, 'floating', 1);
      if (child.isVisible?.()) child.moveTop?.();
    } else {
      child.setAlwaysOnTop?.(false, 'normal');
    }
  }
}

/**
 * Registers typed `window:set-always-on-top` and `window:get-always-on-top` handlers on `ipcMain`,
 * keeping child presenter HWND z-order consistent and pushing deduplicated `window:always-on-top-changed`
 * events back to the owning renderer (`#408`). Returns the disposer.
 */
export function registerWindowIpc(deps: WindowIpcDeps): () => void {
  const { ipcMain, getWindowFromSender, log } = deps;
  const lastNotified = new WeakMap<AlwaysOnTopWindowLike, boolean>();
  const watched = new WeakSet<AlwaysOnTopWindowLike>();
  const detachListeners: Array<() => void> = [];

  const notifyIfChanged = (win: AlwaysOnTopWindowLike, enabled: boolean): void => {
    if (lastNotified.get(win) === enabled) return;
    lastNotified.set(win, enabled);
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(WINDOW_CHANNELS.alwaysOnTopChanged, enabled);
    }
  };

  const watchWindow = (win: AlwaysOnTopWindowLike): void => {
    if (watched.has(win) || typeof win.on !== 'function') return;
    watched.add(win);
    const onAlwaysOnTopChanged = (_event: unknown, isAlwaysOnTop: boolean): void => {
      if (win.isDestroyed()) return;
      const actual = typeof isAlwaysOnTop === 'boolean' ? isAlwaysOnTop : win.isAlwaysOnTop();
      syncChildWindowZOrder(win, actual);
      notifyIfChanged(win, actual);
    };
    win.on('always-on-top-changed', onAlwaysOnTopChanged);
    detachListeners.push(() => {
      if (!win.isDestroyed()) {
        win.removeListener?.('always-on-top-changed', onAlwaysOnTopChanged);
      }
    });
  };

  ipcMain.handle(WINDOW_CHANNELS.getAlwaysOnTop, ({ sender }) => {
    const win = getWindowFromSender(sender);
    if (!win || win.isDestroyed()) return false;
    watchWindow(win);
    return win.isAlwaysOnTop();
  });

  ipcMain.handle(WINDOW_CHANNELS.setAlwaysOnTop, ({ sender }, enabled) => {
    const win = getWindowFromSender(sender);
    if (!isAlwaysOnTopFlag(enabled)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.setAlwaysOnTop} payload`);
      return win && !win.isDestroyed() ? win.isAlwaysOnTop() : false;
    }
    if (!win || win.isDestroyed()) return false;
    watchWindow(win);
    if (win.isAlwaysOnTop() !== enabled) {
      win.setAlwaysOnTop(enabled, 'floating');
    }
    const actual = win.isAlwaysOnTop();
    syncChildWindowZOrder(win, actual);
    notifyIfChanged(win, actual);
    return actual;
  });

  return () => {
    ipcMain.removeHandler(WINDOW_CHANNELS.getAlwaysOnTop);
    ipcMain.removeHandler(WINDOW_CHANNELS.setAlwaysOnTop);
    for (const detach of detachListeners.splice(0)) detach();
  };
}
