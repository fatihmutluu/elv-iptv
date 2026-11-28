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

describe('shell-prefs (#158, Wave Q7)', () => {
  it('defaults minimizeToTray to true and zoomLevel to 0 when file is missing, corrupt, oversized, or malformed', () => {
    const missing = makeTempFile();
    expect(DEFAULT_SHELL_PREFS).toEqual({ minimizeToTray: true, zoomLevel: 0 });
    expect(loadShellPrefs(missing)).toEqual(DEFAULT_SHELL_PREFS);

    writeFileSync(missing, '{not valid json', 'utf8');
    expect(loadShellPrefs(missing)).toEqual({ minimizeToTray: true, zoomLevel: 0 });

    writeFileSync(missing, JSON.stringify({ minimizeToTray: 'yes', zoomLevel: '2' }), 'utf8');
    expect(loadShellPrefs(missing)).toEqual({ minimizeToTray: true, zoomLevel: 0 });

    writeFileSync(missing, JSON.stringify({}), 'utf8');
    expect(loadShellPrefs(missing)).toEqual({ minimizeToTray: true, zoomLevel: 0 });

    writeFileSync(missing, 'x'.repeat(10_000), 'utf8');
    expect(loadShellPrefs(missing)).toEqual({ minimizeToTray: true, zoomLevel: 0 });
  });

  it('preserves backwards compatibility with legacy JSON files lacking zoomLevel', () => {
    const legacy = makeTempFile();
    writeFileSync(legacy, JSON.stringify({ minimizeToTray: false }), 'utf8');
    expect(loadShellPrefs(legacy)).toEqual({ minimizeToTray: false, zoomLevel: 0 });

    const ctl = createShellPrefsController(legacy);
    expect(ctl.getMinimizeToTray()).toBe(false);
    expect(ctl.getZoomLevel()).toBe(0);
  });

  it('clamps loaded zoomLevel to [-3, 4] rounded to 0.5 steps and rejects non-finite values', () => {
    const filePath = makeTempFile();
    writeFileSync(filePath, JSON.stringify({ minimizeToTray: true, zoomLevel: 12 }), 'utf8');
    expect(loadShellPrefs(filePath).zoomLevel).toBe(4);

    writeFileSync(filePath, JSON.stringify({ minimizeToTray: true, zoomLevel: -9 }), 'utf8');
    expect(loadShellPrefs(filePath).zoomLevel).toBe(-3);

    writeFileSync(filePath, JSON.stringify({ minimizeToTray: true, zoomLevel: 1.26 }), 'utf8');
    expect(loadShellPrefs(filePath).zoomLevel).toBe(1.5);

    writeFileSync(filePath, JSON.stringify({ minimizeToTray: true, zoomLevel: -0.1 }), 'utf8');
    expect(Object.is(loadShellPrefs(filePath).zoomLevel, 0)).toBe(true);
  });

  it('honors explicit stored values and persists minimizeToTray and zoomLevel atomically via controller', () => {
    const filePath = makeTempFile();
    saveShellPrefs(filePath, { minimizeToTray: false, zoomLevel: 1.5 });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      minimizeToTray: false,
      zoomLevel: 1.5,
    });
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: false, zoomLevel: 1.5 });

    const ctl = createShellPrefsController(filePath);
    expect(ctl.getMinimizeToTray()).toBe(false);
    expect(ctl.getZoomLevel()).toBe(1.5);

    expect(ctl.setMinimizeToTray(true)).toBe(true);
    expect(ctl.getMinimizeToTray()).toBe(true);
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: true, zoomLevel: 1.5 });

    expect(ctl.setZoomLevel(2.3)).toBe(2.5);
    expect(ctl.getZoomLevel()).toBe(2.5);
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: true, zoomLevel: 2.5 });

    expect(ctl.setZoomLevel(99)).toBe(4);
    expect(ctl.setZoomLevel(-99)).toBe(-3);
    expect(ctl.setZoomLevel(Number.NaN)).toBe(0);
    expect(ctl.getZoomLevel()).toBe(0);
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: true, zoomLevel: 0 });

    expect(ctl.setMinimizeToTray(false)).toBe(false);
    expect(ctl.getMinimizeToTray()).toBe(false);
    expect(loadShellPrefs(filePath)).toEqual({ minimizeToTray: false, zoomLevel: 0 });
  });
});
