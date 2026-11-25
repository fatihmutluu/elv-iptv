import {
  computeSafeAimTriangle,
  isPointInRect,
  isPointInTriangle,
  type Point,
  type RectLike,
} from '../safe-hover-geometry';

describe('safe-hover-geometry', () => {
  describe('isPointInRect', () => {
    const rect: RectLike = { left: 100, top: 50, width: 80, height: 120 };

    it('returns true for interior and boundary points', () => {
      expect(isPointInRect({ x: 140, y: 110 }, rect)).toBe(true);
      expect(isPointInRect({ x: 100, y: 50 }, rect)).toBe(true);
      expect(isPointInRect({ x: 180, y: 170 }, rect)).toBe(true);
    });

    it('returns false outside rect unless covered by margin', () => {
      expect(isPointInRect({ x: 95, y: 110 }, rect)).toBe(false);
      expect(isPointInRect({ x: 95, y: 110 }, rect, 10)).toBe(true);
      expect(isPointInRect({ x: 186, y: 176 }, rect, 5)).toBe(false);
      expect(isPointInRect({ x: 185, y: 175 }, rect, 5)).toBe(true);
    });

    it('rejects non-finite coordinates and invalid rects', () => {
      expect(isPointInRect({ x: Number.NaN, y: 100 }, rect)).toBe(false);
      expect(
        isPointInRect({ x: 120, y: 100 }, { left: 100, top: 50, width: -10, height: 50 }),
      ).toBe(false);
    });
  });

  describe('isPointInTriangle', () => {
    const a: Point = { x: 0, y: 0 };
    const b: Point = { x: 100, y: 0 };
    const c: Point = { x: 50, y: 100 };

    it('detects interior points regardless of vertex winding order', () => {
      expect(isPointInTriangle({ x: 50, y: 40 }, a, b, c)).toBe(true);
      expect(isPointInTriangle({ x: 50, y: 40 }, a, c, b)).toBe(true);
    });

    it('treats edges and vertices as inclusive', () => {
      expect(isPointInTriangle({ x: 50, y: 0 }, a, b, c)).toBe(true);
      expect(isPointInTriangle({ x: 25, y: 50 }, a, b, c)).toBe(true);
      expect(isPointInTriangle(a, a, b, c)).toBe(true);
      expect(isPointInTriangle(c, a, b, c)).toBe(true);
    });

    it('returns false for exterior points and degenerate collinear triangles', () => {
      expect(isPointInTriangle({ x: 50, y: -1 }, a, b, c)).toBe(false);
      expect(isPointInTriangle({ x: 10, y: 80 }, a, b, c)).toBe(false);
      expect(
        isPointInTriangle({ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }),
      ).toBe(false);
    });
  });

  describe('computeSafeAimTriangle', () => {
    const panel: RectLike = { left: 100, top: 100, width: 100, height: 100 };

    it('handles target below origin (e.g. player volume popover below button)', () => {
      const origin: Point = { x: 150, y: 60 };
      const tri = computeSafeAimTriangle(origin, panel, 12);
      expect(tri).not.toBeNull();
      if (!tri) return;

      // Point moving diagonally toward panel is inside the aim corridor
      expect(isPointInTriangle({ x: 120, y: 80 }, tri.a, tri.b, tri.c)).toBe(true);
      expect(isPointInTriangle({ x: 185, y: 85 }, tri.a, tri.b, tri.c)).toBe(true);
      // Point moving away (upward) or far horizontally is outside
      expect(isPointInTriangle({ x: 150, y: 40 }, tri.a, tri.b, tri.c)).toBe(false);
      expect(isPointInTriangle({ x: 250, y: 65 }, tri.a, tri.b, tri.c)).toBe(false);
    });

    it('handles target above origin', () => {
      const origin: Point = { x: 150, y: 240 };
      const tri = computeSafeAimTriangle(origin, panel, 12);
      expect(tri).not.toBeNull();
      if (!tri) return;

      expect(isPointInTriangle({ x: 130, y: 220 }, tri.a, tri.b, tri.c)).toBe(true);
      expect(isPointInTriangle({ x: 150, y: 260 }, tri.a, tri.b, tri.c)).toBe(false);
    });

    it('handles target to the right of origin', () => {
      const origin: Point = { x: 40, y: 150 };
      const tri = computeSafeAimTriangle(origin, panel, 12);
      expect(tri).not.toBeNull();
      if (!tri) return;

      expect(isPointInTriangle({ x: 75, y: 125 }, tri.a, tri.b, tri.c)).toBe(true);
      expect(isPointInTriangle({ x: 20, y: 150 }, tri.a, tri.b, tri.c)).toBe(false);
    });

    it('handles target to the left of origin', () => {
      const origin: Point = { x: 260, y: 150 };
      const tri = computeSafeAimTriangle(origin, panel, 12);
      expect(tri).not.toBeNull();
      if (!tri) return;

      expect(isPointInTriangle({ x: 230, y: 175 }, tri.a, tri.b, tri.c)).toBe(true);
      expect(isPointInTriangle({ x: 290, y: 150 }, tri.a, tri.b, tri.c)).toBe(false);
    });

    it('handles tight gaps where origin is closer than marginPx to panel edge', () => {
      const origin: Point = { x: 150, y: 98 };
      const tri = computeSafeAimTriangle(origin, panel, 12);
      expect(tri).not.toBeNull();
      if (!tri) return;

      expect(isPointInTriangle({ x: 150, y: 99 }, tri.a, tri.b, tri.c)).toBe(true);
      expect(isPointInTriangle({ x: 150, y: 80 }, tri.a, tri.b, tri.c)).toBe(false);
    });

    it('returns null for degenerate rects or when origin is already inside targetRect', () => {
      expect(computeSafeAimTriangle({ x: 150, y: 150 }, panel, 12)).toBeNull();
      expect(
        computeSafeAimTriangle({ x: 0, y: 0 }, { left: 10, top: 10, width: 0, height: 50 }),
      ).toBeNull();
      expect(computeSafeAimTriangle({ x: Number.NaN, y: 0 }, panel)).toBeNull();
    });
  });
});
