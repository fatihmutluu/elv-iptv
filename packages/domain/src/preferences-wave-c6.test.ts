import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave C6 preferences (#412)', () => {
  it('defaults backgroundAudioPlayback to false for single-connection IPTV safety', () => {
    expect(DEFAULT_PREFERENCES.backgroundAudioPlayback).toBe(false);
  });

  it('preserves backwards compatibility with older v1 snapshots lacking backgroundAudioPlayback', () => {
    const legacy = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'tr',
        fontScale: 1.1,
      }),
    );
    expect(legacy.backgroundAudioPlayback).toBe(false);
    expect(legacy.fontScale).toBe(1.1);
  });

  it('parses valid backgroundAudioPlayback values and falls back to false on invalid types', () => {
    const enabled = parsePreferences(
      JSON.stringify({
        version: 1,
        backgroundAudioPlayback: true,
      }),
    );
    expect(enabled.backgroundAudioPlayback).toBe(true);

    const disabled = parsePreferences(
      JSON.stringify({
        version: 1,
        backgroundAudioPlayback: false,
      }),
    );
    expect(disabled.backgroundAudioPlayback).toBe(false);

    for (const invalidValue of ['true', 1, null, {}, []]) {
      const parsed = parsePreferences(
        JSON.stringify({
          version: 1,
          backgroundAudioPlayback: invalidValue,
        }),
      );
      expect(parsed.backgroundAudioPlayback).toBe(false);
    }
  });

  it('serializes and round-trips backgroundAudioPlayback well under MAX_PREFERENCES_BYTES', () => {
    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      backgroundAudioPlayback: true,
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
      const parsed = parsePreferences(encoded.value);
      expect(parsed.backgroundAudioPlayback).toBe(true);
    }
  });

  it('merges, ignores invalid patches, and resets via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const u1 = await store.update({ backgroundAudioPlayback: true });
    expect(u1.ok).toBe(true);
    if (u1.ok) {
      expect(u1.value.backgroundAudioPlayback).toBe(true);
    }

    const u2 = await store.update({
      backgroundAudioPlayback: 'yes' as unknown as boolean,
    });
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.backgroundAudioPlayback).toBe(true);
    }

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.value.backgroundAudioPlayback).toBe(false);
    }
  });
});
