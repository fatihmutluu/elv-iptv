import { describe, expect, it } from 'vitest';
import {
  type CatalogRefreshHoursPref,
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type GuideRefreshHoursPref,
  type LiveChannelSwitchModePref,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave C2 Live TV & EPG preferences (#68, #251)', () => {
  it('exposes Wave C2 defaults on DEFAULT_PREFERENCES', () => {
    expect(DEFAULT_PREFERENCES.guideRefreshHours).toBe(12);
    expect(DEFAULT_PREFERENCES.catalogRefreshHours).toBe(24);
    expect(DEFAULT_PREFERENCES.liveChannelSwitchMode).toBe('instant');
  });

  it('accepts 0 (manual only) and all valid intervals for guideRefreshHours and catalogRefreshHours', () => {
    const guideHours: readonly GuideRefreshHoursPref[] = [0, 6, 12, 24];
    for (const guideRefreshHours of guideHours) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, guideRefreshHours })).guideRefreshHours,
      ).toBe(guideRefreshHours);
    }

    const catalogHours: readonly CatalogRefreshHoursPref[] = [0, 6, 12, 24, 48];
    for (const catalogRefreshHours of catalogHours) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, catalogRefreshHours })).catalogRefreshHours,
      ).toBe(catalogRefreshHours);
    }

    const switchModes: readonly LiveChannelSwitchModePref[] = ['instant', 'preview'];
    for (const liveChannelSwitchMode of switchModes) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, liveChannelSwitchMode }))
          .liveChannelSwitchMode,
      ).toBe(liveChannelSwitchMode);
    }
  });

  it('falls back to defaults for invalid guideRefreshHours, catalogRefreshHours, and liveChannelSwitchMode', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        guideRefreshHours: 48,
        catalogRefreshHours: 72,
        liveChannelSwitchMode: 'manual',
      }),
    );
    expect(parsed.guideRefreshHours).toBe(12);
    expect(parsed.catalogRefreshHours).toBe(24);
    expect(parsed.liveChannelSwitchMode).toBe('instant');

    for (const bad of [-1, 3, '12', null, true]) {
      const p = parsePreferences(
        JSON.stringify({
          version: 1,
          guideRefreshHours: bad,
          catalogRefreshHours: bad,
          liveChannelSwitchMode: bad,
        }),
      );
      expect(p.guideRefreshHours).toBe(12);
      expect(p.catalogRefreshHours).toBe(24);
      expect(p.liveChannelSwitchMode).toBe('instant');
    }
  });

  it('normalizes invalid values during direct serializePreferences and round-trips valid values', () => {
    const valid = serializePreferences({
      ...DEFAULT_PREFERENCES,
      guideRefreshHours: 0,
      catalogRefreshHours: 48,
      liveChannelSwitchMode: 'preview',
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(new TextEncoder().encode(valid.value).byteLength).toBeLessThan(MAX_PREFERENCES_BYTES);
      const parsed = parsePreferences(valid.value);
      expect(parsed.guideRefreshHours).toBe(0);
      expect(parsed.catalogRefreshHours).toBe(48);
      expect(parsed.liveChannelSwitchMode).toBe('preview');
    }

    const invalid = serializePreferences({
      ...DEFAULT_PREFERENCES,
      guideRefreshHours: 99 as unknown as GuideRefreshHoursPref,
      catalogRefreshHours: 99 as unknown as CatalogRefreshHoursPref,
      liveChannelSwitchMode: 'bogus' as unknown as LiveChannelSwitchModePref,
    });
    expect(invalid.ok).toBe(true);
    if (invalid.ok) {
      const parsed = parsePreferences(invalid.value);
      expect(parsed.guideRefreshHours).toBe(12);
      expect(parsed.catalogRefreshHours).toBe(24);
      expect(parsed.liveChannelSwitchMode).toBe('instant');
    }
  });

  it('merges, preserves on invalid patch, and resets Wave C2 fields via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const u1 = await store.update({
      guideRefreshHours: 0,
      catalogRefreshHours: 0,
      liveChannelSwitchMode: 'preview',
    });
    expect(u1.ok).toBe(true);
    if (u1.ok) {
      expect(u1.value.guideRefreshHours).toBe(0);
      expect(u1.value.catalogRefreshHours).toBe(0);
      expect(u1.value.liveChannelSwitchMode).toBe('preview');
    }

    const u2 = await store.update({
      guideRefreshHours: 99 as unknown as GuideRefreshHoursPref,
      catalogRefreshHours: 99 as unknown as CatalogRefreshHoursPref,
      liveChannelSwitchMode: 'bogus' as unknown as LiveChannelSwitchModePref,
    });
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.guideRefreshHours).toBe(0);
      expect(u2.value.catalogRefreshHours).toBe(0);
      expect(u2.value.liveChannelSwitchMode).toBe('preview');
    }

    const u3 = await store.update({
      guideRefreshHours: 6,
      catalogRefreshHours: 48,
      liveChannelSwitchMode: 'instant',
    });
    expect(u3.ok).toBe(true);
    if (u3.ok) {
      expect(u3.value.guideRefreshHours).toBe(6);
      expect(u3.value.catalogRefreshHours).toBe(48);
      expect(u3.value.liveChannelSwitchMode).toBe('instant');
    }

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.value.guideRefreshHours).toBe(12);
      expect(reset.value.catalogRefreshHours).toBe(24);
      expect(reset.value.liveChannelSwitchMode).toBe('instant');
    }
  });
});
