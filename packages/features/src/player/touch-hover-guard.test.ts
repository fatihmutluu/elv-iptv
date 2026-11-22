import { describe, expect, it, vi } from 'vitest';
import {
  buildTouchHoverProps,
  createTouchHoverGuard,
  DEFAULT_POINTER_DEADZONE_PX,
  DEFAULT_TOUCH_HOVER_SUPPRESS_MS,
} from './touch-hover-guard';

describe('createTouchHoverGuard', () => {
  it('allows mouse/unknown hover before any touch, and always blocks pointerType === "touch"', () => {
    const now = 1_000;
    const guard = createTouchHoverGuard({ now: () => now });

    expect(DEFAULT_TOUCH_HOVER_SUPPRESS_MS).toBe(500);
    expect(guard.shouldAllowHover('mouse')).toBe(true);
    expect(guard.shouldAllowHover('pen')).toBe(true);
    expect(guard.shouldAllowHover(undefined)).toBe(true);
    expect(guard.shouldAllowHover('touch')).toBe(false);
    expect(guard.shouldAllowHover('TOUCH')).toBe(false);
  });

  it('suppresses hover for suppressMs after markTouch() and re-allows at >= suppressMs', () => {
    let now = 0;
    const guard = createTouchHoverGuard({ now: () => now });

    guard.markTouch();
    expect(guard.shouldAllowHover('mouse')).toBe(false);
    expect(guard.shouldAllowHover(undefined)).toBe(false);

    now = 499;
    expect(guard.shouldAllowHover('mouse')).toBe(false);

    now = 500;
    expect(guard.shouldAllowHover('mouse')).toBe(true);
    expect(guard.shouldAllowHover('touch')).toBe(false);
  });

  it('is resilient to backwards clock jumps via monotonic floor guard and supports custom suppressMs', () => {
    let now = 2_000;
    const guard = createTouchHoverGuard({ now: () => now }, 250);

    guard.markTouch();
    now = 2_100;
    expect(guard.shouldAllowHover('mouse')).toBe(false);

    // Backwards clock jump must not break suppression window
    now = 1_000;
    expect(guard.shouldAllowHover('mouse')).toBe(false);

    now = 2_249;
    expect(guard.shouldAllowHover('mouse')).toBe(false);

    now = 2_250;
    expect(guard.shouldAllowHover('mouse')).toBe(true);

    // Backwards jump after expiry must not re-suppress
    now = 2_050;
    expect(guard.shouldAllowHover('mouse')).toBe(true);
  });

  it('extracts pointerType across RN/web events in buildTouchHoverProps', () => {
    const onTouch = vi.fn();
    const onHover = vi.fn();
    const props = buildTouchHoverProps(onTouch, onHover) as {
      onTouchStart: () => void;
      onPointerMove: (e?: unknown) => void;
      onMouseMove: (e?: unknown) => void;
    };

    props.onTouchStart();
    expect(onTouch).toHaveBeenCalledTimes(1);

    props.onPointerMove({ nativeEvent: { pointerType: 'touch' } });
    expect(onTouch).toHaveBeenCalledTimes(2);
    expect(onHover).toHaveBeenCalledWith('touch');

    props.onPointerMove({ pointerType: 'mouse' });
    expect(onHover).toHaveBeenLastCalledWith('mouse');

    props.onMouseMove({});
    expect(onHover).toHaveBeenLastCalledWith('mouse');

    props.onPointerMove({ nativeEvent: { pointerType: 'mouse', clientX: 120, clientY: 240 } });
    expect(onHover).toHaveBeenLastCalledWith('mouse', { x: 120, y: 240 });

    props.onMouseMove({ clientX: 150, clientY: 260 });
    expect(onHover).toHaveBeenLastCalledWith('mouse', { x: 150, y: 260 });
  });

  it('ignores pointer micro-jitter under 10px deadzone and wakes at >= 10px (#421)', () => {
    const guard = createTouchHoverGuard({ now: () => 1_000 });
    expect(DEFAULT_POINTER_DEADZONE_PX).toBe(10);

    // First coordinate establishes baseline and allows hover
    expect(guard.shouldAllowHover('mouse', { x: 100, y: 100 })).toBe(true);

    // Micro-jitter (< 10px) is ignored without drifting the anchor
    expect(guard.shouldAllowHover('mouse', { x: 105, y: 105 })).toBe(false); // hypot(5,5) ~= 7.07
    expect(guard.shouldAllowHover('mouse', { x: 109, y: 100 })).toBe(false); // 9px
    expect(guard.shouldAllowHover('mouse', { x: 100, y: 109 })).toBe(false); // 9px

    // Deliberate move >= 10px wakes and updates anchor to (106, 108) (hypot(6,8) = 10)
    expect(guard.shouldAllowHover('mouse', { x: 106, y: 108 })).toBe(true);

    // Further small jitter around new anchor (106, 108) is ignored
    expect(guard.shouldAllowHover('mouse', { x: 112, y: 112 })).toBe(false); // hypot(6,4) ~= 7.21
    // Deliberate move >= 10px from (106, 108) wakes again
    expect(guard.shouldAllowHover('mouse', { x: 116, y: 108 })).toBe(true);
  });
});
