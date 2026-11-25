import type { BrowserWindowConstructorOptions } from 'electron';
import type { PresenterKind } from '../shared/player-ipc.ts';
import {
  type PopoutDockPayload,
  type PopoutLaunchPayload,
  sanitizePopoutDockPayload,
  sanitizePopoutLaunchPayload,
  WINDOW_CHANNELS,
} from '../shared/window-ipc.ts';
import { attachBrowserBackGuard, type BrowserBackGuardWindow } from './browser-back.ts';
import { lockDownWebContents, type WebContentsGuardTarget } from './security.ts';
import { restoreWindowFromTray, type TrayRestorableWindow } from './tray.ts';
import {
  type BoundsScreenLike,
  type BoundsWindowLike,
  createWindowBoundsController,
  loadWindowState,
  orderedDisplays,
  type Rect,
  type WindowBoundsController,
  type WindowBoundsDefaults,
} from './window-bounds.ts';
import {
  attachRendererCrashRecovery,
  buildWindowOptions,
  type CrashRecoverableWindow,
  WINDOW_TITLE,
} from './window-options.ts';

/** Dedicated bounds persistence file for the standalone popout player (`#158`). */
export const POPOUT_STATE_FILENAME = 'popout-window-state.json';

/** Default and minimum dimensions for the standalone popout player window (`#158`). */
export const POPOUT_BOUNDS_DEFAULTS: WindowBoundsDefaults = Object.freeze({
  width: 960,
  height: 540,
  minWidth: 480,
  minHeight: 270,
});

/** Minimal Electron `BrowserWindow` surface used by {@link createPopoutWindowController}. */
export interface PopoutBrowserWindowLike
  extends BoundsWindowLike,
    BrowserBackGuardWindow,
    CrashRecoverableWindow {
  setMenuBarVisibility(visible: boolean): void;
  setTitle(title: string): void;
  setAlwaysOnTop(flag: boolean, level?: 'normal' | 'floating'): void;
  isAlwaysOnTop(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
  close(): void;
  on: BoundsWindowLike['on'] &
    BrowserBackGuardWindow['on'] &
    ((
      event: 'page-title-updated',
      listener: (event: { preventDefault(): void }) => void,
    ) => unknown) &
    ((event: 'closed', listener: () => void) => unknown);
  removeListener: BoundsWindowLike['removeListener'];
  readonly webContents: WebContentsGuardTarget &
    BrowserBackGuardWindow['webContents'] &
    CrashRecoverableWindow['webContents'] & {
      send(channel: string, ...args: unknown[]): void;
    };
}

/** Collaborators injected into {@link createPopoutWindowController}. */
export interface PopoutWindowControllerDeps {
  readonly preloadPath: string;
  readonly appBaseUrl: string;
  readonly popoutStatePath: string;
  readonly screen: BoundsScreenLike;
  readonly devOrigin?: string | null;
  readonly presenter?: PresenterKind;
  readonly getMainWindow: () => TrayRestorableWindow | null | undefined;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => PopoutBrowserWindowLike;
  readonly log?: (line: string) => void;
}

/** Controller managing at most one hardened standalone Desktop Popout player window (`#158`). */
export interface PopoutWindowController {
  open(payload: PopoutLaunchPayload): boolean;
  getPayloadForSender(sender: unknown): PopoutLaunchPayload | null;
  dock(sender: unknown, payload: PopoutDockPayload): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

/**
 * Builds hardened `BrowserWindowConstructorOptions` for the standalone popout player window
 * on top of {@link buildWindowOptions} (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
 */
export function buildPopoutWindowOptions(
  preloadPath: string,
  opts: {
    readonly bounds?: Rect;
    readonly pinned?: boolean;
    readonly presenter?: PresenterKind;
  } = {},
): BrowserWindowConstructorOptions {
  const base = buildWindowOptions(preloadPath, {
    ...(opts.bounds === undefined ? {} : { bounds: opts.bounds }),
    ...(opts.presenter === undefined ? {} : { presenter: opts.presenter }),
  });
  return {
    ...base,
    width: opts.bounds?.width ?? POPOUT_BOUNDS_DEFAULTS.width,
    height: opts.bounds?.height ?? POPOUT_BOUNDS_DEFAULTS.height,
    minWidth: POPOUT_BOUNDS_DEFAULTS.minWidth,
    minHeight: POPOUT_BOUNDS_DEFAULTS.minHeight,
    frame: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    alwaysOnTop: opts.pinned ?? false,
  };
}

function buildPopoutUrl(baseUrl: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}popout=1`;
}

/**
 * Creates a single-instance hardened standalone Popout Player window controller (`#158`).
 * Persists geometry to a dedicated `popout-window-state.json` without touching main window state,
 * applies full webContents security lockdown, and routes dock handoffs back to the main window.
 */
export function createPopoutWindowController(
  deps: PopoutWindowControllerDeps,
): PopoutWindowController {
  let popoutWindow: PopoutBrowserWindowLike | undefined;
  let boundsController: WindowBoundsController | undefined;
  let currentPayload: PopoutLaunchPayload | null = null;
  const popoutUrl = buildPopoutUrl(deps.appBaseUrl);

  const cleanupPopout = (): void => {
    boundsController?.dispose();
    boundsController = undefined;
    popoutWindow = undefined;
    currentPayload = null;
  };

  return {
    open(rawPayload) {
      const clean = sanitizePopoutLaunchPayload(rawPayload);
      currentPayload = clean;

      if (popoutWindow && !popoutWindow.isDestroyed()) {
        if (clean.pinned !== undefined) {
          popoutWindow.setAlwaysOnTop(clean.pinned, 'floating');
        }
        if (!popoutWindow.webContents.isDestroyed()) {
          popoutWindow.webContents.send(WINDOW_CHANNELS.popoutPayload, clean);
        }
        if (popoutWindow.isMinimized()) popoutWindow.restore();
        popoutWindow.show();
        popoutWindow.focus();
        return true;
      }

      const saved = loadWindowState(
        deps.popoutStatePath,
        orderedDisplays(deps.screen),
        POPOUT_BOUNDS_DEFAULTS,
      );
      const pinned = clean.pinned ?? false;
      const options = buildPopoutWindowOptions(deps.preloadPath, {
        bounds: {
          x: saved.x,
          y: saved.y,
          width: saved.width,
          height: saved.height,
        },
        pinned,
        ...(deps.presenter === undefined ? {} : { presenter: deps.presenter }),
      });

      const win = deps.createWindow(options);
      popoutWindow = win;
      win.setMenuBarVisibility(false);
      win.setAlwaysOnTop(pinned, 'floating');
      lockDownWebContents(
        win.webContents,
        deps.devOrigin ? { devOrigin: deps.devOrigin } : undefined,
      );
      attachBrowserBackGuard(win);
      attachRendererCrashRecovery(win, {
        gate: false,
        reloadUrl: popoutUrl,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
      win.on('page-title-updated', (event) => {
        (event as { preventDefault?: () => void })?.preventDefault?.();
      });
      win.setTitle(WINDOW_TITLE);

      boundsController = createWindowBoundsController(win, deps.popoutStatePath, deps.screen, {
        initialState: saved,
      });

      win.on('closed', () => {
        if (popoutWindow === win) cleanupPopout();
      });

      void win.loadURL(popoutUrl).catch(() => undefined);
      return true;
    },

    getPayloadForSender(sender) {
      if (!popoutWindow || popoutWindow.isDestroyed()) return null;
      if (sender !== popoutWindow.webContents) return null;
      return currentPayload;
    },

    dock(sender, rawPayload) {
      if (!popoutWindow || popoutWindow.isDestroyed()) return;
      if (sender !== popoutWindow.webContents) return;
      const clean = sanitizePopoutDockPayload(rawPayload);
      const mainWin = deps.getMainWindow();
      restoreWindowFromTray(mainWin);
      if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
        mainWin.webContents.send(WINDOW_CHANNELS.popoutDocked, clean);
      }
      const winToClose = popoutWindow;
      currentPayload = null;
      winToClose.close();
    },

    close() {
      if (!popoutWindow || popoutWindow.isDestroyed()) {
        cleanupPopout();
        return;
      }
      const winToClose = popoutWindow;
      currentPayload = null;
      winToClose.close();
    },

    isOpen() {
      return popoutWindow !== undefined && !popoutWindow.isDestroyed();
    },

    dispose() {
      if (popoutWindow && !popoutWindow.isDestroyed()) {
        popoutWindow.close();
      }
      cleanupPopout();
    },
  };
}
