import type { PopoutDockPayload, PopoutLaunchPayload } from './popout-ipc.ts';

export {
  isPopoutDockPayload,
  isPopoutLaunchPayload,
  type PopoutDockPayload,
  type PopoutLaunchPayload,
  sanitizePopoutDockPayload,
  sanitizePopoutLaunchPayload,
} from './popout-ipc.ts';

/** IPC channels exposed by main for desktop window, tray, and popout controls (`#408`, `#332`, `#158`). */
export const WINDOW_CHANNELS = Object.freeze({
  setAlwaysOnTop: 'window:set-always-on-top',
  getAlwaysOnTop: 'window:get-always-on-top',
  alwaysOnTopChanged: 'window:always-on-top-changed',
  setAspectRatioLock: 'window:set-aspect-ratio-lock',
  setMinimizeToTray: 'window:set-minimize-to-tray',
  windowRestored: 'window:restored',
  hiddenToTray: 'window:hidden-to-tray',
  openPopout: 'window:open-popout',
  closePopout: 'window:close-popout',
  getPopoutPayload: 'window:get-popout-payload',
  popoutPayload: 'window:popout-payload',
  dockPopout: 'window:dock-popout',
  popoutDocked: 'window:popout-docked',
} as const);

/** Frozen `window.elv.window` bridge exposed by the Electron preload (`#408`, `#332`, `#158`). */
export interface WindowBridge {
  setAlwaysOnTop(enabled: boolean): Promise<boolean>;
  getAlwaysOnTop(): Promise<boolean>;
  onAlwaysOnTopChanged(listener: (enabled: boolean) => void): () => void;
  setAspectRatioLock(enabled: boolean): Promise<boolean>;
  setMinimizeToTray(enabled: boolean): Promise<boolean>;
  openPopout(payload: PopoutLaunchPayload): Promise<boolean>;
  closePopout(): Promise<void>;
  getPopoutPayload(): Promise<PopoutLaunchPayload | null>;
  onPopoutPayload(listener: (payload: PopoutLaunchPayload) => void): () => void;
  dockPopout(payload: PopoutDockPayload): Promise<void>;
  onPopoutDocked(listener: (payload: PopoutDockPayload) => void): () => void;
  onWindowRestored(listener: () => void): () => void;
  onHiddenToTray(listener: () => void): () => void;
}

/** Validates the boolean payload sent over `window:set-always-on-top` and `window:always-on-top-changed`. */
export function isAlwaysOnTopFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

/** Validates the boolean payload sent over `window:set-aspect-ratio-lock` (`#332`). */
export function isAspectRatioLockFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

/** Validates the boolean payload sent over `window:set-minimize-to-tray` (`#158`). */
export function isMinimizeToTrayFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}
