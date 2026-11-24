import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave F5B preferences — vodEnrichmentEnabled (#215)', () => {
  it('defaults vodEnrichmentEnabled to false in DEFAULT_PREFERENCES', () => {
    expect(DEFAULT_PREFERENCES.vodEnrichmentEnabled).toBe(false);
  });

  it('preserves backwards compatibility with older v1 snapshots lacking vodEnrichmentEnabled', () => {
    const legacy = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'en',
      }),
    );
    expect(legacy.vodEnrichmentEnabled).toBe(false);
  });

  it('parses boolean vodEnrichmentEnabled and falls back to false on invalid types', () => {
    expect(
      parsePreferences(JSON.stringify({ version: 1, vodEnrichmentEnabled: true }))
        .vodEnrichmentEnabled,
    ).toBe(true);
    expect(
      parsePreferences(JSON.stringify({ version: 1, vodEnrichmentEnabled: false }))
        .vodEnrichmentEnabled,
    ).toBe(false);

    for (const invalid of ['true', 'false', 1, 0, null, {}, []]) {
      const parsed = parsePreferences(
        JSON.stringify({ version: 1, vodEnrichmentEnabled: invalid }),
      );
      expect(parsed.vodEnrichmentEnabled).toBe(false);
    }
  });

  it('serializes and round-trips vodEnrichmentEnabled within MAX_PREFERENCES_BYTES', () => {
    for (const enabled of [true, false] as const) {
      const encoded = serializePreferences({
        ...DEFAULT_PREFERENCES,
        vodEnrichmentEnabled: enabled,
      });
      expect(encoded.ok).toBe(true);
      if (encoded.ok) {
        expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
          MAX_PREFERENCES_BYTES,
        );
        expect(parsePreferences(encoded.value).vodEnrichmentEnabled).toBe(enabled);
      }
    }
  });

  it('merges valid patches, ignores invalid patches, and resets via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const initial = await store.load();
    expect(initial.vodEnrichmentEnabled).toBe(false);

    const enabled = await store.update({ vodEnrichmentEnabled: true });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.value.vodEnrichmentEnabled).toBe(true);

    const invalidPatch = await store.update({
      vodEnrichmentEnabled: 'yes' as unknown as boolean,
    });
    expect(invalidPatch.ok).toBe(true);
    if (invalidPatch.ok) expect(invalidPatch.value.vodEnrichmentEnabled).toBe(true);

    const disabled = await store.update({ vodEnrichmentEnabled: false });
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.value.vodEnrichmentEnabled).toBe(false);

    await store.update({ vodEnrichmentEnabled: true });
    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.value.vodEnrichmentEnabled).toBe(false);
  });
});
