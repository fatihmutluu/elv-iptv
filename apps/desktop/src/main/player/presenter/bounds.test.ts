import { describe, expect, it } from 'vitest';
import {
  areaToScreen,
  countBuckets,
  cropInThumbnail,
  lockContentRectToAspect,
  macOwnWindowGeometry,
  resolveFullscreenRect,
} from './bounds.ts';

const area = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  visible: true,
});

describe('areaToScreen', () => {
  it('maps an area at zoom 1', () => {
    const content = { x: 100, y: 50, width: 1280, height: 720 };
    expect(areaToScreen(content, area(40, 40, 800, 450), 1)).toEqual({
      x: 140,
      y: 90,
      width: 800,
      height: 450,
    });
  });

  it('scales by the zoom factor and rounds', () => {
    const content = { x: 100, y: 50, width: 1280, height: 720 };
    expect(areaToScreen(content, area(10.4, 20.6, 100.5, 50.2), 1.25)).toEqual({
      x: 113,
      y: 76,
      width: 126,
      height: 63,
    });
  });

  it('keeps negative coordinates of a left-hand monitor', () => {
    const content = { x: -1920, y: -200, width: 1280, height: 720 };
    expect(areaToScreen(content, area(0.2, 0, 640, 360), 1)).toEqual({
      x: -1920,
      y: -200,
      width: 640,
      height: 360,
    });
    expect(
      Object.is(areaToScreen({ x: 0, y: 0, width: 1, height: 1 }, area(-0.4, -0.4, 1, 1), 1).x, 0),
    ).toBe(true);
  });

  it('clamps an empty area to 1x1', () => {
    const content = { x: 0, y: 0, width: 1280, height: 720 };
    expect(areaToScreen(content, area(10, 10, 0, 0), 1)).toEqual({
      x: 10,
      y: 10,
      width: 1,
      height: 1,
    });
    expect(areaToScreen(content, area(10, 10, -5, 0.2), 2)).toEqual({
      x: 20,
      y: 20,
      width: 1,
      height: 1,
    });
  });
});

describe('cropInThumbnail', () => {
  const display = { x: 0, y: 0, width: 2560, height: 1440 };
  const thumb = { width: 3840, height: 2160 };

  it('scales a DIP rect into the thumbnail pixels of its display', () => {
    expect(cropInThumbnail({ x: 140, y: 90, width: 800, height: 450 }, display, thumb)).toEqual({
      x: 210,
      y: 135,
      width: 1200,
      height: 675,
    });
  });

  it('uses the offset of a display left of the primary', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    expect(
      cropInThumbnail({ x: -1820, y: 100, width: 192, height: 108 }, left, {
        width: 1920,
        height: 1080,
      }),
    ).toEqual({ x: 100, y: 100, width: 192, height: 108 });
  });

  it('clips to the display, clamps crop >= 1x1 on sub-pixel edge overlap and returns null without overlap', () => {
    expect(cropInThumbnail({ x: 2500, y: 1400, width: 200, height: 200 }, display, thumb)).toEqual({
      x: 3750,
      y: 2100,
      width: 90,
      height: 60,
    });
    expect(cropInThumbnail({ x: 3000, y: 0, width: 10, height: 10 }, display, thumb)).toBeNull();
    expect(
      cropInThumbnail({ x: 10, y: 10, width: 100, height: 100 }, display, { width: 0, height: 0 }),
    ).toBeNull();
    // Sub-pixel overlap at far right/bottom edge previously rounded crop.x === thumb.width -> width 0
    const sliver = cropInThumbnail({ x: 2559.9, y: 1439.9, width: 10, height: 10 }, display, thumb);
    expect(sliver).not.toBeNull();
    expect(sliver?.width).toBeGreaterThanOrEqual(1);
    expect(sliver?.height).toBeGreaterThanOrEqual(1);
    expect((sliver?.x ?? 0) + (sliver?.width ?? 0)).toBeLessThanOrEqual(thumb.width);
    expect((sliver?.y ?? 0) + (sliver?.height ?? 0)).toBeLessThanOrEqual(thumb.height);
  });
});

describe('countBuckets', () => {
  it('counts distinct colours in 5-bit buckets of a BGRA bitmap', () => {
    const bgra = Uint8Array.from([
      0, 0, 0, 255, 7, 7, 7, 255, 8, 0, 0, 255, 0, 8, 0, 255, 0, 0, 8, 255, 255, 255, 255, 0,
    ]);
    expect(countBuckets(bgra)).toBe(5);
  });

  it('is zero for an empty bitmap', () => {
    expect(countBuckets(new Uint8Array(0))).toBe(0);
  });
});

describe('macOwnWindowGeometry', () => {
  it('maps screen points into backing pixels top-down from display workArea', () => {
    const workArea = { x: 0, y: 30, width: 2056, height: 1299 };
    expect(macOwnWindowGeometry({ x: 200, y: 400, width: 800, height: 450 }, workArea, 2)).toEqual({
      x: 400,
      y: 740,
      width: 1600,
      height: 900,
    });
  });

  it('keeps 1x points relative to workArea on a non-Retina or secondary display', () => {
    const workArea = { x: -1920, y: 25, width: 1920, height: 1055 };
    expect(
      macOwnWindowGeometry({ x: -1820, y: 125, width: 640, height: 360 }, workArea, 1),
    ).toEqual({
      x: 100,
      y: 100,
      width: 640,
      height: 360,
    });
  });
});

describe('resolveFullscreenRect', () => {
  const notchedDisplay = {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 37, width: 1512, height: 945 },
  };

  it('keeps safe-area geometry strictly within display.workArea to respect the notch (#269)', () => {
    expect(resolveFullscreenRect({ x: 0, y: 0, width: 1512, height: 982 }, notchedDisplay)).toEqual(
      notchedDisplay.workArea,
    );
    expect(
      resolveFullscreenRect({ x: 0, y: 0, width: 1000, height: 982 }, notchedDisplay, 'safe-area'),
    ).toEqual({ x: 0, y: 37, width: 1000, height: 945 });
    expect(
      resolveFullscreenRect(
        { x: 2000, y: 0, width: 400, height: 300 },
        notchedDisplay,
        'safe-area',
      ),
    ).toEqual(notchedDisplay.workArea);
  });

  it('spans full display.bounds in desktop mode (#269)', () => {
    expect(
      resolveFullscreenRect({ x: 0, y: 37, width: 1512, height: 945 }, notchedDisplay, 'desktop'),
    ).toEqual(notchedDisplay.bounds);
  });
});

describe('lockContentRectToAspect (#332)', () => {
  const minSize = { width: 800, height: 500 };

  it('snaps width and height to physical pixel grid with zero 1px letterbox mismatch at 100%, 125%, 150%, and 200% DPI', () => {
    const scaleFactors = [1.0, 1.25, 1.5, 2.0];
    const aspects = [16 / 9, 4 / 3, 21 / 9, 2.39];
    const sampleWidths = [900, 960, 1000, 1024, 1111, 1280, 1366, 1440, 1600];

    for (const scale of scaleFactors) {
      for (const dar of aspects) {
        for (const w of sampleWidths) {
          const locked = lockContentRectToAspect(
            { x: 100, y: 80, width: w, height: 700 },
            dar,
            scale,
            minSize,
            'width',
          );
          expect(locked.width).toBeGreaterThanOrEqual(minSize.width);
          expect(locked.height).toBeGreaterThanOrEqual(minSize.height);
          const physW = Math.round(locked.width * scale);
          const physH = Math.round(locked.height * scale);
          expect(Math.round(physW / dar)).toBe(physH);
          expect(Math.round(physH * dar)).toBe(physW);
        }
      }
    }
  });

  it('respects minContentSize when width-driven height would drop below minContentSize.height', () => {
    for (const scale of [1.0, 1.25, 1.5, 2.0]) {
      const locked = lockContentRectToAspect(
        { x: 40, y: 50, width: 800, height: 450 },
        16 / 9,
        scale,
        minSize,
        'width',
      );
      expect(locked.width).toBeGreaterThanOrEqual(minSize.width);
      expect(locked.height).toBeGreaterThanOrEqual(minSize.height);
      const physW = Math.round(locked.width * scale);
      const physH = Math.round(locked.height * scale);
      expect(Math.round(physW / (16 / 9))).toBe(physH);
      expect(Math.round(physH * (16 / 9))).toBe(physW);
    }
  });

  it('supports height-driven resizing (preferredAxis = height) across all HiDPI scale factors', () => {
    for (const scale of [1.0, 1.25, 1.5, 2.0]) {
      const locked = lockContentRectToAspect(
        { x: 10, y: 20, width: 1200, height: 615 },
        16 / 9,
        scale,
        minSize,
        'height',
      );
      expect(locked.width).toBeGreaterThanOrEqual(minSize.width);
      expect(locked.height).toBeGreaterThanOrEqual(minSize.height);
      const physW = Math.round(locked.width * scale);
      const physH = Math.round(locked.height * scale);
      expect(Math.round(physW / (16 / 9))).toBe(physH);
      expect(Math.round(physH * (16 / 9))).toBe(physW);
    }
  });

  it('clamps to minContentSize without locking when aspectRatio is non-positive or non-finite', () => {
    expect(
      lockContentRectToAspect({ x: 5, y: 10, width: 600, height: 400 }, 0, 1.5, minSize),
    ).toEqual({
      x: 5,
      y: 10,
      width: 800,
      height: 500,
    });
    expect(
      lockContentRectToAspect({ x: 5, y: 10, width: 950, height: 620 }, Number.NaN, 1.25, minSize),
    ).toEqual({
      x: 5,
      y: 10,
      width: 950,
      height: 620,
    });
  });
});
