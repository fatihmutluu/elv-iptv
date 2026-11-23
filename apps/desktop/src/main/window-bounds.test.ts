import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AspectRatioLockWindowLike,
  type BoundsScreenLike,
  type BoundsWindowLike,
  clampWindowBounds,
  createWindowAspectRatioLockController,
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

describe('createWindowAspectRatioLockController (#332)', () => {
  function fakeResizableWindow(
    initialOuter: Rect,
    chrome = { left: 8, top: 32, right: 8, bottom: 8 },
  ) {
    let outer = { ...initialOuter };
    let maximized = false;
    let fullscreen = false;
    let minimized = false;
    let destroyed = false;
    let reentrantResizeOnSetBounds = false;
    const setBoundsCalls: Rect[] = [];
    const listeners = new Set<
      (
        event: { preventDefault(): void },
        newBounds: Rect,
        details?: { readonly edge?: string },
      ) => void
    >();

    const win: AspectRatioLockWindowLike = {
      getBounds: () => ({ ...outer }),
      getContentBounds: () => ({
        x: outer.x + chrome.left,
        y: outer.y + chrome.top,
        width: outer.width - chrome.left - chrome.right,
        height: outer.height - chrome.top - chrome.bottom,
      }),
      setBounds: (next) => {
        outer = { ...next };
        setBoundsCalls.push({ ...next });
        if (reentrantResizeOnSetBounds) {
          for (const l of [...listeners]) {
            l({ preventDefault: () => undefined }, { ...next });
          }
        }
      },
      isMaximized: () => maximized,
      isFullScreen: () => fullscreen,
      isMinimized: () => minimized,
      isDestroyed: () => destroyed,
      on(_event, listener) {
        listeners.add(listener);
      },
      removeListener(_event, listener) {
        listeners.delete(listener);
      },
    };

    const emitWillResize = (newBounds: Rect, edge?: string): { prevented: boolean } => {
      let prevented = false;
      const event = {
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const l of [...listeners]) {
        l(event, newBounds, edge === undefined ? undefined : { edge });
      }
      return { prevented };
    };

    return {
      win,
      setBoundsCalls,
      emitWillResize,
      setMaximized: (v: boolean) => {
        maximized = v;
      },
      setFullScreen: (v: boolean) => {
        fullscreen = v;
      },
      setMinimized: (v: boolean) => {
        minimized = v;
      },
      setReentrant: (v: boolean) => {
        reentrantResizeOnSetBounds = v;
      },
      destroy: () => {
        destroyed = true;
      },
    };
  }

  it('locks content bounds to active DAR on will-resize across 100%, 125%, 150%, 200% DPI and preserves frame chrome', () => {
    const fw = fakeResizableWindow({ x: 100, y: 100, width: 1296, height: 760 }); // 1280x720 content + 16x40 chrome
    let scaleFactor = 1.25;
    const ctl = createWindowAspectRatioLockController(fw.win, {
      getDisplayMatching: () => ({ scaleFactor }),
    });

    ctl.setEnabled(true);
    ctl.setAspectRatio(16 / 9);

    for (const dpr of [1.0, 1.25, 1.5, 2.0]) {
      scaleFactor = dpr;
      const res = fw.emitWillResize({ x: 100, y: 100, width: 1016, height: 640 }, 'right');
      expect(res.prevented).toBe(true);
      const latest = fw.setBoundsCalls.at(-1);
      expect(latest).toBeDefined();
      if (!latest) return;
      const contentW = latest.width - 16;
      const contentH = latest.height - 40;
      const physW = Math.round(contentW * dpr);
      const physH = Math.round(contentH * dpr);
      expect(Math.round(physW / (16 / 9))).toBe(physH);
      expect(Math.round(physH * (16 / 9))).toBe(physW);
    }

    ctl.dispose();
  });

  it('does not intercept will-resize when disabled, no active DAR, maximized, fullscreen, minimized, or in gate mode', () => {
    const fw = fakeResizableWindow({ x: 100, y: 100, width: 1296, height: 760 });
    const ctl = createWindowAspectRatioLockController(fw.win, {
      getDisplayMatching: () => ({ scaleFactor: 1.5 }),
    });

    // Disabled by default
    expect(fw.emitWillResize({ x: 100, y: 100, width: 1100, height: 700 }).prevented).toBe(false);

    // Enabled without active DAR
    ctl.setEnabled(true);
    expect(fw.emitWillResize({ x: 100, y: 100, width: 1100, height: 700 }).prevented).toBe(false);

    // Active DAR set, but maximized / fullscreen / minimized
    ctl.setAspectRatio(16 / 9);
    fw.setMaximized(true);
    expect(fw.emitWillResize({ x: 100, y: 100, width: 1100, height: 700 }).prevented).toBe(false);
    fw.setMaximized(false);

    fw.setFullScreen(true);
    expect(fw.emitWillResize({ x: 100, y: 100, width: 1100, height: 700 }).prevented).toBe(false);
    fw.setFullScreen(false);

    fw.setMinimized(true);
    expect(fw.emitWillResize({ x: 100, y: 100, width: 1100, height: 700 }).prevented).toBe(false);
    fw.setMinimized(false);

    // Clearing DAR on stop/ended/error disables locking
    ctl.setAspectRatio(undefined);
    expect(fw.emitWillResize({ x: 100, y: 100, width: 1100, height: 700 }).prevented).toBe(false);
    ctl.dispose();

    // Gate mode never locks even when enabled + DAR set
    const gateCtl = createWindowAspectRatioLockController(
      fw.win,
      { getDisplayMatching: () => ({ scaleFactor: 1 }) },
      { gate: true, initialEnabled: true, initialAspectRatio: 16 / 9 },
    );
    expect(fw.emitWillResize({ x: 100, y: 100, width: 1100, height: 700 }).prevented).toBe(false);
    gateCtl.dispose();
  });

  it('guards against re-entrant will-resize loops when setBounds triggers will-resize', () => {
    const fw = fakeResizableWindow({ x: 100, y: 100, width: 1296, height: 760 });
    fw.setReentrant(true);
    const ctl = createWindowAspectRatioLockController(
      fw.win,
      { getDisplayMatching: () => ({ scaleFactor: 2.0 }) },
      { initialEnabled: true, initialAspectRatio: 16 / 9 },
    );

    const res = fw.emitWillResize({ x: 80, y: 90, width: 1016, height: 640 }, 'top-left');
    expect(res.prevented).toBe(true);
    expect(fw.setBoundsCalls).toHaveLength(1);
    ctl.dispose();
  });

  it('anchors opposite right/bottom edge on inward shrink from left, top, and top-left edges (#332)', () => {
    const initialOuter: Rect = { x: 100, y: 100, width: 1296, height: 760 };
    const rightEdge = initialOuter.x + initialOuter.width; // 1396
    const bottomEdge = initialOuter.y + initialOuter.height; // 860

    // Left-edge inward shrink at 125% DPI (newBounds.x > outer.x) must keep rightEdge fixed!
    const fwLeft = fakeResizableWindow(initialOuter);
    const ctlLeft = createWindowAspectRatioLockController(
      fwLeft.win,
      { getDisplayMatching: () => ({ scaleFactor: 1.25 }) },
      { initialEnabled: true, initialAspectRatio: 16 / 9 },
    );
    const resLeft = fwLeft.emitWillResize({ x: 300, y: 100, width: 1096, height: 760 }, 'left');
    expect(resLeft.prevented).toBe(true);
    const leftBounds = fwLeft.setBoundsCalls.at(-1);
    expect(leftBounds).toBeDefined();
    expect((leftBounds?.x ?? 0) + (leftBounds?.width ?? 0)).toBe(rightEdge);
    expect(leftBounds?.y).toBe(initialOuter.y);
    ctlLeft.dispose();

    // Top-edge inward shrink at 150% DPI (newBounds.y > outer.y) must keep bottomEdge fixed!
    const fwTop = fakeResizableWindow(initialOuter);
    const ctlTop = createWindowAspectRatioLockController(
      fwTop.win,
      { getDisplayMatching: () => ({ scaleFactor: 1.5 }) },
      { initialEnabled: true, initialAspectRatio: 16 / 9 },
    );
    const resTop = fwTop.emitWillResize({ x: 100, y: 260, width: 1296, height: 600 }, 'top');
    expect(resTop.prevented).toBe(true);
    const topBounds = fwTop.setBoundsCalls.at(-1);
    expect(topBounds).toBeDefined();
    expect((topBounds?.y ?? 0) + (topBounds?.height ?? 0)).toBe(bottomEdge);
    expect(topBounds?.x).toBe(initialOuter.x);
    ctlTop.dispose();

    // Top-left inward shrink clamped by minContentSize must keep BOTH rightEdge and bottomEdge fixed!
    const fwCorner = fakeResizableWindow(initialOuter);
    const ctlCorner = createWindowAspectRatioLockController(
      fwCorner.win,
      { getDisplayMatching: () => ({ scaleFactor: 1.25 }) },
      {
        initialEnabled: true,
        initialAspectRatio: 16 / 9,
        minContentSize: { width: 640, height: 360 },
      },
    );
    const resCorner = fwCorner.emitWillResize(
      { x: 1100, y: 700, width: 296, height: 160 },
      'top-left',
    );
    expect(resCorner.prevented).toBe(true);
    const cornerBounds = fwCorner.setBoundsCalls.at(-1);
    expect(cornerBounds).toBeDefined();
    expect((cornerBounds?.x ?? 0) + (cornerBounds?.width ?? 0)).toBe(rightEdge);
    expect((cornerBounds?.y ?? 0) + (cornerBounds?.height ?? 0)).toBe(bottomEdge);
    ctlCorner.dispose();
  });
});
