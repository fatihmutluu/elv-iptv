import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createShellPrefsController,
  DEFAULT_SHELL_PREFS,
  loadShellPrefs,
  saveShellPrefs,
} from './shell-prefs.ts';

const tempDirs: string[] = [];

function makeTempFile(name = 'shell-prefs.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-shell-prefs-'));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('shell-prefs (#158)', () => {
  it('defaults minimizeToTray to false when file is missing, corrupt, oversized, or malformed', () => {
    const missing = makeTempFile();
    expect(loadShellPrefs(missing)).toEqual(DEFAULT_SHELL_PREFS);

    writeFileSync(missing, '{not valid json', 'utf8');
    expect(loadShellPrefs(missing)).toEqual({ minimizeToTray: false });

    writeFileSync(missing, JSON.stringify({ minimizeToTray: 'yes' }), 'utf8');
    expect(loadShellPrefs(missing)).toEqual({ minimizeToTray: false });

    writeFileSync(missing, 'x'.repeat(10_000), 'utf8');
    expect(loadShellPrefs(missing)).toEqual({ minimizeToTray: false });
  });

  it('persists minimizeToTray atomically and reads it synchronously via controller', () => {
    const filePath = makeTempFile();
    saveShellPrefs(filePath, { minimizeToTray: true });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ minimizeToTray: true });
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: true });

    const ctl = createShellPrefsController(filePath);
    expect(ctl.getMinimizeToTray()).toBe(true);

    expect(ctl.setMinimizeToTray(false)).toBe(false);
    expect(ctl.getMinimizeToTray()).toBe(false);
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: false });

    expect(ctl.setMinimizeToTray(true)).toBe(true);
    expect(ctl.getMinimizeToTray()).toBe(true);
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: true });
  });
});
