import { describe, expect, it } from 'vitest';
import { createSelectDebounceGuard } from './select-guard';

describe('createSelectDebounceGuard', () => {
  it('uses a default 220ms window to suppress duplicate bursts for the same key', () => {
    const guard = createSelectDebounceGuard();
    expect(guard.allow(1000)).toBe(true);
    expect(guard.allow(1000)).toBe(false);
    expect(guard.allow(1100)).toBe(false);
    expect(guard.allow(1219)).toBe(false);
    expect(guard.allow(1220)).toBe(true);
    expect(guard.allow(1300)).toBe(false);
    expect(guard.allow(1440)).toBe(true);
  });

  it('does not extend the suppression window on suppressed duplicate bursts', () => {
    const guard = createSelectDebounceGuard({ windowMs: 100 });
    expect(guard.allow(500, 'item-1')).toBe(true);
    expect(guard.allow(550, 'item-1')).toBe(false);
    expect(guard.allow(590, 'item-1')).toBe(false);
    expect(guard.allow(600, 'item-1')).toBe(true);
  });

  it('allows immediately when the key changes and treats omitted key as empty string', () => {
    const guard = createSelectDebounceGuard({ windowMs: 220 });
    expect(guard.allow(1000)).toBe(true);
    expect(guard.allow(1050, '')).toBe(false);
    expect(guard.allow(1060, 'card-a')).toBe(true);
    expect(guard.allow(1100, 'card-a')).toBe(false);
    expect(guard.allow(1110, 'card-b')).toBe(true);
    expect(guard.allow(1120, 'card-a')).toBe(true);
  });

  it('allows immediately after reset even for the same key and timestamp', () => {
    const guard = createSelectDebounceGuard({ windowMs: 220 });
    expect(guard.allow(1000, 'play')).toBe(true);
    expect(guard.allow(1050, 'play')).toBe(false);
    guard.reset();
    expect(guard.allow(1050, 'play')).toBe(true);
    expect(guard.allow(1100, 'play')).toBe(false);
  });

  it('handles non-monotonic timestamps safely by resetting and allowing', () => {
    const guard = createSelectDebounceGuard({ windowMs: 220 });
    expect(guard.allow(1000, 'a')).toBe(true);
    expect(guard.allow(900, 'a')).toBe(true);
    expect(guard.allow(1050, 'a')).toBe(false);
    expect(guard.allow(1120, 'a')).toBe(true);
  });

  it('treats windowMs <= 0 or NaN as disabled and always allows', () => {
    const zero = createSelectDebounceGuard({ windowMs: 0 });
    expect(zero.allow(1000, 'x')).toBe(true);
    expect(zero.allow(1000, 'x')).toBe(true);

    const negative = createSelectDebounceGuard({ windowMs: -50 });
    expect(negative.allow(1000, 'x')).toBe(true);
    expect(negative.allow(1001, 'x')).toBe(true);

    const nan = createSelectDebounceGuard({ windowMs: Number.NaN });
    expect(nan.allow(1000, 'x')).toBe(true);
    expect(nan.allow(1001, 'x')).toBe(true);
  });

  it('handles timestamp 0 and non-finite timestamps without locking out future calls', () => {
    const guard = createSelectDebounceGuard({ windowMs: 100 });
    expect(guard.allow(0, 'k')).toBe(true);
    expect(guard.allow(50, 'k')).toBe(false);
    expect(guard.allow(100, 'k')).toBe(true);
    expect(guard.allow(Number.NaN, 'k')).toBe(true);
    expect(guard.allow(120, 'k')).toBe(true);
    expect(guard.allow(150, 'k')).toBe(false);
  });
});
