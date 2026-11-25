import { describe, expect, it } from 'vitest';
import {
  AUDIO_CHANNEL_LAYOUTS,
  AUDIO_PASSTHROUGH_CODECS,
  AUTO_FRAME_RATE_MODES,
  createMemoryPreferencesStore,
  DEFAULT_AUDIO_PASSTHROUGH_CODECS,
  DEFAULT_PREFERENCES,
  isAudioChannelLayout,
  isAudioPassthroughCodec,
  isAutoFrameRateMode,
  isNightModeDrcPreset,
  isRefreshRateBucket,
  MAX_PREFERENCES_BYTES,
  MAX_REFRESH_RATE_AUDIO_DELAY_MS,
  MIN_REFRESH_RATE_AUDIO_DELAY_MS,
  NIGHT_MODE_DRC_PRESETS,
  parsePreferences,
  REFRESH_RATE_BUCKETS,
  serializePreferences,
} from './index';

describe('Wave F7A preferences (#115, #116, #188, #199, #213, #214)', () => {
  it('exposes constants, defaults, and type guards', () => {
    expect(AUTO_FRAME_RATE_MODES).toEqual(['off', 'seamless', 'always']);
    expect(NIGHT_MODE_DRC_PRESETS).toEqual(['off', 'light', 'night']);
    expect(REFRESH_RATE_BUCKETS).toEqual([
      '23.976',
      '24',
      '25',
      '29.97',
      '30',
      '50',
      '59.94',
      '60',
    ]);
    expect(AUDIO_PASSTHROUGH_CODECS).toEqual(['ac3', 'eac3', 'dts', 'dts-hd', 'truehd']);
    expect(DEFAULT_AUDIO_PASSTHROUGH_CODECS).toEqual(['ac3', 'eac3', 'dts']);
    expect(AUDIO_CHANNEL_LAYOUTS).toEqual(['auto', 'stereo', '5.1', '7.1']);
    expect(MIN_REFRESH_RATE_AUDIO_DELAY_MS).toBe(-1000);
    expect(MAX_REFRESH_RATE_AUDIO_DELAY_MS).toBe(1000);

    expect(DEFAULT_PREFERENCES.autoFrameRate).toBe('seamless');
    expect(DEFAULT_PREFERENCES.autoDynamicRange).toBe(true);
    expect(DEFAULT_PREFERENCES.nightModeDrc).toBe('off');
    expect(DEFAULT_PREFERENCES.audioDelayByRefreshRateMs).toEqual({});
    expect(DEFAULT_PREFERENCES.audioPassthrough).toBe(false);
    expect(DEFAULT_PREFERENCES.audioPassthroughCodecs).toEqual(['ac3', 'eac3', 'dts']);
    expect(DEFAULT_PREFERENCES.audioExclusive).toBe(false);
    expect(DEFAULT_PREFERENCES.audioAc3Encode).toBe(false);
    expect(DEFAULT_PREFERENCES.audioChannelLayout).toBe('auto');

    expect(isAutoFrameRateMode('seamless')).toBe(true);
    expect(isAutoFrameRateMode('invalid')).toBe(false);
    expect(isNightModeDrcPreset('night')).toBe(true);
    expect(isNightModeDrcPreset('heavy')).toBe(false);
    expect(isRefreshRateBucket('23.976')).toBe(true);
    expect(isRefreshRateBucket('120')).toBe(false);
    expect(isAudioPassthroughCodec('truehd')).toBe(true);
    expect(isAudioPassthroughCodec('aac')).toBe(false);
    expect(isAudioChannelLayout('7.1')).toBe(true);
    expect(isAudioChannelLayout('mono')).toBe(false);
  });

  it('round-trips valid Wave F7A preferences and fits well within MAX_PREFERENCES_BYTES', () => {
    const serialized = serializePreferences({
      ...DEFAULT_PREFERENCES,
      autoFrameRate: 'always',
      autoDynamicRange: false,
      nightModeDrc: 'night',
      audioDelayByRefreshRateMs: {
        '23.976': -65,
        '24': 0,
        '50': 120.4,
        '59.94': -2500,
        '60': 2500,
      },
      audioPassthrough: true,
      audioPassthroughCodecs: ['ac3', 'eac3', 'truehd', 'ac3'],
      audioExclusive: true,
      audioAc3Encode: true,
      audioChannelLayout: '7.1',
    });

    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(new TextEncoder().encode(serialized.value).byteLength).toBeLessThan(
      MAX_PREFERENCES_BYTES,
    );

    const rawJson = JSON.parse(serialized.value) as Record<string, unknown>;
    expect(rawJson.audioDelayByRefreshRateMs).toEqual({
      '23.976': -65,
      '50': 120,
      '59.94': -1000,
      '60': 1000,
    });
    expect(rawJson.audioPassthroughCodecs).toEqual(['ac3', 'eac3', 'truehd']);

    const parsed = parsePreferences(serialized.value);
    expect(parsed.autoFrameRate).toBe('always');
    expect(parsed.autoDynamicRange).toBe(false);
    expect(parsed.nightModeDrc).toBe('night');
    expect(parsed.audioDelayByRefreshRateMs).toEqual({
      '23.976': -65,
      '50': 120,
      '59.94': -1000,
      '60': 1000,
    });
    expect(parsed.audioPassthrough).toBe(true);
    expect(parsed.audioPassthroughCodecs).toEqual(['ac3', 'eac3', 'truehd']);
    expect(parsed.audioExclusive).toBe(true);
    expect(parsed.audioAc3Encode).toBe(true);
    expect(parsed.audioChannelLayout).toBe('7.1');
  });

  it('rejects invalid enum values, unknown refresh buckets, non-finite delays, and unknown codecs on parse', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        autoFrameRate: 'turbo',
        autoDynamicRange: 'yes',
        nightModeDrc: 'extreme',
        audioDelayByRefreshRateMs: {
          '23.976': 40,
          '25': 0,
          '30': Number.NaN,
          '50': '100',
          '120': 50,
          __proto__: 99,
        },
        audioPassthrough: 1,
        audioPassthroughCodecs: ['dts', 'aac', 'dts', 123, 'dts-hd'],
        audioExclusive: 'true',
        audioAc3Encode: null,
        audioChannelLayout: '9.1',
      }),
    );

    expect(parsed.autoFrameRate).toBe('seamless');
    expect(parsed.autoDynamicRange).toBe(true);
    expect(parsed.nightModeDrc).toBe('off');
    expect(parsed.audioDelayByRefreshRateMs).toEqual({ '23.976': 40 });
    expect(parsed.audioPassthrough).toBe(false);
    expect(parsed.audioPassthroughCodecs).toEqual(['dts', 'dts-hd']);
    expect(parsed.audioExclusive).toBe(false);
    expect(parsed.audioAc3Encode).toBe(false);
    expect(parsed.audioChannelLayout).toBe('auto');
  });

  it('handles non-object audioDelayByRefreshRateMs and non-array audioPassthroughCodecs gracefully', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        audioDelayByRefreshRateMs: [10, 20],
        audioPassthroughCodecs: 'ac3',
      }),
    );
    expect(parsed.audioDelayByRefreshRateMs).toEqual({});
    expect(parsed.audioPassthroughCodecs).toEqual(['ac3', 'eac3', 'dts']);
  });

  it('supports store updates for Wave F7A preferences including clearing refresh delays and codec list', async () => {
    const store = createMemoryPreferencesStore();
    await store.load();

    const first = await store.update({
      autoFrameRate: 'off',
      autoDynamicRange: false,
      nightModeDrc: 'light',
      audioDelayByRefreshRateMs: { '23.976': -45, '50': 30 },
      audioPassthrough: true,
      audioPassthroughCodecs: ['ac3', 'truehd'],
      audioExclusive: true,
      audioAc3Encode: true,
      audioChannelLayout: '5.1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.autoFrameRate).toBe('off');
    expect(first.value.autoDynamicRange).toBe(false);
    expect(first.value.nightModeDrc).toBe('light');
    expect(first.value.audioDelayByRefreshRateMs).toEqual({ '23.976': -45, '50': 30 });
    expect(first.value.audioPassthrough).toBe(true);
    expect(first.value.audioPassthroughCodecs).toEqual(['ac3', 'truehd']);
    expect(first.value.audioExclusive).toBe(true);
    expect(first.value.audioAc3Encode).toBe(true);
    expect(first.value.audioChannelLayout).toBe('5.1');

    const second = await store.update({
      audioDelayByRefreshRateMs: { '23.976': 0, '50': 30 },
      audioPassthroughCodecs: [],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.audioDelayByRefreshRateMs).toEqual({ '50': 30 });
    expect(second.value.audioPassthroughCodecs).toEqual([]);
  });

  it('sanitizes invalid Wave F7A fields during serialization', () => {
    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      autoFrameRate: 'bad' as unknown as typeof DEFAULT_PREFERENCES.autoFrameRate,
      nightModeDrc: 'bad' as unknown as typeof DEFAULT_PREFERENCES.nightModeDrc,
      audioChannelLayout: 'bad' as unknown as typeof DEFAULT_PREFERENCES.audioChannelLayout,
      audioDelayByRefreshRateMs: {
        '23.976': -0.2,
        '25': Number.POSITIVE_INFINITY,
        '60': 75.6,
      },
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const raw = JSON.parse(encoded.value) as Record<string, unknown>;
    expect(raw.autoFrameRate).toBeUndefined();
    expect(raw.nightModeDrc).toBeUndefined();
    expect(raw.audioChannelLayout).toBeUndefined();
    expect(raw.audioDelayByRefreshRateMs).toEqual({ '60': 76 });
    const reparsed = parsePreferences(encoded.value);
    expect(reparsed.autoFrameRate).toBe('seamless');
    expect(reparsed.nightModeDrc).toBe('off');
    expect(reparsed.audioChannelLayout).toBe('auto');
    expect(reparsed.audioDelayByRefreshRateMs).toEqual({ '60': 76 });
  });
});
