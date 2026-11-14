import type { BrowserWindowConstructorOptions } from 'electron';

/** Title shown in the window frame and the task bar. */
export const WINDOW_TITLE = 'ELV IPTV';

/**
 * Builds the BrowserWindow options with the renderer security baseline. In gate mode the preload gets
 * `--elv-gate-mode`, which is how the renderer learns that main (not just the page's query) asked for the gate.
 */
export function buildWindowOptions(
  preloadPath: string,
  opts: { gate?: boolean } = {},
): BrowserWindowConstructorOptions {
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
      backgroundThrottling: false,
      ...(opts.gate ? { additionalArguments: ['--elv-gate-mode'] } : {}),
    },
  };
}
