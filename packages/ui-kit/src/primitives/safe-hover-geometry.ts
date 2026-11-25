/** 2D viewport coordinate used by safe-hover aim corridor calculations. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Minimal DOMRect-compatible axis-aligned rectangle. */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Three-vertex triangle defining a pointer safe-aim corridor. */
export interface Triangle {
  readonly a: Point;
  readonly b: Point;
  readonly c: Point;
}

const EPSILON = 1e-6;
const DEFAULT_MARGIN_PX = 12;

function isFinitePoint(pt: Point): boolean {
  return Number.isFinite(pt.x) && Number.isFinite(pt.y);
}

function isValidRect(rect: RectLike): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

function cross2d(p1: Point, p2: Point, p3: Point): number {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

/**
 * Returns `true` when `pt` lies inside or on the boundary of `rect` expanded by `margin` pixels.
 */
export function isPointInRect(pt: Point, rect: RectLike, margin = 0): boolean {
  if (!isFinitePoint(pt) || !isValidRect(rect)) return false;
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
  const left = rect.left - safeMargin;
  const right = rect.left + rect.width + safeMargin;
  const top = rect.top - safeMargin;
  const bottom = rect.top + rect.height + safeMargin;
  return pt.x >= left && pt.x <= right && pt.y >= top && pt.y <= bottom;
}

/**
 * Returns `true` when `pt` lies inside or on the boundary of triangle `(a, b, c)`,
 * regardless of vertex winding order. Degenerate (zero-area) triangles return `false`.
 */
export function isPointInTriangle(pt: Point, a: Point, b: Point, c: Point): boolean {
  if (!isFinitePoint(pt) || !isFinitePoint(a) || !isFinitePoint(b) || !isFinitePoint(c)) {
    return false;
  }
  const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  if (area2 <= EPSILON) return false;

  const d1 = cross2d(pt, a, b);
  const d2 = cross2d(pt, b, c);
  const d3 = cross2d(pt, c, a);

  const hasNeg = d1 < -EPSILON || d2 < -EPSILON || d3 < -EPSILON;
  const hasPos = d1 > EPSILON || d2 > EPSILON || d3 > EPSILON;
  return !(hasNeg && hasPos);
}

/**
 * Builds an Amazon-style safe-hover aim triangle from pointer exit coordinate `origin` to the
 * two furthest-angle silhouette corners of `targetRect` (expanded by `marginPx`, default `12px`).
 * Automatically handles targets positioned below, above, left, right, or diagonally from `origin`.
 * Returns `null` when `targetRect` has zero area or `origin` is already inside `targetRect`.
 */
export function computeSafeAimTriangle(
  origin: Point,
  targetRect: RectLike,
  marginPx = DEFAULT_MARGIN_PX,
): Triangle | null {
  if (
    !isFinitePoint(origin) ||
    !isValidRect(targetRect) ||
    targetRect.width <= 0 ||
    targetRect.height <= 0
  ) {
    return null;
  }
  if (isPointInRect(origin, targetRect, 0)) {
    return null;
  }

  const margin = Number.isFinite(marginPx) ? Math.max(0, marginPx) : DEFAULT_MARGIN_PX;
  const rectRight = targetRect.left + targetRect.width;
  const rectBottom = targetRect.top + targetRect.height;

  // Clamp expansion on the side facing `origin` so tight trigger-to-panel gaps stay outside the rect.
  const left =
    origin.x < targetRect.left
      ? Math.max(origin.x + 1, targetRect.left - margin)
      : targetRect.left - margin;
  const right =
    origin.x > rectRight ? Math.min(origin.x - 1, rectRight + margin) : rectRight + margin;
  const top =
    origin.y < targetRect.top
      ? Math.max(origin.y + 1, targetRect.top - margin)
      : targetRect.top - margin;
  const bottom =
    origin.y > rectBottom ? Math.min(origin.y - 1, rectBottom + margin) : rectBottom + margin;

  const tl: Point = { x: left, y: top };
  const tr: Point = { x: right, y: top };
  const bl: Point = { x: left, y: bottom };
  const br: Point = { x: right, y: bottom };
  const corners: readonly [Point, Point, Point, Point] = [tl, tr, bl, br];

  let bestAngle = -1;
  let bestPair: readonly [Point, Point] = [tl, tr];

  for (let i = 0; i < corners.length; i += 1) {
    const u = corners[i];
    if (!u) continue;
    const ux = u.x - origin.x;
    const uy = u.y - origin.y;
    for (let j = i + 1; j < corners.length; j += 1) {
      const v = corners[j];
      if (!v) continue;
      const vx = v.x - origin.x;
      const vy = v.y - origin.y;
      const cross = Math.abs(ux * vy - uy * vx);
      const dot = ux * vx + uy * vy;
      const angle = Math.atan2(cross, dot);
      if (angle > bestAngle) {
        bestAngle = angle;
        bestPair = [u, v];
      }
    }
  }

  if (bestAngle <= EPSILON) return null;
  return { a: origin, b: bestPair[0], c: bestPair[1] };
}
