import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioHotplug } from './audio-hotplug.ts';

afterEach(() => vi.useRealTimers());

describe('createAudioHotplug', () => {
  it('ignores initial baseline device list and debounces hotplug changes (#110)', () => {
    vi.useFakeTimers();
    let reloads = 0;
    const hotplug = createAudioHotplug({
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      onReinit: () => {
        reloads += 1;
      },
      debounceMs: 500,
    });

    // Non-array initial property notification is ignored
    hotplug.onDeviceList(undefined);
    // First valid list sets baseline without triggering reload
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads).toBe(0);

    // Same device list does nothing
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads).toBe(0);

    // Rapid device changes coalesce within 500 ms into one re-init
    hotplug.onDeviceList([{ name: 'auto' }]);
    vi.advanceTimersByTime(300);
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/usb-headset' }]);
    vi.advanceTimersByTime(499);
    expect(reloads).toBe(0);
    vi.advanceTimersByTime(1);
    expect(reloads).toBe(1);
  });

  it('cancels pending debounce timer on reset', () => {
    vi.useFakeTimers();
    let reloads = 0;
    const hotplug = createAudioHotplug({
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      onReinit: () => {
        reloads += 1;
      },
      debounceMs: 500,
    });

    hotplug.onDeviceList([{ name: 'auto' }]);
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'coreaudio/airpods' }]);
    hotplug.reset();
    vi.advanceTimersByTime(1000);
    expect(reloads).toBe(0);
  });
});
