import { describe, expect, it } from 'vitest';
import {
  ACCESSIBILITY_FONT_FAMILIES,
  type AccessibilityFontFamily,
  clampOverscan,
  createMemoryPreferencesStore,
  DEFAULT_PREF_OVERSCAN,
  DEFAULT_PREFERENCES,
  isAccessibilityFontFamily,
  isTvClockMode,
  MAX_PREF_FONT_SCALE,
  MAX_PREF_OVERSCAN,
  MAX_PREFERENCES_BYTES,
  MIN_PREF_FONT_SCALE,
  MIN_PREF_OVERSCAN,
  parsePreferences,
  serializePreferences,
  TV_CLOCK_MODES,
  type TvClockMode,
} from './index';

describe('Wave C4B preferences (#62, #163, #133, #416)', () => {
  it('exposes constants, type guards, and defaults', () => {
    expect(ACCESSIBILITY_FONT_FAMILIES).toEqual(['system', 'atkinson', 'opendyslexic']);
    expect(TV_CLOCK_MODES).toEqual(['always', 'menus', 'player', 'never']);
    expect(MIN_PREF_OVERSCAN).toBe(0);
    expect(MAX_PREF_OVERSCAN).toBe(0.1);
    expect(DEFAULT_PREF_OVERSCAN).toBe(0.05);
    expect(MIN_PREF_FONT_SCALE).toBe(0.9);
    expect(MAX_PREF_FONT_SCALE).toBe(1.2);

    expect(DEFAULT_PREFERENCES.uiFontFamily).toBe('system');
    expect(DEFAULT_PREFERENCES.subtitleFontFamily).toBe('system');
    expect(DEFAULT_PREFERENCES.tvClockMode).toBe('always');
    expect(DEFAULT_PREFERENCES.overscanX).toBe(0.05);
    expect(DEFAULT_PREFERENCES.overscanY).toBe(0.05);

    for (const family of ACCESSIBILITY_FONT_FAMILIES) {
      expect(isAccessibilityFontFamily(family)).toBe(true);
    }
    expect(isAccessibilityFontFamily('comic-sans')).toBe(false);
    expect(isAccessibilityFontFamily(123)).toBe(false);

    for (const mode of TV_CLOCK_MODES) {
      expect(isTvClockMode(mode)).toBe(true);
    }
    expect(isTvClockMode('off')).toBe(false);
    expect(isTvClockMode(null)).toBe(false);
  });

  it('clamps and rounds overscan values to [0, 0.1] at 2 decimal places', () => {
    expect(clampOverscan(-0.05)).toBe(0);
    expect(Object.is(clampOverscan(-0.001), 0)).toBe(true);
    expect(clampOverscan(0)).toBe(0);
    expect(clampOverscan(0.034)).toBe(0.03);
    expect(clampOverscan(0.035)).toBe(0.04);
    expect(clampOverscan(0.05)).toBe(0.05);
    expect(clampOverscan(0.1)).toBe(0.1);
    expect(clampOverscan(0.25)).toBe(0.1);
  });

  it('preserves backwards compatibility with older v1 snapshots lacking Wave C4B fields', () => {
    const legacy = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'tr',
        fontScale: 1.1,
      }),
    );
    expect(legacy.uiFontFamily).toBe('system');
    expect(legacy.subtitleFontFamily).toBe('system');
    expect(legacy.tvClockMode).toBe('always');
    expect(legacy.overscanX).toBe(0.05);
    expect(legacy.overscanY).toBe(0.05);
    expect(legacy.fontScale).toBe(1.1);
  });

  it('supports all four text-size presets (0.9, 1.0, 1.1, 1.2) without drift', () => {
    for (const scale of [0.9, 1.0, 1.1, 1.2]) {
      const parsed = parsePreferences(JSON.stringify({ version: 1, fontScale: scale }));
      expect(parsed.fontScale).toBe(scale);
      const encoded = serializePreferences(parsed);
      expect(encoded.ok).toBe(true);
      if (encoded.ok) {
        expect(parsePreferences(encoded.value).fontScale).toBe(scale);
      }
    }
  });

  it('parses valid Wave C4B fields and falls back per invalid field', () => {
    const valid = parsePreferences(
      JSON.stringify({
        version: 1,
        uiFontFamily: 'atkinson',
        subtitleFontFamily: 'opendyslexic',
        tvClockMode: 'player',
        overscanX: 0.084,
        overscanY: 0.026,
      }),
    );
    expect(valid.uiFontFamily).toBe('atkinson');
    expect(valid.subtitleFontFamily).toBe('opendyslexic');
    expect(valid.tvClockMode).toBe('player');
    expect(valid.overscanX).toBe(0.08);
    expect(valid.overscanY).toBe(0.03);

    const invalid = parsePreferences(
      JSON.stringify({
        version: 1,
        uiFontFamily: 'serif',
        subtitleFontFamily: 42,
        tvClockMode: 'sometimes',
        overscanX: '5%',
        overscanY: Number.NaN,
      }),
    );
    expect(invalid.uiFontFamily).toBe('system');
    expect(invalid.subtitleFontFamily).toBe('system');
    expect(invalid.tvClockMode).toBe('always');
    expect(invalid.overscanX).toBe(0.05);
    expect(invalid.overscanY).toBe(0.05);

    const clamped = parsePreferences(
      JSON.stringify({
        version: 1,
        overscanX: -0.2,
        overscanY: 0.9,
      }),
    );
    expect(clamped.overscanX).toBe(0);
    expect(clamped.overscanY).toBe(0.1);
  });

  it('serializes and round-trips Wave C4B preferences well under MAX_PREFERENCES_BYTES', () => {
    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      uiFontFamily: 'opendyslexic',
      subtitleFontFamily: 'atkinson',
      tvClockMode: 'menus',
      overscanX: 0.076,
      overscanY: 0.014,
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
      const parsed = parsePreferences(encoded.value);
      expect(parsed.uiFontFamily).toBe('opendyslexic');
      expect(parsed.subtitleFontFamily).toBe('atkinson');
      expect(parsed.tvClockMode).toBe('menus');
      expect(parsed.overscanX).toBe(0.08);
      expect(parsed.overscanY).toBe(0.01);
    }

    const sanitized = serializePreferences({
      ...DEFAULT_PREFERENCES,
      uiFontFamily: 'bad' as unknown as AccessibilityFontFamily,
      subtitleFontFamily: 'bad' as unknown as AccessibilityFontFamily,
      tvClockMode: 'bad' as unknown as TvClockMode,
      overscanX: Number.POSITIVE_INFINITY,
      overscanY: -5,
    });
    expect(sanitized.ok).toBe(true);
    if (sanitized.ok) {
      const parsed = parsePreferences(sanitized.value);
      expect(parsed.uiFontFamily).toBe('system');
      expect(parsed.subtitleFontFamily).toBe('system');
      expect(parsed.tvClockMode).toBe('always');
      expect(parsed.overscanX).toBe(0.05);
      expect(parsed.overscanY).toBe(0);
    }
  });

  it('merges, ignores invalid patches, and resets via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const u1 = await store.update({
      uiFontFamily: 'atkinson',
      subtitleFontFamily: 'opendyslexic',
      tvClockMode: 'never',
      overscanX: 0.064,
      overscanY: 0.095,
      fontScale: 1.2,
    });
    expect(u1.ok).toBe(true);
    if (u1.ok) {
      expect(u1.value.uiFontFamily).toBe('atkinson');
      expect(u1.value.subtitleFontFamily).toBe('opendyslexic');
      expect(u1.value.tvClockMode).toBe('never');
      expect(u1.value.overscanX).toBe(0.06);
      expect(u1.value.overscanY).toBe(0.1);
      expect(u1.value.fontScale).toBe(1.2);
    }

    const u2 = await store.update({
      uiFontFamily: 'unknown' as unknown as AccessibilityFontFamily,
      subtitleFontFamily: 'unknown' as unknown as AccessibilityFontFamily,
      tvClockMode: 'unknown' as unknown as TvClockMode,
      overscanX: Number.NaN,
      overscanY: Number.NEGATIVE_INFINITY,
    });
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.uiFontFamily).toBe('atkinson');
      expect(u2.value.subtitleFontFamily).toBe('opendyslexic');
      expect(u2.value.tvClockMode).toBe('never');
      expect(u2.value.overscanX).toBe(0.06);
      expect(u2.value.overscanY).toBe(0.1);
    }

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.value.uiFontFamily).toBe('system');
      expect(reset.value.subtitleFontFamily).toBe('system');
      expect(reset.value.tvClockMode).toBe('always');
      expect(reset.value.overscanX).toBe(0.05);
      expect(reset.value.overscanY).toBe(0.05);
    }
  });
});
