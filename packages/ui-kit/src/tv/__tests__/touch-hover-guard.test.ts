import { createTouchHoverGuard } from '../index';

describe('createTouchHoverGuard (#139)', () => {
  it('suppresses hover events within the default 600ms window after a touch and clears afterward', () => {
    const guard = createTouchHoverGuard();
    expect(guard.shouldIgnoreHover(1000)).toBe(false);

    guard.recordTouch(1000);
    expect(guard.shouldIgnoreHover(1000)).toBe(true);
    expect(guard.shouldIgnoreHover(1300)).toBe(true);
    expect(guard.shouldIgnoreHover(1599)).toBe(true);
    expect(guard.shouldIgnoreHover(1600)).toBe(false);
    expect(guard.shouldIgnoreHover(2000)).toBe(false);
  });

  it('respects custom windows and reset()', () => {
    const guard = createTouchHoverGuard(250);
    guard.recordTouch(500);
    expect(guard.shouldIgnoreHover(749)).toBe(true);
    expect(guard.shouldIgnoreHover(750)).toBe(false);

    guard.recordTouch(1000);
    expect(guard.shouldIgnoreHover(1100)).toBe(true);
    guard.reset();
    expect(guard.shouldIgnoreHover(1100)).toBe(false);
  });

  it('resets and returns false on non-monotonic timestamps', () => {
    const guard = createTouchHoverGuard(600);
    guard.recordTouch(2000);
    expect(guard.shouldIgnoreHover(1999)).toBe(false);
    // Because state was reset on non-monotonic clock jump, a later timestamp is also not ignored
    expect(guard.shouldIgnoreHover(2100)).toBe(false);
  });

  it('always returns false when windowMs <= 0', () => {
    for (const windowMs of [0, -1, -600, Number.NaN]) {
      const guard = createTouchHoverGuard(windowMs);
      guard.recordTouch(1000);
      expect(guard.shouldIgnoreHover(1000)).toBe(false);
      expect(guard.shouldIgnoreHover(1001)).toBe(false);
    }
  });
});
