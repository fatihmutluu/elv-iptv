import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BoundsScreenLike,
  type BoundsWindowLike,
  clampWindowBounds,
  createWindowBoundsController,
  type DisplayWorkArea,
  loadWindowState,
  type PersistedWindowState,
  type Rect,
} from './window-bounds.ts';

const PRIMARY: DisplayWorkArea = {
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

const SECONDARY_RIGHT: DisplayWorkArea = {
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
};

const SMALL_LAPTOP: DisplayWorkArea = {
  workArea: { x: 0, y: 24, width: 1366, height: 720 },
};

describe('clampWindowBounds (#408)', () => {
  it('centers default bounds on the primary display when saved state is missing', () => {
    expect(clampWindowBounds(null, [PRIMARY])).toEqual({
      x: 320,
      y: 160,
      width: 1280,
      height: 720,
      isMaximized: false,
    });
    expect(clampWindowBounds(undefined, [SMALL_LAPTOP])).toEqual({
      x: 43,
      y: 24,
      width: 1280,
      height: 720,
      isMaximized: false,
    });
  });

  it('preserves valid bounds strictly inside the matching connected display', () => {
    const saved: PersistedWindowState = {
      x: 2100,
      y: 120,
      width: 1600,
      height: 900,
      isMaximized: false,
    };
    expect(clampWindowBounds(saved, [PRIMARY, SECONDARY_RIGHT])).toEqual(saved);
  });

  it('chooses the display with the largest intersection area and clamps strictly inside its workArea', () => {
    const straddling: PersistedWindowState = {
      x: 1800,
      y: -50,
      width: 1200,
      height: 800,
      isMaximized: true,
    };
    // 120px on PRIMARY vs 1080px on SECONDARY_RIGHT -> picks SECONDARY_RIGHT and clamps x/y inside it
    expect(clampWindowBounds(straddling, [PRIMARY, SECONDARY_RIGHT])).toEqual({
      x: 1920,
      y: 0,
      width: 1200,
      height: 800,
      isMaximized: true,
    });
  });

  it('clamps windows from a disconnected monitor onto the primary display so they never open off-screen', () => {
    const disconnected: PersistedWindowState = {
      x: 2400,
      y: 300,
      width: 1280,
      height: 720,
      isMaximized: false,
    };
    const clamped = clampWindowBounds(disconnected, [PRIMARY]);
    expect(clamped.x).toBeGreaterThanOrEqual(PRIMARY.workArea.x);
    expect(clamped.y).toBeGreaterThanOrEqual(PRIMARY.workArea.y);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(
      PRIMARY.workArea.x + PRIMARY.workArea.width,
    );
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(
      PRIMARY.workArea.y + PRIMARY.workArea.height,
    );
    expect(clamped).toEqual({
      x: 640,
      y: 300,
      width: 1280,
      height: 720,
      isMaximized: false,
    });
  });

  it('clamps undersized and oversized dimensions to [min, workArea]', () => {
    expect(
      clampWindowBounds({ x: 10, y: 10, width: 300, height: 200, isMaximized: false }, [PRIMARY]),
    ).toEqual({
      x: 10,
      y: 10,
      width: 800,
      height: 500,
      isMaximized: false,
    });

    expect(
      clampWindowBounds({ x: 100, y: 100, width: 3000, height: 2000, isMaximized: false }, [
        SMALL_LAPTOP,
      ]),
    ).toEqual({
      x: 0,
      y: 24,
      width: 1366,
      height: 720,
      isMaximized: false,
    });
  });

  it('falls back gracefully on non-finite coordinates or tiny displays', () => {
    expect(
      clampWindowBounds({ x: Number.NaN, y: 50, width: 1280, height: 720, isMaximized: true }, [
        PRIMARY,
      ]),
    ).toEqual({
      x: 320,
      y: 160,
      width: 1280,
      height: 720,
      isMaximized: true,
    });

    const tiny: DisplayWorkArea = { workArea: { x: 0, y: 0, width: 640, height: 400 } };
    expect(clampWindowBounds(null, [tiny])).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 400,
      isMaximized: false,
    });
  });

  it('handles an empty displays array without throwing', () => {
    expect(clampWindowBounds(null, [])).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      isMaximized: false,
    });
  });
});

describe('loadWindowState & createWindowBoundsController (#408)', () => {
  const dirs: string[] = [];

  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'elv-win-bounds-'));
    dirs.push(dir);
    return join(dir, 'window-state.json');
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to centered defaults when window-state.json is missing or corrupt', () => {
    const missing = tempFile();
    expect(loadWindowState(missing, [PRIMARY])).toEqual({
      x: 320,
      y: 160,
      width: 1280,
      height: 720,
      isMaximized: false,
    });

    writeFileSync(missing, '{not valid json', 'utf8');
    expect(loadWindowState(missing, [PRIMARY])).toEqual({
      x: 320,
      y: 160,
      width: 1280,
      height: 720,
      isMaximized: false,
    });

    writeFileSync(missing, JSON.stringify({ x: 'bad', y: 10, width: 900, height: 600 }), 'utf8');
    expect(loadWindowState(missing, [PRIMARY])).toEqual({
      x: 320,
      y: 160,
      width: 1280,
      height: 720,
      isMaximized: false,
    });
  });

  it('loads valid saved state and clamps it to connected displays', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({ x: 3000, y: 50, width: 1200, height: 700, isMaximized: true }),
      'utf8',
    );
    expect(loadWindowState(file, [PRIMARY])).toEqual({
      x: 720,
      y: 50,
      width: 1200,
      height: 700,
      isMaximized: true,
    });
  });

  function fakeWindow(initial: Rect) {
    let bounds = { ...initial };
    let maximized = false;
    let fullscreen = false;
    let minimized = false;
    let destroyed = false;
    const listeners = new Map<string, Set<() => void>>();

    const win: BoundsWindowLike = {
      getBounds: () => ({ ...bounds }),
      isMaximized: () => maximized,
      isFullScreen: () => fullscreen,
      isMinimized: () => minimized,
      isDestroyed: () => destroyed,
      on(event, listener) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(listener);
      },
      removeListener(event, listener) {
        listeners.get(event)?.delete(listener);
      },
    };

    const emit = (event: string): void => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    };

    return {
      win,
      setBounds: (next: Rect) => {
        bounds = { ...next };
      },
      setMaximized: (v: boolean) => {
        maximized = v;
      },
      setFullScreen: (v: boolean) => {
        fullscreen = v;
      },
      setMinimized: (v: boolean) => {
        minimized = v;
      },
      destroy: () => {
        destroyed = true;
      },
      emit,
    };
  }

  it('tracks lastNormalBounds without overwriting pre-maximized bounds, coalesces writes, and flushes on close', () => {
    vi.useFakeTimers();
    try {
      const file = tempFile();
      const fw = fakeWindow({ x: 100, y: 120, width: 1280, height: 720 });
      const screen: BoundsScreenLike = {
        getAllDisplays: () => [PRIMARY],
        getPrimaryDisplay: () => PRIMARY,
      };
      const controller = createWindowBoundsController(fw.win, file, screen, {
        initialState: { x: 100, y: 120, width: 1280, height: 720, isMaximized: false },
      });

      // Rapid resize/move events coalesce into one write after 500 ms.
      fw.setBounds({ x: 200, y: 150, width: 1300, height: 760 });
      fw.emit('move');
      fw.setBounds({ x: 220, y: 160, width: 1400, height: 800 });
      fw.emit('resize');
      vi.advanceTimersByTime(499);
      expect(() => readFileSync(file, 'utf8')).toThrow();

      vi.advanceTimersByTime(1);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        x: 220,
        y: 160,
        width: 1400,
        height: 800,
        isMaximized: false,
      });

      // Maximizing emits resize with full screen dimensions — MUST NOT overwrite pre-maximized bounds!
      fw.setMaximized(true);
      fw.setBounds({ x: 0, y: 0, width: 1920, height: 1040 });
      fw.emit('resize');
      fw.emit('maximize');
      vi.advanceTimersByTime(500);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        x: 220,
        y: 160,
        width: 1400,
        height: 800,
        isMaximized: true,
      });

      // Fullscreen and minimized resize/move events also must not overwrite lastNormalBounds.
      fw.setMaximized(false);
      fw.setFullScreen(true);
      fw.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
      fw.emit('resize');
      fw.setFullScreen(false);
      fw.setMinimized(true);
      fw.setBounds({ x: -32000, y: -32000, width: 160, height: 28 });
      fw.emit('move');
      fw.setMinimized(false);

      // Unmaximize restores normal tracking and close flushes immediately without waiting 500 ms.
      fw.setBounds({ x: 260, y: 180, width: 1420, height: 810 });
      fw.emit('unmaximize');
      fw.emit('close');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        x: 260,
        y: 180,
        width: 1420,
        height: 810,
        isMaximized: false,
      });

      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
