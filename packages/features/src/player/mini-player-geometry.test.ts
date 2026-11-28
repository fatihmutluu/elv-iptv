import { describe, expect, it } from 'vitest';
import {
  clampMiniPlayerWidth,
  computeCornerPosition,
  computeEdgeResizedMiniBounds,
  computeMiniPlayerBounds,
  computeResizedWidthFromDrag,
  inwardResizeCorner,
  MINI_PLAYER_MARGIN_PX,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_WIDTH,
  type MiniPlayerRect,
  type MiniPlayerResizeEdge,
  type MiniPlayerViewport,
  miniPlayerHeightForWidth,
  PORTRAIT_BOTTOM_TAB_CLEARANCE_PX,
  resizeCursorForEdge,
  snapToNearestCorner,
} from './mini-player-geometry';

const DESKTOP_VP: MiniPlayerViewport = {
  width: 1280,
  height: 720,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  overscan: { x: 0, y: 0 },
  isPortraitPhone: false,
  isTv: false,
};

describe('mini-player-geometry', () => {
  it('computes safe inner bounds honoring margin, safeArea, overscan, and portrait phone tab clearance', () => {
    const desktop = computeMiniPlayerBounds(
      1280,
      720,
      { top: 0, right: 0, bottom: 0, left: 0 },
      { x: 0, y: 0 },
      false,
    );
    expect(desktop).toEqual({
      left: MINI_PLAYER_MARGIN_PX,
      top: MINI_PLAYER_MARGIN_PX,
      right: 1280 - MINI_PLAYER_MARGIN_PX,
      bottom: 720 - MINI_PLAYER_MARGIN_PX,
    });

    const tv = computeMiniPlayerBounds(
      1920,
      1080,
      { top: 0, right: 0, bottom: 0, left: 0 },
      { x: 40, y: 24 },
      false,
    );
    expect(tv).toEqual({
      left: 56,
      top: 40,
      right: 1920 - 56,
      bottom: 1080 - 40,
    });

    const portraitPhone = computeMiniPlayerBounds(
      393,
      852,
      { top: 44, right: 0, bottom: 34, left: 0 },
      { x: 0, y: 0 },
      true,
    );
    expect(portraitPhone).toEqual({
      left: 16,
      top: 60,
      right: 377,
      bottom: 852 - 16 - PORTRAIT_BOTTOM_TAB_CLEARANCE_PX - 34,
    });
  });

  it('clamps 16:9 mini-player width to [240, min(640, round(viewportWidth * 0.55))]', () => {
    expect(clampMiniPlayerWidth(100, 1280, 720, false)).toBe(MINI_PLAYER_MIN_WIDTH);
    expect(clampMiniPlayerWidth(900, 1280, 720, false)).toBe(MINI_PLAYER_MAX_WIDTH);
    expect(clampMiniPlayerWidth(500, 800, 600, false)).toBe(440);
    expect(clampMiniPlayerWidth(360, 1280, 720, false)).toBe(360);
    expect(clampMiniPlayerWidth(Number.NaN, 1280, 720, false)).toBe(MINI_PLAYER_MIN_WIDTH);
    expect(miniPlayerHeightForWidth(320)).toBe(180);
    expect(miniPlayerHeightForWidth(640)).toBe(360);
  });

  it('computes exact corner positions inside bounds for all 4 corners', () => {
    const bounds = { left: 16, top: 16, right: 1264, bottom: 704 };
    const width = 320;
    const height = 180;

    expect(computeCornerPosition('top-left', width, height, bounds)).toEqual({ left: 16, top: 16 });
    expect(computeCornerPosition('top-right', width, height, bounds)).toEqual({
      left: 944,
      top: 16,
    });
    expect(computeCornerPosition('bottom-left', width, height, bounds)).toEqual({
      left: 16,
      top: 524,
    });
    expect(computeCornerPosition('bottom-right', width, height, bounds)).toEqual({
      left: 944,
      top: 524,
    });
  });

  it('projects release velocity (vx * 120, vy * 120) and snaps to the nearest corner', () => {
    const bounds = { left: 16, top: 16, right: 1264, bottom: 704 };
    const width = 320;
    const height = 180;

    // Stationary near top-left
    expect(snapToNearestCorner(40, 30, 0, 0, width, height, bounds)).toBe('top-left');
    // Stationary near bottom-right
    expect(snapToNearestCorner(900, 500, 0, 0, width, height, bounds)).toBe('bottom-right');
    // Near center-left, flung strongly right + up -> snaps top-right
    expect(snapToNearestCorner(400, 260, 4, -2, width, height, bounds)).toBe('top-right');
    // Near center-right, flung strongly left + down -> snaps bottom-left
    expect(snapToNearestCorner(560, 280, -5, 3, width, height, bounds)).toBe('bottom-left');
  });

  it('anchors the resize grip on the inward-facing corner opposite the docked corner and computes drag width', () => {
    expect(inwardResizeCorner('bottom-right')).toBe('top-left');
    expect(inwardResizeCorner('bottom-left')).toBe('top-right');
    expect(inwardResizeCorner('top-right')).toBe('bottom-left');
    expect(inwardResizeCorner('top-left')).toBe('bottom-right');

    // Docked bottom-right: dragging inward grip left (dx < 0) grows width
    expect(computeResizedWidthFromDrag('bottom-right', 320, -80, 0)).toBe(400);
    // Docked bottom-left: dragging inward grip right (dx > 0) grows width
    expect(computeResizedWidthFromDrag('bottom-left', 320, 80, 0)).toBe(400);
    // Docked top-left: dragging inward grip down (dy > 0) grows width proportionally
    expect(computeResizedWidthFromDrag('top-left', 320, 0, 45)).toBe(400);
    // Docked top-right: dragging inward grip up (dy < 0) shrinks width
    expect(computeResizedWidthFromDrag('top-right', 320, 0, -45)).toBe(240);
  });

  it('maps all 8 resize edges and corners to exact OS CSS resize cursors', () => {
    const expected: Record<MiniPlayerResizeEdge, string> = {
      n: 'ns-resize',
      s: 'ns-resize',
      e: 'ew-resize',
      w: 'ew-resize',
      nw: 'nwse-resize',
      se: 'nwse-resize',
      ne: 'nesw-resize',
      sw: 'nesw-resize',
    };
    for (const [edge, cursor] of Object.entries(expected)) {
      expect(resizeCursorForEdge(edge as MiniPlayerResizeEdge)).toBe(cursor);
    }
  });

  it('computes 16:9 edge-resized bounds anchored to the opposite edge/corner across all 8 directions', () => {
    const start: MiniPlayerRect = { x: 400, y: 200, width: 320, height: 180 };
    const startRight = start.x + start.width;
    const startBottom = start.y + start.height;

    // East (+deltaX grows width, pins left)
    const e = computeEdgeResizedMiniBounds(start, 'e', 80, 12, DESKTOP_VP);
    expect(e).toEqual({ x: start.x, y: start.y, width: 400, height: 225 });

    // West (-deltaX grows width, pins right)
    const w = computeEdgeResizedMiniBounds(start, 'w', -80, -10, DESKTOP_VP);
    expect(w.width).toBe(400);
    expect(w.height).toBe(225);
    expect(w.x + w.width).toBe(startRight);
    expect(w.x).toBe(320);

    // South (+deltaY grows height/width in 16:9, pins top)
    const s = computeEdgeResizedMiniBounds(start, 's', 15, 45, DESKTOP_VP);
    expect(s.width).toBe(400);
    expect(s.height).toBe(225);
    expect(s.y).toBe(start.y);

    // North (-deltaY grows height/width in 16:9, pins bottom)
    const n = computeEdgeResizedMiniBounds(start, 'n', -15, -45, DESKTOP_VP);
    expect(n.width).toBe(400);
    expect(n.height).toBe(225);
    expect(n.y + n.height).toBe(startBottom);
    expect(n.y).toBe(155);

    // SE corner (+dx/+dy pins top-left)
    const se = computeEdgeResizedMiniBounds(start, 'se', 160, 20, DESKTOP_VP);
    expect(se).toEqual({ x: start.x, y: start.y, width: 480, height: 270 });

    // NW corner (-dx/-dy pins bottom-right)
    const nw = computeEdgeResizedMiniBounds(start, 'nw', -160, -10, DESKTOP_VP);
    expect(nw).toEqual({ x: 240, y: 110, width: 480, height: 270 });
    expect(nw.x + nw.width).toBe(startRight);
    expect(nw.y + nw.height).toBe(startBottom);

    // NE corner (+dx/-dy pins bottom-left)
    const ne = computeEdgeResizedMiniBounds(start, 'ne', 160, -10, DESKTOP_VP);
    expect(ne).toEqual({ x: start.x, y: 110, width: 480, height: 270 });
    expect(ne.x).toBe(start.x);
    expect(ne.y + ne.height).toBe(startBottom);

    // SW corner (-dx/+dy pins top-right)
    const sw = computeEdgeResizedMiniBounds(start, 'sw', -160, 10, DESKTOP_VP);
    expect(sw).toEqual({ x: 240, y: start.y, width: 480, height: 270 });
    expect(sw.x + sw.width).toBe(startRight);
    expect(sw.y).toBe(start.y);

    // Dominant Y axis on corner when |dy * 16/9| > |dx|
    const seDominantY = computeEdgeResizedMiniBounds(start, 'se', 10, 90, DESKTOP_VP);
    expect(seDominantY).toEqual({ x: start.x, y: start.y, width: 480, height: 270 });
  });

  it('clamps resized bounds to [minWidth, maxWidth] and strictly inside viewport safe-area insets', () => {
    const start: MiniPlayerRect = { x: 944, y: 524, width: 320, height: 180 };

    // Shrink below minWidth -> clamped to 240x135 while pinning opposite top-left on 'se'
    const shrunk = computeEdgeResizedMiniBounds(start, 'se', -500, -500, DESKTOP_VP);
    expect(shrunk).toEqual({ x: 944, y: 524, width: 240, height: 135 });

    // Grow past maxWidth from docked bottom-right -> clamped to 640x360 and stays inside 16px insets
    const expanded = computeEdgeResizedMiniBounds(start, 'nw', -1200, -1200, DESKTOP_VP);
    expect(expanded.width).toBe(640);
    expect(expanded.height).toBe(360);
    expect(expanded.x + expanded.width).toBe(1280 - MINI_PLAYER_MARGIN_PX);
    expect(expanded.y + expanded.height).toBe(720 - MINI_PLAYER_MARGIN_PX);

    // Growing outward past screen right/bottom edge keeps mini-player inside viewport bounds
    const pushedIn = computeEdgeResizedMiniBounds(start, 'se', 400, 400, {
      ...DESKTOP_VP,
      safeArea: { top: 20, right: 12, bottom: 24, left: 8 },
    });
    const bounds = computeMiniPlayerBounds(
      1280,
      720,
      { top: 20, right: 12, bottom: 24, left: 8 },
      { x: 0, y: 0 },
      false,
    );
    expect(pushedIn.width).toBe(640);
    expect(pushedIn.height).toBe(360);
    expect(pushedIn.x).toBeGreaterThanOrEqual(bounds.left);
    expect(pushedIn.y).toBeGreaterThanOrEqual(bounds.top);
    expect(pushedIn.x + pushedIn.width).toBeLessThanOrEqual(bounds.right);
    expect(pushedIn.y + pushedIn.height).toBeLessThanOrEqual(bounds.bottom);

    // Non-finite deltas degrade safely without NaN
    const nanSafe = computeEdgeResizedMiniBounds(
      start,
      'w',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      DESKTOP_VP,
    );
    expect(nanSafe).toEqual(start);
  });
});
