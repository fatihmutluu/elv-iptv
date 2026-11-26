import { describe, expect, it } from 'vitest';
import {
  type ArtworkCacheFormFactor,
  type ArtworkCacheLimitMbPref,
  createKvPreferencesStore,
  createProfilePreferencesManager,
  DEFAULT_PREFERENCES,
  getPlatformDefaultArtworkCacheLimitMb,
  type PreferencesKvBackend,
  parsePreferences,
  serializePreferences,
} from './index';

function createMemoryKv(): { backend: PreferencesKvBackend; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    backend: {
      get: (key) => map.get(key),
      set: (key, value) => {
        map.set(key, value);
      },
      delete: (key) => {
        map.delete(key);
      },
    },
  };
}

describe('Wave P7 preferences defaults, artwork cache, and refresh intervals', () => {
  it('exposes the updated Wave P7 DEFAULT_PREFERENCES values', () => {
    expect(DEFAULT_PREFERENCES.epgTimeSpanHours).toBe(6);
    expect(DEFAULT_PREFERENCES.epgRowDensity).toBe('cinematic');
    expect(DEFAULT_PREFERENCES.epgShowClock).toBe(true);
    expect(DEFAULT_PREFERENCES.epgGenreTints).toBe(false);
    expect(DEFAULT_PREFERENCES.logoBackdropMode).toBe('off');
    expect(DEFAULT_PREFERENCES.showSourceBadges).toBe(true);
    expect(DEFAULT_PREFERENCES.liveOkTwoStepPreview).toBe(false);
    expect(DEFAULT_PREFERENCES.cleanChannelTitles).toBe(false);
    expect(DEFAULT_PREFERENCES.collapseLiveVariants).toBe(false);
    expect(DEFAULT_PREFERENCES.groupVodVersions).toBe(false);
    expect(DEFAULT_PREFERENCES.vodEnrichmentEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.oledScreensaverTimeoutMin).toBe(0);
    expect(DEFAULT_PREFERENCES.stillWatchingTimeoutMin).toBe(0);
    expect(DEFAULT_PREFERENCES.autoSubtitlesOnSkipBack).toBe(false);
    expect(DEFAULT_PREFERENCES.windowAspectRatioLock).toBe(false);
    expect(DEFAULT_PREFERENCES.minimizeToTray).toBe(true);
    expect(DEFAULT_PREFERENCES.autoFrameRate).toBe('seamless');
    expect(DEFAULT_PREFERENCES.autoDynamicRange).toBe(true);
    expect(DEFAULT_PREFERENCES.pitchLock).toBe(true);
    expect(DEFAULT_PREFERENCES.audioNormalization).toBe(false);
    expect(DEFAULT_PREFERENCES.filterSdhSubtitles).toBe(false);
    expect(DEFAULT_PREFERENCES.preferHevcOverDolbyVision).toBe(false);
    expect(DEFAULT_PREFERENCES.autoPlayNextEpisode).toBe(true);
    expect(DEFAULT_PREFERENCES.deinterlaceMode).toBe('auto');
    expect(DEFAULT_PREFERENCES.catalogRefreshHours).toBe(24);
    expect(DEFAULT_PREFERENCES.guideRefreshHours).toBe(12);
  });

  it('maps platform form factors to default artwork cache limits', () => {
    const cases: readonly (readonly [ArtworkCacheFormFactor, ArtworkCacheLimitMbPref])[] = [
      ['tv', 128],
      ['mobile', 256],
      ['desktop', 512],
    ];
    for (const [formFactor, expected] of cases) {
      expect(getPlatformDefaultArtworkCacheLimitMb(formFactor)).toBe(expected);
    }
  });

  it('accepts 512 MB artworkCacheLimitMb and 3/48 hours for both catalog and guide refresh', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        artworkCacheLimitMb: 512,
        catalogRefreshHours: 3,
        guideRefreshHours: 48,
      }),
    );
    expect(parsed.artworkCacheLimitMb).toBe(512);
    expect(parsed.catalogRefreshHours).toBe(3);
    expect(parsed.guideRefreshHours).toBe(48);

    const parsedGuide3 = parsePreferences(
      JSON.stringify({
        version: 1,
        catalogRefreshHours: 48,
        guideRefreshHours: 3,
      }),
    );
    expect(parsedGuide3.catalogRefreshHours).toBe(48);
    expect(parsedGuide3.guideRefreshHours).toBe(3);

    const encoded = serializePreferences(parsed);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(parsePreferences(encoded.value).artworkCacheLimitMb).toBe(512);
      expect(parsePreferences(encoded.value).catalogRefreshHours).toBe(3);
      expect(parsePreferences(encoded.value).guideRefreshHours).toBe(48);
    }
  });

  it('applies defaultArtworkCacheLimitMb in createKvPreferencesStore when unstored and on reset', async () => {
    const { backend } = createMemoryKv();
    const store = createKvPreferencesStore(backend, 'elv.preferences.v1', {
      defaultArtworkCacheLimitMb: 512,
    });

    const loaded = await store.load();
    expect(loaded.artworkCacheLimitMb).toBe(512);

    const updated = await store.update({ artworkCacheLimitMb: 64 });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.artworkCacheLimitMb).toBe(64);

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.value.artworkCacheLimitMb).toBe(512);
  });

  it('propagates defaultArtworkCacheLimitMb in createProfilePreferencesManager across profiles', async () => {
    const { backend } = createMemoryKv();
    const manager = createProfilePreferencesManager(backend, {
      defaultArtworkCacheLimitMb: 256,
    });

    const defSnap = await manager.load();
    expect(defSnap.artworkCacheLimitMb).toBe(256);

    const kidsSnap = await manager.switchProfile('p_kids');
    expect(kidsSnap.artworkCacheLimitMb).toBe(256);

    await manager.update({ artworkCacheLimitMb: 64 });
    const reset = await manager.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.value.artworkCacheLimitMb).toBe(256);
  });
});
