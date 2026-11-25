import { DEFAULT_PREFERENCES, mergeSubtitleStyle, ok, type PreferencesPatch } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  activatePlaybackControl,
  adjustPlaybackControl,
  formatRefreshRateDelayMs,
  resetRefreshRateAudioDelay,
  stepRefreshRateAudioDelay,
  toggleAudioPassthroughCodec,
} from './playback-controls';

describe('Wave F7A playback-controls pure helpers (#115, #116, #213)', () => {
  it('formats, steps (±25 ms, clamped [-1000, 1000]), and resets per-refresh-rate audio delays', () => {
    expect(formatRefreshRateDelayMs(0)).toBe('0 ms');
    expect(formatRefreshRateDelayMs(25)).toBe('+25 ms');
    expect(formatRefreshRateDelayMs(-75)).toBe('-75 ms');

    const up = stepRefreshRateAudioDelay({}, '23.976', 2);
    expect(up).toEqual({ '23.976': 50 });

    const backToZero = stepRefreshRateAudioDelay(up, '23.976', -2);
    expect(backToZero).toEqual({});

    const clampedHigh = stepRefreshRateAudioDelay({ '60': 975 }, '60', 4);
    expect(clampedHigh).toEqual({ '60': 1000 });

    const clampedLow = stepRefreshRateAudioDelay({ '50': -975 }, '50', -4);
    expect(clampedLow).toEqual({ '50': -1000 });

    const reset = resetRefreshRateAudioDelay({ '23.976': -50, '50': 25 }, '23.976');
    expect(reset).toEqual({ '50': 25 });
  });

  it('toggles desktop passthrough codecs in canonical order', () => {
    expect(toggleAudioPassthroughCodec(['ac3', 'eac3', 'dts'], 'truehd')).toEqual([
      'ac3',
      'eac3',
      'dts',
      'truehd',
    ]);
    expect(toggleAudioPassthroughCodec(['ac3', 'eac3', 'dts'], 'eac3')).toEqual(['ac3', 'dts']);
  });

  it('activates AFR, Auto HDR, Night-Mode DRC, delay buckets, and adjusts/resets delay-stepper', () => {
    const patches: PreferencesPatch[] = [];
    const selectedBuckets: string[] = [];
    let current = { ...DEFAULT_PREFERENCES };
    const controller = {
      get preferences() {
        return current;
      },
      updatePreferences: vi.fn(async (patch: PreferencesPatch) => {
        patches.push(patch);
        current = {
          ...current,
          ...patch,
          subtitleStyle: mergeSubtitleStyle(current.subtitleStyle, patch.subtitleStyle),
        };
        return ok(current);
      }),
      resetPreferences: vi.fn(async () => ok(DEFAULT_PREFERENCES)),
    };

    activatePlaybackControl('afr-always', controller);
    activatePlaybackControl('toggle-auto-dynamic-range', controller);
    activatePlaybackControl('night-drc-night', controller);
    activatePlaybackControl('delay-bucket-50', controller, {
      onSelectDelayBucket: (b) => selectedBuckets.push(b),
    });
    adjustPlaybackControl('delay-stepper', 1, controller, '50');
    adjustPlaybackControl('delay-stepper', 1, controller, '50');
    adjustPlaybackControl('delay-stepper', -1, controller, '50');
    activatePlaybackControl('delay-stepper', controller, { selectedDelayBucket: '50' });

    expect(selectedBuckets).toEqual(['50']);
    expect(patches).toEqual([
      { autoFrameRate: 'always' },
      { autoDynamicRange: false },
      { nightModeDrc: 'night' },
      { audioDelayByRefreshRateMs: { '50': 25 } },
      { audioDelayByRefreshRateMs: { '50': 50 } },
      { audioDelayByRefreshRateMs: { '50': 25 } },
      { audioDelayByRefreshRateMs: {} },
    ]);
  });
});
