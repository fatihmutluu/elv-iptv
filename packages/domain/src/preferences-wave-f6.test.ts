import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave F6 preferences — minimizeToTray (#158) & autoEnterPip (#34)', () => {
  it('defaults minimizeToTray to false and autoEnterPip to true in DEFAULT_PREFERENCES', () => {
    expect(DEFAULT_PREFERENCES.minimizeToTray).toBe(false);
    expect(DEFAULT_PREFERENCES.autoEnterPip).toBe(true);
  });

  it('preserves backwards compatibility with older v1 snapshots lacking Wave F6 fields', () => {
    const legacy = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'en',
      }),
    );
    expect(legacy.minimizeToTray).toBe(false);
    expect(legacy.autoEnterPip).toBe(true);
  });

  it('parses boolean minimizeToTray and autoEnterPip and falls back to defaults on invalid types', () => {
    expect(
      parsePreferences(JSON.stringify({ version: 1, minimizeToTray: true })).minimizeToTray,
    ).toBe(true);
    expect(
      parsePreferences(JSON.stringify({ version: 1, minimizeToTray: false })).minimizeToTray,
    ).toBe(false);
    expect(parsePreferences(JSON.stringify({ version: 1, autoEnterPip: false })).autoEnterPip).toBe(
      false,
    );
    expect(parsePreferences(JSON.stringify({ version: 1, autoEnterPip: true })).autoEnterPip).toBe(
      true,
    );

    for (const invalid of ['true', 'false', 1, 0, null, {}, []]) {
      const parsed = parsePreferences(
        JSON.stringify({ version: 1, minimizeToTray: invalid, autoEnterPip: invalid }),
      );
      expect(parsed.minimizeToTray).toBe(false);
      expect(parsed.autoEnterPip).toBe(true);
    }
  });

  it('serializes and round-trips minimizeToTray and autoEnterPip within MAX_PREFERENCES_BYTES', () => {
    for (const minimizeToTray of [true, false] as const) {
      for (const autoEnterPip of [true, false] as const) {
        const encoded = serializePreferences({
          ...DEFAULT_PREFERENCES,
          minimizeToTray,
          autoEnterPip,
        });
        expect(encoded.ok).toBe(true);
        if (encoded.ok) {
          expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
            MAX_PREFERENCES_BYTES,
          );
          const roundTripped = parsePreferences(encoded.value);
          expect(roundTripped.minimizeToTray).toBe(minimizeToTray);
          expect(roundTripped.autoEnterPip).toBe(autoEnterPip);
        }
      }
    }
  });

  it('merges valid patches, ignores invalid patches, and resets via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const initial = await store.load();
    expect(initial.minimizeToTray).toBe(false);
    expect(initial.autoEnterPip).toBe(true);

    const updated = await store.update({ minimizeToTray: true, autoEnterPip: false });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.minimizeToTray).toBe(true);
      expect(updated.value.autoEnterPip).toBe(false);
    }

    const invalidPatch = await store.update({
      minimizeToTray: 'yes' as unknown as boolean,
      autoEnterPip: 0 as unknown as boolean,
    });
    expect(invalidPatch.ok).toBe(true);
    if (invalidPatch.ok) {
      expect(invalidPatch.value.minimizeToTray).toBe(true);
      expect(invalidPatch.value.autoEnterPip).toBe(false);
    }

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.value.minimizeToTray).toBe(false);
      expect(reset.value.autoEnterPip).toBe(true);
    }
  });
});
