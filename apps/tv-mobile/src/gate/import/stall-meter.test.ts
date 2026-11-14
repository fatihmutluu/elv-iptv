import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStallMeter } from './stall-meter';

describe('startStallMeter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports 0 when the ticks arrive on time', () => {
    const meter = startStallMeter();
    vi.advanceTimersByTime(160);
    expect(meter.stop()).toBe(0);
  });

  it('reports the longest gap between ticks minus the interval', () => {
    let clock = 0;
    const meter = startStallMeter(() => clock);
    for (const gap of [16, 16, 136, 16, 20]) {
      clock += gap;
      vi.advanceTimersByTime(16);
    }
    expect(meter.stop()).toBe(120);
  });

  it('stops ticking after stop', () => {
    const meter = startStallMeter();
    meter.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
