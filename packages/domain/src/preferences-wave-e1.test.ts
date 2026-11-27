import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave E1 ELV Mode preferences (#511)', () => {
  it('exposes safe defaults (elvModeEnabled false in DEFAULT_PREFERENCES, sub-toggles true)', () => {
    expect(DEFAULT_PREFERENCES.elvModeEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.elvMergeVersions).toBe(true);
    expect(DEFAULT_PREFERENCES.elvEnrichMetadata).toBe(true);
    expect(DEFAULT_PREFERENCES.elvTitleFormat).toBe('original');
    expect(DEFAULT_PREFERENCES.elvCategorySource).toBe('imdb');
    expect(DEFAULT_PREFERENCES.elvSmartRecommendations).toBe(true);
    expect(DEFAULT_PREFERENCES.elvXrayEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.elvLiveEnhance).toBe(true);
    expect(DEFAULT_PREFERENCES.elvVerifyRealQuality).toBe(true);
  });

  it('omits default ELV Mode fields during serialization and round-trips non-default values within byte budget', () => {
    const defaultEncoded = serializePreferences(DEFAULT_PREFERENCES);
    expect(defaultEncoded.ok).toBe(true);
    if (defaultEncoded.ok) {
      const raw = JSON.parse(defaultEncoded.value) as Record<string, unknown>;
      expect(raw.elvModeEnabled).toBeUndefined();
      expect(raw.elvMergeVersions).toBeUndefined();
      expect(raw.elvEnrichMetadata).toBeUndefined();
      expect(raw.elvTitleFormat).toBeUndefined();
      expect(raw.elvCategorySource).toBeUndefined();
      expect(raw.elvSmartRecommendations).toBeUndefined();
      expect(raw.elvXrayEnabled).toBeUndefined();
      expect(raw.elvLiveEnhance).toBeUndefined();
      expect(raw.elvVerifyRealQuality).toBeUndefined();
    }

    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      elvModeEnabled: true,
      elvMergeVersions: false,
      elvEnrichMetadata: false,
      elvTitleFormat: 'system_original',
      elvCategorySource: 'provider',
      elvSmartRecommendations: false,
      elvXrayEnabled: false,
      elvLiveEnhance: false,
      elvVerifyRealQuality: false,
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(MAX_PREFERENCES_BYTES);

    const parsed = parsePreferences(encoded.value);
    expect(parsed.elvModeEnabled).toBe(true);
    expect(parsed.elvMergeVersions).toBe(false);
    expect(parsed.elvEnrichMetadata).toBe(false);
    expect(parsed.elvTitleFormat).toBe('system_original');
    expect(parsed.elvCategorySource).toBe('provider');
    expect(parsed.elvSmartRecommendations).toBe(false);
    expect(parsed.elvXrayEnabled).toBe(false);
    expect(parsed.elvLiveEnhance).toBe(false);
    expect(parsed.elvVerifyRealQuality).toBe(false);
  });

  it('rejects invalid ELV Mode values on parse and store update without clobbering valid state', async () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        elvModeEnabled: 'yes',
        elvMergeVersions: 0,
        elvEnrichMetadata: null,
        elvTitleFormat: 'invalid_format',
        elvCategorySource: 'tmdb',
        elvSmartRecommendations: 'nope',
        elvXrayEnabled: 123,
        elvLiveEnhance: [],
        elvVerifyRealQuality: {},
      }),
    );
    expect(parsed.elvModeEnabled).toBe(false);
    expect(parsed.elvMergeVersions).toBe(true);
    expect(parsed.elvEnrichMetadata).toBe(true);
    expect(parsed.elvTitleFormat).toBe('original');
    expect(parsed.elvCategorySource).toBe('imdb');
    expect(parsed.elvSmartRecommendations).toBe(true);
    expect(parsed.elvXrayEnabled).toBe(true);
    expect(parsed.elvLiveEnhance).toBe(true);
    expect(parsed.elvVerifyRealQuality).toBe(true);

    const store = createMemoryPreferencesStore();
    await store.load();
    const updated = await store.update({
      elvModeEnabled: true,
      elvTitleFormat: 'english_system',
      elvCategorySource: 'provider',
      elvXrayEnabled: false,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.elvModeEnabled).toBe(true);
    expect(updated.value.elvTitleFormat).toBe('english_system');
    expect(updated.value.elvCategorySource).toBe('provider');
    expect(updated.value.elvXrayEnabled).toBe(false);
    expect(updated.value.elvMergeVersions).toBe(true);

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.value.elvModeEnabled).toBe(false);
    expect(reset.value.elvTitleFormat).toBe('original');
    expect(reset.value.elvCategorySource).toBe('imdb');
    expect(reset.value.elvXrayEnabled).toBe(true);
  });
});
