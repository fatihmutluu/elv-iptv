import { describe, expect, it } from 'vitest';
import {
  clampMiniPlayerWidth,
  computeCornerPosition,
  computeMiniPlayerBounds,
  computeResizedWidthFromDrag,
  inwardResizeCorner,
  MINI_PLAYER_MARGIN_PX,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_WIDTH,
  miniPlayerHeightForWidth,
  PORTRAIT_BOTTOM_TAB_CLEARANCE_PX,
  snapToNearestCorner,
} from './mini-player-geometry';

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
});
