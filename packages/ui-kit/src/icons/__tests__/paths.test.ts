import { ICON_NAMES, ICON_PATHS, type IconName, type IconShape } from '../paths';

const EXPECTED_ICON_NAMES: readonly IconName[] = [
  'home',
  'tv',
  'film',
  'series',
  'search',
  'settings',
  'layers',
  'play',
  'pause',
  'plus',
  'check',
  'info',
  'like',
  'dislike',
  'download',
  'subtitles',
  'audio',
  'speed',
  'aspect',
  'dots',
  'close',
  'back',
  'chevronRight',
  'skipBack',
  'skipForward',
  'lock',
  'list',
  'bell',
  'prevChannel',
  'keypad',
  'profile',
  'sources',
  'refresh',
  'trash',
  'warning',
  'volumeMute',
  'fullscreen',
  'fullscreenExit',
  'star',
  'starFilled',
  'chevronLeft',
  'chevronDown',
  'pin',
  'skipBack10',
  'skipForward10',
  'moon',
  'chapters',
  'skipPrev',
  'skipNext',
  'pip',
  'multiview',
  'miniplayer',
  'popout',
  'dock',
  'library',
  'likeFilled',
  'dislikeFilled',
  'bookmark',
  'bookmarkFilled',
  'ban',
];

const FILLED_ICONS: ReadonlySet<IconName> = new Set([
  'play',
  'pause',
  'dots',
  'keypad',
  'starFilled',
  'skipPrev',
  'skipNext',
  'likeFilled',
  'dislikeFilled',
  'bookmarkFilled',
]);

function assertValidShape(shape: IconShape): void {
  if (shape.fill !== undefined) {
    expect(['currentColor', 'none']).toContain(shape.fill);
  }
  if (shape.strokeWidth !== undefined) {
    expect(Number.isFinite(shape.strokeWidth)).toBe(true);
    expect(shape.strokeWidth).toBeGreaterThan(0);
  }

  switch (shape.kind) {
    case 'path':
      expect(typeof shape.d).toBe('string');
      expect(shape.d.trim().length).toBeGreaterThan(0);
      expect(shape.d.trim()).toMatch(/^[Mm]/);
      return;
    case 'circle':
      expect(Number.isFinite(shape.cx)).toBe(true);
      expect(Number.isFinite(shape.cy)).toBe(true);
      expect(Number.isFinite(shape.r)).toBe(true);
      expect(shape.r).toBeGreaterThan(0);
      return;
    case 'rect':
      expect(Number.isFinite(shape.x)).toBe(true);
      expect(Number.isFinite(shape.y)).toBe(true);
      expect(Number.isFinite(shape.width)).toBe(true);
      expect(shape.width).toBeGreaterThan(0);
      expect(Number.isFinite(shape.height)).toBe(true);
      expect(shape.height).toBeGreaterThan(0);
      if (shape.rx !== undefined) {
        expect(Number.isFinite(shape.rx)).toBe(true);
        expect(shape.rx).toBeGreaterThanOrEqual(0);
      }
      return;
  }
}

describe('ICON_PATHS', () => {
  it('lists every expected IconName in ICON_NAMES without duplicates', () => {
    const uniqueNames = new Set(ICON_NAMES);
    expect(uniqueNames.size).toBe(ICON_NAMES.length);
    expect(ICON_NAMES.length).toBe(EXPECTED_ICON_NAMES.length);
    expect([...ICON_NAMES].sort()).toEqual([...EXPECTED_ICON_NAMES].sort());
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it('defines a valid 24x24 IconSpec with valid shapes for every IconName', () => {
    for (const name of ICON_NAMES) {
      expect(Object.hasOwn(ICON_PATHS, name)).toBe(true);
      const spec = ICON_PATHS[name];
      expect(spec.viewBox).toBe('0 0 24 24');
      expect(spec.shapes.length).toBeGreaterThan(0);

      for (const shape of spec.shapes) {
        assertValidShape(shape);
        if (FILLED_ICONS.has(name)) {
          expect(shape.fill).toBe('currentColor');
        }
      }

      if (FILLED_ICONS.has(name)) {
        expect(spec.filled).toBe(true);
      } else {
        expect(spec.filled).toBeUndefined();
      }
    }
  });

  it('keeps multi-shape and custom stroke-width icons faithful', () => {
    expect(ICON_PATHS.keypad.shapes).toHaveLength(9);
    expect(ICON_PATHS.dots.shapes).toHaveLength(3);
    expect(ICON_PATHS.search.shapes[0]?.strokeWidth).toBe(1.9);
    expect(ICON_PATHS.check.shapes[0]?.strokeWidth).toBe(2.2);
    expect(ICON_PATHS.skipBack.shapes[0]?.strokeWidth).toBe(1.7);
    expect(ICON_PATHS.skipForward.shapes[0]?.strokeWidth).toBe(1.7);
  });

  it('defines crisp Wave C1 player cinema icons using only pure vector shapes', () => {
    for (const name of [
      'skipBack10',
      'skipForward10',
      'moon',
      'chapters',
      'skipPrev',
      'skipNext',
    ] as const) {
      const spec = ICON_PATHS[name];
      expect(spec.viewBox).toBe('0 0 24 24');
      for (const shape of spec.shapes) {
        expect(['path', 'circle', 'rect']).toContain(shape.kind);
      }
    }

    // skipBack10 & skipForward10 combine outer arc + arrowhead + pure-vector "1" and "0" shapes.
    expect(ICON_PATHS.skipBack10.shapes.length).toBeGreaterThanOrEqual(4);
    expect(ICON_PATHS.skipForward10.shapes.length).toBeGreaterThanOrEqual(4);
    expect(ICON_PATHS.skipBack10.shapes.some((shape) => shape.kind === 'rect')).toBe(true);
    expect(ICON_PATHS.skipForward10.shapes.some((shape) => shape.kind === 'rect')).toBe(true);
    expect(ICON_PATHS.skipBack10.filled).toBeUndefined();
    expect(ICON_PATHS.skipForward10.filled).toBeUndefined();

    // moon & chapters are crisp stroke icons.
    expect(ICON_PATHS.moon.shapes.length).toBeGreaterThanOrEqual(1);
    expect(ICON_PATHS.moon.filled).toBeUndefined();
    expect(ICON_PATHS.chapters.shapes.length).toBeGreaterThanOrEqual(2);
    expect(ICON_PATHS.chapters.filled).toBeUndefined();

    // skipPrev & skipNext match play/pause filled transport style with bar + triangle.
    expect(ICON_PATHS.skipPrev.filled).toBe(true);
    expect(ICON_PATHS.skipNext.filled).toBe(true);
    expect(ICON_PATHS.skipPrev.shapes.length).toBeGreaterThanOrEqual(2);
    expect(ICON_PATHS.skipNext.shapes.length).toBeGreaterThanOrEqual(2);
  });

  it('defines crisp Wave F6 stroke icons for pip, multiview, miniplayer, popout, and dock', () => {
    for (const name of ['pip', 'multiview', 'miniplayer', 'popout', 'dock'] as const) {
      const spec = ICON_PATHS[name];
      expect(spec.viewBox).toBe('0 0 24 24');
      expect(spec.filled).toBeUndefined();
      expect(spec.shapes.length).toBeGreaterThanOrEqual(2);
    }
    expect(ICON_PATHS.multiview.shapes).toHaveLength(4);
  });

  it('defines crisp Wave R1 bookmark, bookmarkFilled, and ban icons', () => {
    expect(ICON_PATHS.bookmark.viewBox).toBe('0 0 24 24');
    expect(ICON_PATHS.bookmark.filled).toBeUndefined();
    expect(ICON_PATHS.bookmark.shapes.length).toBeGreaterThanOrEqual(1);

    expect(ICON_PATHS.bookmarkFilled.viewBox).toBe('0 0 24 24');
    expect(ICON_PATHS.bookmarkFilled.filled).toBe(true);
    expect(ICON_PATHS.bookmarkFilled.shapes.length).toBeGreaterThanOrEqual(1);
    expect(ICON_PATHS.bookmarkFilled.shapes[0]?.fill).toBe('currentColor');

    expect(ICON_PATHS.ban.viewBox).toBe('0 0 24 24');
    expect(ICON_PATHS.ban.filled).toBeUndefined();
    expect(ICON_PATHS.ban.shapes.length).toBeGreaterThanOrEqual(2);
    expect(ICON_PATHS.ban.shapes.some((shape) => shape.kind === 'circle')).toBe(true);
  });
});
