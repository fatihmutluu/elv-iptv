import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clampZoomLevel } from '../shared/window-ipc.ts';

/** Main-process shell preferences persisted synchronously in `userData/shell-prefs.json` (`#158`). */
export interface ShellPrefs {
  readonly minimizeToTray: boolean;
  readonly zoomLevel: number;
}

/** Default main-process shell preferences. */
export const DEFAULT_SHELL_PREFS: ShellPrefs = Object.freeze({
  minimizeToTray: true,
  zoomLevel: 0,
});

/** Controller providing race-free synchronous reads of main-process shell preferences (`#158`). */
export interface ShellPrefsController {
  getMinimizeToTray(): boolean;
  setMinimizeToTray(enabled: boolean): boolean;
  getZoomLevel(): number;
  setZoomLevel(level: number): number;
}

const MAX_PREFS_BYTES = 4096;

/** Synchronously loads persisted shell preferences, defaulting cleanly on missing or invalid files. */
export function loadShellPrefs(filePath: string): ShellPrefs {
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (raw.length === 0 || raw.length > MAX_PREFS_BYTES) return DEFAULT_SHELL_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_SHELL_PREFS;
    }
    const rec = parsed as Record<string, unknown>;
    const rawZoom = rec['zoomLevel'];
    return {
      minimizeToTray:
        typeof rec['minimizeToTray'] === 'boolean'
          ? rec['minimizeToTray']
          : DEFAULT_SHELL_PREFS.minimizeToTray,
      zoomLevel:
        typeof rawZoom === 'number' && Number.isFinite(rawZoom)
          ? clampZoomLevel(rawZoom)
          : DEFAULT_SHELL_PREFS.zoomLevel,
    };
  } catch {
    return DEFAULT_SHELL_PREFS;
  }
}

/** Atomically writes shell preferences to `filePath`. */
export function saveShellPrefs(filePath: string, prefs: ShellPrefs): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      tmpPath,
      JSON.stringify({
        minimizeToTray: Boolean(prefs.minimizeToTray),
        zoomLevel: clampZoomLevel(prefs.zoomLevel),
      }),
      'utf8',
    );
    renameSync(tmpPath, filePath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

/** Creates an in-memory + disk-backed controller so `BrowserWindow.on('close')` and zoom shortcuts read synchronously. */
export function createShellPrefsController(filePath: string): ShellPrefsController {
  const initial = loadShellPrefs(filePath);
  let minimizeToTray = initial.minimizeToTray;
  let zoomLevel = initial.zoomLevel;
  return {
    getMinimizeToTray: () => minimizeToTray,
    setMinimizeToTray(enabled: boolean): boolean {
      const next = Boolean(enabled);
      if (next !== minimizeToTray) {
        minimizeToTray = next;
        saveShellPrefs(filePath, { minimizeToTray, zoomLevel });
      }
      return minimizeToTray;
    },
    getZoomLevel: () => zoomLevel,
    setZoomLevel(level: number): number {
      const next = clampZoomLevel(level);
      if (next !== zoomLevel) {
        zoomLevel = next;
        saveShellPrefs(filePath, { minimizeToTray, zoomLevel });
      }
      return zoomLevel;
    },
  };
}
