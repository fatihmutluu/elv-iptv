import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Main-process shell preferences persisted synchronously in `userData/shell-prefs.json` (`#158`). */
export interface ShellPrefs {
  readonly minimizeToTray: boolean;
}

/** Default main-process shell preferences. */
export const DEFAULT_SHELL_PREFS: ShellPrefs = Object.freeze({
  minimizeToTray: false,
});

/** Controller providing race-free synchronous reads of main-process shell preferences (`#158`). */
export interface ShellPrefsController {
  getMinimizeToTray(): boolean;
  setMinimizeToTray(enabled: boolean): boolean;
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
    return {
      minimizeToTray: typeof rec['minimizeToTray'] === 'boolean' ? rec['minimizeToTray'] : false,
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
      JSON.stringify({ minimizeToTray: Boolean(prefs.minimizeToTray) }),
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

/** Creates an in-memory + disk-backed controller so `BrowserWindow.on('close')` reads synchronously. */
export function createShellPrefsController(filePath: string): ShellPrefsController {
  let minimizeToTray = loadShellPrefs(filePath).minimizeToTray;
  return {
    getMinimizeToTray: () => minimizeToTray,
    setMinimizeToTray(enabled: boolean): boolean {
      const next = Boolean(enabled);
      if (next !== minimizeToTray) {
        minimizeToTray = next;
        saveShellPrefs(filePath, { minimizeToTray });
      }
      return minimizeToTray;
    },
  };
}
