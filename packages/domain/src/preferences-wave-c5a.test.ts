import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  DEINTERLACE_MODES,
  type DeinterlaceMode,
  isDeinterlaceMode,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave C5A preferences (#243, #332)', () => {
  it('exposes constants, type guards, and defaults', () => {
    expect(DEINTERLACE_MODES).toEqual(['off', 'auto', 'bwdif']);

    expect(DEFAULT_PREFERENCES.deinterlaceMode).toBe('auto');
    expect(DEFAULT_PREFERENCES.pitchLock).toBe(true);
    expect(DEFAULT_PREFERENCES.audioNormalization).toBe(false);
    expect(DEFAULT_PREFERENCES.windowAspectRatioLock).toBe(false);

    for (const mode of DEINTERLACE_MODES) {
      expect(isDeinterlaceMode(mode)).toBe(true);
    }
    expect(isDeinterlaceMode('yadif')).toBe(false);
    expect(isDeinterlaceMode(true)).toBe(false);
    expect(isDeinterlaceMode(null)).toBe(false);
  });

  it('preserves backwards compatibility with older v1 snapshots lacking Wave C5A fields', () => {
    const legacy = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'tr',
        fontScale: 1.1,
      }),
    );
    expect(legacy.deinterlaceMode).toBe('auto');
    expect(legacy.pitchLock).toBe(true);
    expect(legacy.audioNormalization).toBe(false);
    expect(legacy.windowAspectRatioLock).toBe(false);
    expect(legacy.fontScale).toBe(1.1);
  });

  it('parses valid Wave C5A fields and falls back per invalid field', () => {
    const valid = parsePreferences(
      JSON.stringify({
        version: 1,
        deinterlaceMode: 'bwdif',
        pitchLock: false,
        audioNormalization: true,
        windowAspectRatioLock: true,
      }),
    );
    expect(valid.deinterlaceMode).toBe('bwdif');
    expect(valid.pitchLock).toBe(false);
    expect(valid.audioNormalization).toBe(true);
    expect(valid.windowAspectRatioLock).toBe(true);

    const invalid = parsePreferences(
      JSON.stringify({
        version: 1,
        deinterlaceMode: 'yadif',
        pitchLock: 'no',
        audioNormalization: 1,
        windowAspectRatioLock: 'yes',
      }),
    );
    expect(invalid.deinterlaceMode).toBe('auto');
    expect(invalid.pitchLock).toBe(true);
    expect(invalid.audioNormalization).toBe(false);
    expect(invalid.windowAspectRatioLock).toBe(false);
  });

  it('serializes and round-trips Wave C5A preferences well under MAX_PREFERENCES_BYTES', () => {
    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      deinterlaceMode: 'auto',
      pitchLock: false,
      audioNormalization: true,
      windowAspectRatioLock: true,
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
      const parsed = parsePreferences(encoded.value);
      expect(parsed.deinterlaceMode).toBe('auto');
      expect(parsed.pitchLock).toBe(false);
      expect(parsed.audioNormalization).toBe(true);
      expect(parsed.windowAspectRatioLock).toBe(true);
    }

    const sanitized = serializePreferences({
      ...DEFAULT_PREFERENCES,
      deinterlaceMode: 'invalid' as unknown as DeinterlaceMode,
      pitchLock: false,
      audioNormalization: true,
      windowAspectRatioLock: true,
    });
    expect(sanitized.ok).toBe(true);
    if (sanitized.ok) {
      const parsed = parsePreferences(sanitized.value);
      expect(parsed.deinterlaceMode).toBe('auto');
      expect(parsed.pitchLock).toBe(false);
      expect(parsed.audioNormalization).toBe(true);
      expect(parsed.windowAspectRatioLock).toBe(true);
    }
  });

  it('merges, ignores invalid patches, and resets via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const u1 = await store.update({
      deinterlaceMode: 'bwdif',
      pitchLock: false,
      audioNormalization: true,
      windowAspectRatioLock: true,
    });
    expect(u1.ok).toBe(true);
    if (u1.ok) {
      expect(u1.value.deinterlaceMode).toBe('bwdif');
      expect(u1.value.pitchLock).toBe(false);
      expect(u1.value.audioNormalization).toBe(true);
      expect(u1.value.windowAspectRatioLock).toBe(true);
    }

    const u2 = await store.update({
      deinterlaceMode: 'bad' as unknown as DeinterlaceMode,
      pitchLock: 'bad' as unknown as boolean,
      audioNormalization: 123 as unknown as boolean,
      windowAspectRatioLock: null as unknown as boolean,
    });
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.deinterlaceMode).toBe('bwdif');
      expect(u2.value.pitchLock).toBe(false);
      expect(u2.value.audioNormalization).toBe(true);
      expect(u2.value.windowAspectRatioLock).toBe(true);
    }

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.value.deinterlaceMode).toBe('auto');
      expect(reset.value.pitchLock).toBe(true);
      expect(reset.value.audioNormalization).toBe(false);
      expect(reset.value.windowAspectRatioLock).toBe(false);
    }
  });
});
