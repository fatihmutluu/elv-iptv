import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  EPG_ROW_DENSITIES,
  type EpgRowDensity,
  isEpgRowDensity,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave F0A preferences (#6, #25)', () => {
  it('exposes EPG_ROW_DENSITIES and defaults epgRowDensity to comfortable', () => {
    expect(EPG_ROW_DENSITIES).toEqual(['compact', 'comfortable', 'cinematic']);
    expect(DEFAULT_PREFERENCES.epgRowDensity).toBe('comfortable');
    expect(isEpgRowDensity('compact')).toBe(true);
    expect(isEpgRowDensity('comfortable')).toBe(true);
    expect(isEpgRowDensity('cinematic')).toBe(true);
    expect(isEpgRowDensity('dense')).toBe(false);
    expect(isEpgRowDensity(42)).toBe(false);
    expect(isEpgRowDensity(null)).toBe(false);
  });

  it('preserves backwards compatibility with older v1 snapshots lacking epgRowDensity', () => {
    const legacy = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'en',
        epgTimeSpanHours: 6,
      }),
    );
    expect(legacy.epgRowDensity).toBe('comfortable');
    expect(legacy.epgTimeSpanHours).toBe(6);
  });

  it('parses valid epgRowDensity values and falls back to comfortable on invalid values', () => {
    for (const density of EPG_ROW_DENSITIES) {
      const parsed = parsePreferences(JSON.stringify({ version: 1, epgRowDensity: density }));
      expect(parsed.epgRowDensity).toBe(density);
    }

    for (const invalid of ['', 'ultra', 1, true, null, {}, []]) {
      const parsed = parsePreferences(JSON.stringify({ version: 1, epgRowDensity: invalid }));
      expect(parsed.epgRowDensity).toBe('comfortable');
    }
  });

  it('serializes and round-trips epgRowDensity and falls back on invalid direct snapshot', () => {
    for (const density of EPG_ROW_DENSITIES) {
      const encoded = serializePreferences({
        ...DEFAULT_PREFERENCES,
        epgRowDensity: density,
      });
      expect(encoded.ok).toBe(true);
      if (encoded.ok) {
        expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
          MAX_PREFERENCES_BYTES,
        );
        expect(parsePreferences(encoded.value).epgRowDensity).toBe(density);
      }
    }

    const fallbackEncoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      epgRowDensity: 'invalid' as unknown as EpgRowDensity,
    });
    expect(fallbackEncoded.ok).toBe(true);
    if (fallbackEncoded.ok) {
      expect(parsePreferences(fallbackEncoded.value).epgRowDensity).toBe('comfortable');
    }
  });

  it('merges valid patches, ignores invalid patches, and resets via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const u1 = await store.update({ epgRowDensity: 'compact' });
    expect(u1.ok).toBe(true);
    if (u1.ok) expect(u1.value.epgRowDensity).toBe('compact');

    const u2 = await store.update({ epgRowDensity: 'cinematic' });
    expect(u2.ok).toBe(true);
    if (u2.ok) expect(u2.value.epgRowDensity).toBe('cinematic');

    const u3 = await store.update({
      epgRowDensity: 'dense' as unknown as EpgRowDensity,
    });
    expect(u3.ok).toBe(true);
    if (u3.ok) expect(u3.value.epgRowDensity).toBe('cinematic');

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.value.epgRowDensity).toBe('comfortable');
  });
});
