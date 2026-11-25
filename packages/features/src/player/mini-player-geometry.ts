/** Docked screen corner for the floating in-app mini-player. */
export type MiniPlayerCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Safe-area insets honored when positioning the floating mini-player. */
export interface MiniPlayerSafeArea {
  readonly top?: number;
  readonly right: number;
  readonly bottom: number;
  readonly left?: number;
}

/** TV overscan margins honored when positioning the floating mini-player. */
export interface MiniPlayerOverscan {
  readonly x: number;
  readonly y: number;
}

/** Usable inner screen rectangle inside margins, safe-area insets, and overscan. */
export interface MiniPlayerBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Top-left pixel coordinates of the floating mini-player container. */
export interface MiniPlayerPosition {
  readonly left: number;
  readonly top: number;
}

/** Standard edge margin padding inside safe bounds. */
export const MINI_PLAYER_MARGIN_PX = 16;

/** Extra bottom clearance on portrait phones so the mini-player never obscures bottom tabs. */
export const PORTRAIT_BOTTOM_TAB_CLEARANCE_PX = 68;

/** Minimum 16:9 width for the resizable mini-player. */
export const MINI_PLAYER_MIN_WIDTH = 240;

/** Maximum 16:9 width cap for the resizable mini-player. */
export const MINI_PLAYER_MAX_WIDTH = 640;

/** Maximum fraction of viewport width the mini-player may occupy. */
const MINI_PLAYER_MAX_VIEWPORT_RATIO = 0.55;

/** Velocity projection window in milliseconds used for corner snapping on drag release. */
const MINI_PLAYER_VELOCITY_PROJECTION_MS = 120;

/** Pointer movement threshold (px) above which a mini-player drag suppresses click-to-expand. */
export const MINI_PLAYER_DRAG_THRESHOLD_PX = 5;

/** Corner-snap transition duration (ms) when motion is not reduced. */
export const MINI_PLAYER_SNAP_DURATION_MS = 240;

const ALL_CORNERS: readonly MiniPlayerCorner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

/**
 * Computes the usable safe inner rectangle for the floating mini-player,
 * honoring `16px` edge padding, safe-area insets, TV overscan, and portrait phone tab clearance.
 */
export function computeMiniPlayerBounds(
  viewportWidth: number,
  viewportHeight: number,
  safeArea: MiniPlayerSafeArea,
  overscan: MiniPlayerOverscan,
  isPortraitPhone: boolean,
): MiniPlayerBounds {
  const safeW = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const safeH = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720;
  const insetLeft = Math.max(0, safeArea.left ?? 0);
  const insetTop = Math.max(0, safeArea.top ?? 0);
  const insetRight = Math.max(0, safeArea.right);
  const insetBottom = Math.max(0, safeArea.bottom);
  const overscanX = Math.max(0, overscan.x);
  const overscanY = Math.max(0, overscan.y);
  const tabClearance = isPortraitPhone ? PORTRAIT_BOTTOM_TAB_CLEARANCE_PX : 0;

  const left = MINI_PLAYER_MARGIN_PX + insetLeft + overscanX;
  const top = MINI_PLAYER_MARGIN_PX + insetTop + overscanY;
  const right = Math.max(left, safeW - MINI_PLAYER_MARGIN_PX - insetRight - overscanX);
  const bottom = Math.max(
    top,
    safeH - MINI_PLAYER_MARGIN_PX - tabClearance - insetBottom - overscanY,
  );
  return { left, top, right, bottom };
}

/** Returns the `16:9` locked height for a given mini-player width. */
export function miniPlayerHeightForWidth(width: number): number {
  return Math.round((width * 9) / 16);
}

/**
 * Clamps a requested `16:9` mini-player width to `[240, min(640, round(viewportWidth * 0.55))]`
 * while also ensuring the resulting `16:9` height stays within the viewport.
 */
export function clampMiniPlayerWidth(
  width: number,
  viewportWidth: number,
  viewportHeight: number,
  _isTv: boolean,
): number {
  const safeW = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const safeH = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720;
  const maxByViewportWidth = Math.min(
    MINI_PLAYER_MAX_WIDTH,
    Math.round(safeW * MINI_PLAYER_MAX_VIEWPORT_RATIO),
  );
  const maxByViewportHeight = Math.round((safeH * 0.75 * 16) / 9);
  const maxWidth = Math.max(
    MINI_PLAYER_MIN_WIDTH,
    Math.min(maxByViewportWidth, maxByViewportHeight),
  );
  const requested = Number.isFinite(width) ? Math.round(width) : MINI_PLAYER_MIN_WIDTH;
  return Math.max(MINI_PLAYER_MIN_WIDTH, Math.min(maxWidth, requested));
}

/** Computes exact `(left, top)` coordinates for docking the mini-player in `corner`. */
export function computeCornerPosition(
  corner: MiniPlayerCorner,
  width: number,
  height: number,
  bounds: MiniPlayerBounds,
): MiniPlayerPosition {
  const isLeft = corner === 'top-left' || corner === 'bottom-left';
  const isTop = corner === 'top-left' || corner === 'top-right';
  return {
    left: isLeft ? bounds.left : Math.max(bounds.left, bounds.right - width),
    top: isTop ? bounds.top : Math.max(bounds.top, bounds.bottom - height),
  };
}

/**
 * Projects release velocity (`vx * 120`, `vy * 120`) and returns the nearest of the 4 screen corners.
 */
export function snapToNearestCorner(
  left: number,
  top: number,
  velocityX: number,
  velocityY: number,
  width: number,
  height: number,
  bounds: MiniPlayerBounds,
): MiniPlayerCorner {
  const safeVx = Number.isFinite(velocityX) ? velocityX : 0;
  const safeVy = Number.isFinite(velocityY) ? velocityY : 0;
  const projLeft = left + safeVx * MINI_PLAYER_VELOCITY_PROJECTION_MS;
  const projTop = top + safeVy * MINI_PLAYER_VELOCITY_PROJECTION_MS;

  let bestCorner: MiniPlayerCorner = 'bottom-right';
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (const corner of ALL_CORNERS) {
    const target = computeCornerPosition(corner, width, height, bounds);
    const dx = projLeft - target.left;
    const dy = projTop - target.top;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestCorner = corner;
    }
  }

  return bestCorner;
}

/** Returns the inward-facing corner opposite `corner` where the resize grip should anchor. */
export function inwardResizeCorner(corner: MiniPlayerCorner): MiniPlayerCorner {
  switch (corner) {
    case 'bottom-right':
      return 'top-left';
    case 'bottom-left':
      return 'top-right';
    case 'top-right':
      return 'bottom-left';
    case 'top-left':
      return 'bottom-right';
  }
}

/** Converts a pointer drag delta `(dx, dy)` on the inward resize grip into a target width. */
export function computeResizedWidthFromDrag(
  dockedCorner: MiniPlayerCorner,
  startWidth: number,
  dx: number,
  dy: number,
): number {
  const xSign = dockedCorner === 'bottom-right' || dockedCorner === 'top-right' ? -1 : 1;
  const ySign = dockedCorner === 'bottom-right' || dockedCorner === 'bottom-left' ? -1 : 1;
  const deltaFromX = xSign * dx;
  const deltaFromY = (ySign * dy * 16) / 9;
  const deltaW = Math.abs(deltaFromX) >= Math.abs(deltaFromY) ? deltaFromX : deltaFromY;
  return Math.round(startWidth + deltaW);
}
