/** IPC channels exposed by main for desktop window controls (`#408`, `#332`). */
export const WINDOW_CHANNELS = Object.freeze({
  setAlwaysOnTop: 'window:set-always-on-top',
  getAlwaysOnTop: 'window:get-always-on-top',
  alwaysOnTopChanged: 'window:always-on-top-changed',
  setAspectRatioLock: 'window:set-aspect-ratio-lock',
} as const);

/** Frozen `window.elv.window` bridge exposed by the Electron preload (`#408`, `#332`). */
export interface WindowBridge {
  setAlwaysOnTop(enabled: boolean): Promise<boolean>;
  getAlwaysOnTop(): Promise<boolean>;
  onAlwaysOnTopChanged(listener: (enabled: boolean) => void): () => void;
  setAspectRatioLock(enabled: boolean): Promise<boolean>;
}

/** Validates the boolean payload sent over `window:set-always-on-top` and `window:always-on-top-changed`. */
export function isAlwaysOnTopFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

/** Validates the boolean payload sent over `window:set-aspect-ratio-lock` (`#332`). */
export function isAspectRatioLockFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}
