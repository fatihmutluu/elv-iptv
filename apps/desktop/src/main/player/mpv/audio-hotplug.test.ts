import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioHotplug } from './audio-hotplug.ts';

afterEach(() => vi.useRealTimers());

function setup(debounceMs = 500) {
  let reloads = 0;
  const hotplug = createAudioHotplug({
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    onReinit: () => {
      reloads += 1;
    },
    debounceMs,
  });
  return {
    hotplug,
    reloads: () => reloads,
  };
}

describe('createAudioHotplug', () => {
  it('ignores initial baseline device list and debounces primary device changes in auto mode (#110)', () => {
    vi.useFakeTimers();
    const { hotplug, reloads } = setup();

    // Non-array initial property notification is ignored
    hotplug.onDeviceList(undefined);
    // First valid list sets baseline without triggering reload
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Same device list does nothing
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Rapid primary changes coalesce within 500 ms into one re-init
    hotplug.onDeviceList([{ name: 'auto' }]);
    vi.advanceTimersByTime(300);
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/usb-headset' }]);
    vi.advanceTimersByTime(499);
    expect(reloads()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(reloads()).toBe(1);
  });

  it('in auto mode, ignores unrelated secondary device additions, removals, or reordering (#434)', () => {
    vi.useFakeTimers();
    const { hotplug, reloads } = setup();

    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    // Secondary device added behind primary
    hotplug.onDeviceList([
      { name: 'auto' },
      { name: 'wasapi/speakers' },
      { name: 'wasapi/hdmi-monitor' },
    ]);
    // Another secondary added and reordered behind primary
    hotplug.onDeviceList([
      { name: 'auto' },
      { name: 'wasapi/speakers' },
      { name: 'wasapi/bt-unused' },
      { name: 'wasapi/hdmi-monitor' },
    ]);
    // Secondary removed while primary stays intact
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(2000);
    expect(reloads()).toBe(0);

    // Primary switches to a different concrete device -> triggers reload
    hotplug.onDeviceList([
      { name: 'auto' },
      { name: 'wasapi/usb-dac' },
      { name: 'wasapi/speakers' },
    ]);
    vi.advanceTimersByTime(500);
    expect(reloads()).toBe(1);
  });

  it('with an explicit activeDevice, triggers reload ONLY when that device disappears or reappears (#434)', () => {
    vi.useFakeTimers();
    const { hotplug, reloads } = setup();

    hotplug.onActiveDevice('wasapi/usb-dac');
    hotplug.onDeviceList([
      { name: 'auto' },
      { name: 'wasapi/speakers' },
      { name: 'wasapi/usb-dac' },
    ]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Unrelated device added or primary changes while explicit device stays present -> NO reload
    hotplug.onDeviceList([
      { name: 'auto' },
      { name: 'wasapi/hdmi' },
      { name: 'wasapi/speakers' },
      { name: 'wasapi/usb-dac' },
    ]);
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/usb-dac' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Explicit device disappears -> triggers reload
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(500);
    expect(reloads()).toBe(1);

    // Unrelated changes while explicit device remains absent -> NO reload
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/hdmi' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(1);

    // Explicit device reappears -> triggers reload
    hotplug.onDeviceList([
      { name: 'auto' },
      { name: 'wasapi/speakers' },
      { name: 'wasapi/usb-dac' },
    ]);
    vi.advanceTimersByTime(500);
    expect(reloads()).toBe(2);
  });

  it('handles onActiveDevice arriving after initial device list without spurious reload (#434)', () => {
    vi.useFakeTimers();
    const { hotplug, reloads } = setup();

    hotplug.onDeviceList([
      { name: 'auto' },
      { name: 'wasapi/speakers' },
      { name: 'wasapi/usb-dac' },
    ]);
    hotplug.onActiveDevice(undefined); // non-string ignored
    hotplug.onActiveDevice('wasapi/usb-dac');
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Primary changes, explicit device still present -> NO reload
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/hdmi' }, { name: 'wasapi/usb-dac' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Switch back to auto -> tracks current primary without spurious reload
    hotplug.onActiveDevice('auto');
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Primary still wasapi/hdmi, secondary removed -> NO reload
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/hdmi' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // Primary disappears -> triggers reload
    hotplug.onDeviceList([{ name: 'auto' }]);
    vi.advanceTimersByTime(500);
    expect(reloads()).toBe(1);
  });

  it('cancels pending debounce timer and resets state on reset', () => {
    vi.useFakeTimers();
    const { hotplug, reloads } = setup();

    hotplug.onActiveDevice('coreaudio/airpods');
    hotplug.onDeviceList([{ name: 'auto' }]);
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'coreaudio/airpods' }]);
    hotplug.reset();
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);

    // After reset, activeDevice defaults back to auto and next list is silent baseline
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'coreaudio/speakers' }]);
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);
  });

  it('cancels a pending auto-mode reload timer when activeDevice explicitly changes (#434)', () => {
    vi.useFakeTimers();
    const { hotplug, reloads } = setup();

    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/speakers' }]);
    // Primary changes in auto mode -> arms 500 ms timer
    hotplug.onDeviceList([{ name: 'auto' }, { name: 'wasapi/hdmi' }, { name: 'wasapi/speakers' }]);
    vi.advanceTimersByTime(200);
    expect(reloads()).toBe(0);

    // User switches explicitly to wasapi/hdmi before the 500 ms timer fires -> stale timer cancelled
    hotplug.onActiveDevice('wasapi/hdmi');
    vi.advanceTimersByTime(1000);
    expect(reloads()).toBe(0);
  });
});
