import type { BrowserWindowConstructorOptions } from 'electron';

/** Title shown in the window frame and the task bar. */
export const WINDOW_TITLE = 'ELV IPTV';

/** Builds the BrowserWindow options with the renderer security baseline. */
export function buildWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    title: WINDOW_TITLE,
    width: 1280,
    height: 720,
    backgroundColor: '#101114',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
