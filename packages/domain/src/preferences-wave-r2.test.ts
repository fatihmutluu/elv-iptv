import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  extractSyncablePreferences,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  sanitizeInitialPreferencesPatch,
  serializePreferences,
} from './index';

describe('Wave R2 preferences — detailTrailerMuted', () => {
  it('defaults detailTrailerMuted to true (muted by default) in DEFAULT_PREFERENCES', () => {
    expect(DEFAULT_PREFERENCES.detailTrailerMuted).toBe(true);
  });

  it('preserves backwards compatibility with legacy v1 payloads missing detailTrailerMuted', () => {
    const legacy = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'en',
      }),
    );
    expect(legacy.detailTrailerMuted).toBe(true);
  });

  it('parses boolean detailTrailerMuted and defaults non-boolean values cleanly to true', () => {
    expect(
      parsePreferences(JSON.stringify({ version: 1, detailTrailerMuted: false }))
        .detailTrailerMuted,
    ).toBe(false);
    expect(
      parsePreferences(JSON.stringify({ version: 1, detailTrailerMuted: true })).detailTrailerMuted,
    ).toBe(true);

    for (const invalid of ['true', 'false', 0, 1, null, {}, []]) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, detailTrailerMuted: invalid }))
          .detailTrailerMuted,
      ).toBe(true);
    }
  });

  it('serializes and round-trips detailTrailerMuted within MAX_PREFERENCES_BYTES and normalizes invalid values', () => {
    for (const detailTrailerMuted of [true, false] as const) {
      const encoded = serializePreferences({
        ...DEFAULT_PREFERENCES,
        detailTrailerMuted,
      });
      expect(encoded.ok).toBe(true);
      if (encoded.ok) {
        expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
          MAX_PREFERENCES_BYTES,
        );
        expect(parsePreferences(encoded.value).detailTrailerMuted).toBe(detailTrailerMuted);
      }
    }

    const malformed = serializePreferences({
      ...DEFAULT_PREFERENCES,
      detailTrailerMuted: 'false' as unknown as boolean,
    });
    expect(malformed.ok).toBe(true);
    if (malformed.ok) {
      expect(parsePreferences(malformed.value).detailTrailerMuted).toBe(true);
    }
  });

  it('updates, preserves on invalid patch, resets, and syncs detailTrailerMuted cleanly', async () => {
    const store = createMemoryPreferencesStore();

    const initial = await store.load();
    expect(initial.detailTrailerMuted).toBe(true);

    const unmuted = await store.update({ detailTrailerMuted: false });
    expect(unmuted.ok).toBe(true);
    if (unmuted.ok) {
      expect(unmuted.value.detailTrailerMuted).toBe(false);
    }

    const invalidPatch = await store.update({
      detailTrailerMuted: 'nope' as unknown as boolean,
    });
    expect(invalidPatch.ok).toBe(true);
    if (invalidPatch.ok) {
      expect(invalidPatch.value.detailTrailerMuted).toBe(false);
    }

    const extracted = extractSyncablePreferences({
      ...DEFAULT_PREFERENCES,
      detailTrailerMuted: false,
    });
    expect(extracted.detailTrailerMuted).toBe(false);

    expect(sanitizeInitialPreferencesPatch({ detailTrailerMuted: false })).toEqual({
      detailTrailerMuted: false,
    });
    expect(sanitizeInitialPreferencesPatch({ detailTrailerMuted: 'false' })).toEqual({});

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.value.detailTrailerMuted).toBe(true);
    }
  });
});
