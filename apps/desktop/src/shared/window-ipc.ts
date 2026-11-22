/** IPC channels exposed by main for desktop window controls (`#408`). */
export const WINDOW_CHANNELS = Object.freeze({
  setAlwaysOnTop: 'window:set-always-on-top',
  getAlwaysOnTop: 'window:get-always-on-top',
  alwaysOnTopChanged: 'window:always-on-top-changed',
} as const);

/** Frozen `window.elv.window` bridge exposed by the Electron preload (`#408`). */
export interface WindowBridge {
  setAlwaysOnTop(enabled: boolean): Promise<boolean>;
  getAlwaysOnTop(): Promise<boolean>;
  onAlwaysOnTopChanged(listener: (enabled: boolean) => void): () => void;
}

/** Validates the boolean payload sent over `window:set-always-on-top` and `window:always-on-top-changed`. */
export function isAlwaysOnTopFlag(x: unknown): x is boolean {
  return typeof x === 'boolean';
}
