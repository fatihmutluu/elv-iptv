import { describe, expect, it } from 'vitest';
import type { AudioDeviceInfo } from '../../../shared/player-ipc.ts';
import {
  createAudioDeviceTracker,
  normalizeActiveAudioDevice,
  normalizeAudioDeviceList,
} from './audio-devices.ts';

describe('audio-devices (#408)', () => {
  it('normalizes and deduplicates mpv audio-device-list payloads', () => {
    expect(normalizeAudioDeviceList(null)).toEqual([]);
    expect(normalizeAudioDeviceList('auto')).toEqual([]);
    expect(
      normalizeAudioDeviceList([
        { name: 'auto', description: 'Autoselect device' },
        { name: '  wasapi/{1111}  ', description: '  Speakers (Realtek)\nUSB  ' },
        { name: 'wasapi/{1111}', description: 'Duplicate should be ignored' },
        { name: 'wasapi/{2222}', description: '' },
        { name: '', description: 'Empty name dropped' },
        { name: 'bad\nname', description: 'Control char in name dropped' },
        { name: 'a'.repeat(161), description: 'Overlong name dropped' },
        42,
        null,
      ]),
    ).toEqual([
      { name: 'auto', description: 'Autoselect device' },
      { name: 'wasapi/{1111}', description: 'Speakers (Realtek) USB' },
      { name: 'wasapi/{2222}', description: 'wasapi/{2222}' },
    ]);
  });

  it('normalizes active audio-device values to a clean string or auto', () => {
    expect(normalizeActiveAudioDevice('wasapi/{1111}')).toBe('wasapi/{1111}');
    expect(normalizeActiveAudioDevice('  coreaudio/BuiltIn  ')).toBe('coreaudio/BuiltIn');
    expect(normalizeActiveAudioDevice('')).toBe('auto');
    expect(normalizeActiveAudioDevice('   ')).toBe('auto');
    expect(normalizeActiveAudioDevice('bad\x00dev')).toBe('auto');
    expect(normalizeActiveAudioDevice('x'.repeat(161))).toBe('auto');
    expect(normalizeActiveAudioDevice(undefined)).toBe('auto');
    expect(normalizeActiveAudioDevice(null)).toBe('auto');
  });

  it('emits deduplicated audio device updates and resets cleanly', () => {
    const emitted: Array<{ devices: readonly AudioDeviceInfo[]; active: string }> = [];
    const tracker = createAudioDeviceTracker((devices, active) => {
      emitted.push({ devices, active });
    });

    const list1 = [
      { name: 'auto', description: 'Autoselect device' },
      { name: 'wasapi/{1}', description: 'Headphones' },
    ];
    tracker.onDeviceList(list1);
    expect(emitted).toEqual([{ devices: list1, active: 'auto' }]);

    // Identical list is deduplicated.
    tracker.onDeviceList([...list1]);
    expect(emitted).toHaveLength(1);

    // Changing active device emits once, repeating it does not.
    tracker.onActiveDevice('wasapi/{1}');
    tracker.onActiveDevice('wasapi/{1}');
    expect(emitted).toEqual([
      { devices: list1, active: 'auto' },
      { devices: list1, active: 'wasapi/{1}' },
    ]);

    // Hotplug adds a device -> emits updated list keeping active.
    const list2 = [...list1, { name: 'wasapi/{2}', description: 'HDMI Monitor' }];
    tracker.onDeviceList(list2);
    expect(emitted).toHaveLength(3);
    expect(emitted[2]).toEqual({ devices: list2, active: 'wasapi/{1}' });

    // After reset, the same list emits fresh again with active 'auto'.
    tracker.reset();
    tracker.onDeviceList(list2);
    expect(emitted).toHaveLength(4);
    expect(emitted[3]).toEqual({ devices: list2, active: 'auto' });
  });
});
