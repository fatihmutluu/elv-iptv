import {
  clampZoomLevel,
  isAllowedExternalTrailerUrl,
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
import { assertTrustedSenderFrame, type TrustedSenderEventLike } from './trusted-sender.ts';

type IpcHandler = (
  event: TrustedSenderEventLike & { sender: unknown },
  ...args: unknown[]
) => unknown;

/** Minimal `ipcMain` surface used by {@link registerWindowIpc}. */
export interface WindowIpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

/** Minimal `BrowserWindow` surface used by {@link registerWindowIpc}. */
export interface WindowIpcWindowLike {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
    setZoomLevel?(level: number): void;
  };
}

/** Collaborators injected into {@link registerWindowIpc}. */
export interface WindowIpcDeps {
  ipcMain: WindowIpcMainLike;
  getWindowFromSender(sender: unknown): WindowIpcWindowLike | null | undefined;
  onSetAspectRatioLock?(win: WindowIpcWindowLike, enabled: boolean): void;
  onSetMinimizeToTray?(enabled: boolean, labels?: TrayLabels): boolean;
  getMinimizeToTray?(): boolean;
  getZoomLevel?(): number;
  onSetZoomLevel?(level: number): number;
  onOpenPopout?(payload: PopoutLaunchPayload): Promise<boolean> | boolean;
  onClosePopout?(): Promise<void> | void;
  onGetPopoutPayload?(sender: unknown): PopoutLaunchPayload | null;
  onDockPopout?(sender: unknown, payload: PopoutDockPayload): Promise<void> | void;
  onOpenExternalUrl?(url: string): Promise<boolean> | boolean;
  devOrigin?: string | null;
  log?(line: string): void;
}

/**
 * Registers typed window control, minimize-to-tray (`#158`), and popout window (`#158`) IPC
 * handlers on `ipcMain`. Every payload is strictly validated; invalid payloads are dropped and
 * logged by channel name only. Returns the disposer.
 */
export function registerWindowIpc(deps: WindowIpcDeps): () => void {
  const { ipcMain, getWindowFromSender, onSetAspectRatioLock, log } = deps;
  const aspectRatioLocked = new WeakMap<WindowIpcWindowLike, boolean>();

  const assertTrusted = (event: TrustedSenderEventLike, channel: string): void => {
    assertTrustedSenderFrame(event, channel, deps.devOrigin, log);
  };

  ipcMain.handle(WINDOW_CHANNELS.setAspectRatioLock, async (event, enabled) => {
    assertTrusted(event, WINDOW_CHANNELS.setAspectRatioLock);
    const win = getWindowFromSender(event.sender);
    if (!isAspectRatioLockFlag(enabled)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.setAspectRatioLock} payload`);
      return win && !win.isDestroyed() ? (aspectRatioLocked.get(win) ?? false) : false;
    }
    if (!win || win.isDestroyed()) return false;
    aspectRatioLocked.set(win, enabled);
    onSetAspectRatioLock?.(win, enabled);
    return enabled;
  });

  ipcMain.handle(WINDOW_CHANNELS.setMinimizeToTray, async (event, enabled, rawLabels) => {
    assertTrusted(event, WINDOW_CHANNELS.setMinimizeToTray);
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

  ipcMain.handle(WINDOW_CHANNELS.openPopout, async (event, payload) => {
    assertTrusted(event, WINDOW_CHANNELS.openPopout);
    if (!isPopoutLaunchPayload(payload)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.openPopout} payload`);
      return false;
    }
    if (!deps.onOpenPopout) return false;
    return Boolean(await deps.onOpenPopout(sanitizePopoutLaunchPayload(payload)));
  });

  ipcMain.handle(WINDOW_CHANNELS.closePopout, async (event) => {
    assertTrusted(event, WINDOW_CHANNELS.closePopout);
    await deps.onClosePopout?.();
  });

  ipcMain.handle(WINDOW_CHANNELS.getPopoutPayload, async (event) => {
    assertTrusted(event, WINDOW_CHANNELS.getPopoutPayload);
    return deps.onGetPopoutPayload?.(event.sender) ?? null;
  });

  ipcMain.handle(WINDOW_CHANNELS.dockPopout, async (event, payload) => {
    assertTrusted(event, WINDOW_CHANNELS.dockPopout);
    if (!isPopoutDockPayload(payload)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.dockPopout} payload`);
      return;
    }
    await deps.onDockPopout?.(event.sender, sanitizePopoutDockPayload(payload));
  });

  ipcMain.handle(WINDOW_CHANNELS.openExternalUrl, async (event, rawUrl) => {
    assertTrusted(event, WINDOW_CHANNELS.openExternalUrl);
    if (!isAllowedExternalTrailerUrl(rawUrl)) {
      log?.(`window ipc: blocked disallowed ${WINDOW_CHANNELS.openExternalUrl} payload`);
      return false;
    }
    if (!deps.onOpenExternalUrl) return false;
    try {
      return Boolean(await deps.onOpenExternalUrl(rawUrl.trim()));
    } catch {
      return false;
    }
  });

  ipcMain.handle(WINDOW_CHANNELS.getZoomLevel, async (event) => {
    assertTrusted(event, WINDOW_CHANNELS.getZoomLevel);
    return clampZoomLevel(deps.getZoomLevel?.() ?? 0);
  });

  ipcMain.handle(WINDOW_CHANNELS.setZoomLevel, async (event, rawLevel) => {
    assertTrusted(event, WINDOW_CHANNELS.setZoomLevel);
    if (typeof rawLevel !== 'number' || !Number.isFinite(rawLevel)) {
      log?.(`window ipc: dropped an invalid ${WINDOW_CHANNELS.setZoomLevel} payload`);
      return clampZoomLevel(deps.getZoomLevel?.() ?? 0);
    }
    const clamped = clampZoomLevel(rawLevel);
    const persisted = deps.onSetZoomLevel ? clampZoomLevel(deps.onSetZoomLevel(clamped)) : clamped;
    const win = getWindowFromSender(event.sender);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.setZoomLevel?.(persisted);
      win.webContents.send(WINDOW_CHANNELS.zoomLevelChanged, persisted);
    }
    return persisted;
  });

  return () => {
    ipcMain.removeHandler(WINDOW_CHANNELS.setAspectRatioLock);
    ipcMain.removeHandler(WINDOW_CHANNELS.setMinimizeToTray);
    ipcMain.removeHandler(WINDOW_CHANNELS.openPopout);
    ipcMain.removeHandler(WINDOW_CHANNELS.closePopout);
    ipcMain.removeHandler(WINDOW_CHANNELS.getPopoutPayload);
    ipcMain.removeHandler(WINDOW_CHANNELS.dockPopout);
    ipcMain.removeHandler(WINDOW_CHANNELS.openExternalUrl);
    ipcMain.removeHandler(WINDOW_CHANNELS.getZoomLevel);
    ipcMain.removeHandler(WINDOW_CHANNELS.setZoomLevel);
  };
}
