import {
  isAlwaysOnTopFlag,
  isAspectRatioLockFlag,
  isMinimizeToTrayFlag,
  isPopoutDockPayload,
  isPopoutLaunchPayload,
  isTrayLabels,
  type PopoutDockPayload,
  type PopoutLaunchPayload,
  sanitizePopoutDockPayload,
  sanitizePopoutLaunchPayload,
  sanitizeTrayLabels,
  type TrayLabels,
  WINDOW_CHANNELS,
} from '../shared/window-ipc.ts';

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
  onSetAspectRatioLock?(win: AlwaysOnTopWindowLike, enabled: boolean): void;
  onSetMinimizeToTray?(enabled: boolean, labels?: TrayLabels): boolean;
  getMinimizeToTray?(): boolean;
  onOpenPopout?(payload: PopoutLaunchPayload): Promise<boolean> | boolean;
  onClosePopout?(): Promise<void> | void;
  onGetPopoutPayload?(sender: unknown): PopoutLaunchPayload | null;
  onDockPopout?(sender: unknown, payload: PopoutDockPayload): Promise<void> | void;
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
 * Registers typed window control, minimize-to-tray (`#158`), and popout window (`#158`) IPC
 * handlers on `ipcMain`. Every payload is strictly validated; invalid payloads are dropped and
 * logged by channel name only. Returns the disposer.
 */
export function registerWindowIpc(deps: WindowIpcDeps): () => void {
  const { ipcMain, getWindowFromSender, onSetAspectRatioLock, log } = deps;
  const lastNotified = new WeakMap<AlwaysOnTopWindowLike, boolean>();
  const aspectRatioLocked = new WeakMap<AlwaysOnTopWindowLike, boolean>();
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

  ipcMain.handle(WINDOW_CHANNELS.setAspectRatioLock, ({ sender }, enabled) => {
    const win = getWindowFromSender(sender);
    if (!isAspectRatioLockFlag(enabled)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.setAspectRatioLock} payload`);
      return win && !win.isDestroyed() ? (aspectRatioLocked.get(win) ?? false) : false;
    }
    if (!win || win.isDestroyed()) return false;
    aspectRatioLocked.set(win, enabled);
    onSetAspectRatioLock?.(win, enabled);
    return enabled;
  });

  ipcMain.handle(WINDOW_CHANNELS.setMinimizeToTray, (_event, enabled, rawLabels) => {
    if (!isMinimizeToTrayFlag(enabled)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.setMinimizeToTray} payload`);
      return deps.getMinimizeToTray?.() ?? false;
    }
    let labels: TrayLabels | undefined;
    if (rawLabels !== undefined) {
      if (!isTrayLabels(rawLabels)) {
        log?.(`window ipc: dropped invalid ${WINDOW_CHANNELS.setMinimizeToTray} tray labels`);
        return deps.getMinimizeToTray?.() ?? false;
      }
      labels = sanitizeTrayLabels(rawLabels);
    }
    return deps.onSetMinimizeToTray ? deps.onSetMinimizeToTray(enabled, labels) : enabled;
  });

  ipcMain.handle(WINDOW_CHANNELS.openPopout, async (_event, payload) => {
    if (!isPopoutLaunchPayload(payload)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.openPopout} payload`);
      return false;
    }
    if (!deps.onOpenPopout) return false;
    return Boolean(await deps.onOpenPopout(sanitizePopoutLaunchPayload(payload)));
  });

  ipcMain.handle(WINDOW_CHANNELS.closePopout, async () => {
    await deps.onClosePopout?.();
  });

  ipcMain.handle(WINDOW_CHANNELS.getPopoutPayload, ({ sender }) => {
    return deps.onGetPopoutPayload?.(sender) ?? null;
  });

  ipcMain.handle(WINDOW_CHANNELS.dockPopout, async ({ sender }, payload) => {
    if (!isPopoutDockPayload(payload)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.dockPopout} payload`);
      return;
    }
    await deps.onDockPopout?.(sender, sanitizePopoutDockPayload(payload));
  });

  return () => {
    ipcMain.removeHandler(WINDOW_CHANNELS.getAlwaysOnTop);
    ipcMain.removeHandler(WINDOW_CHANNELS.setAlwaysOnTop);
    ipcMain.removeHandler(WINDOW_CHANNELS.setAspectRatioLock);
    ipcMain.removeHandler(WINDOW_CHANNELS.setMinimizeToTray);
    ipcMain.removeHandler(WINDOW_CHANNELS.openPopout);
    ipcMain.removeHandler(WINDOW_CHANNELS.closePopout);
    ipcMain.removeHandler(WINDOW_CHANNELS.getPopoutPayload);
    ipcMain.removeHandler(WINDOW_CHANNELS.dockPopout);
    for (const detach of detachListeners.splice(0)) detach();
  };
}
