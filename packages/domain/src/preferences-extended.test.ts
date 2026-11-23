import { describe, expect, it } from 'vitest';
import {
  ANDROID_DECODER_MODES,
  type AndroidDecoderMode,
  type ArtworkCacheLimitMbPref,
  createKvPreferencesStore,
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type DefaultLiveModePref,
  type DefaultResizeModePref,
  type EpgTimeSpanHoursPref,
  type GuideRefreshHoursPref,
  isAndroidDecoderMode,
  type LogoBackdropModePref,
  MAX_PREFERENCES_BYTES,
  type OsdTimeDisplayMode,
  type PreferencesKvBackend,
  type PreferencesSnapshot,
  parsePreferences,
  type SeekStepSecPref,
  type SleepTimerAction,
  type SubtitleModePref,
  serializePreferences,
} from './index';

describe('Wave P3 extended preferences schema (#401, #405, #126, #145)', () => {
  it('includes all 15 new preference defaults on DEFAULT_PREFERENCES', () => {
    expect(DEFAULT_PREFERENCES.preferredAudioLang).toBe('');
    expect(DEFAULT_PREFERENCES.preferredSubtitleLang).toBe('');
    expect(DEFAULT_PREFERENCES.subtitleMode).toBe('smart');
    expect(DEFAULT_PREFERENCES.seekStepSec).toBe(10);
    expect(DEFAULT_PREFERENCES.defaultResizeMode).toBe('fit');
    expect(DEFAULT_PREFERENCES.epgTimeSpanHours).toBe(3);
    expect(DEFAULT_PREFERENCES.epgGenreTints).toBe(true);
    expect(DEFAULT_PREFERENCES.epgShowClock).toBe(true);
    expect(DEFAULT_PREFERENCES.defaultLiveMode).toBe('favorites');
    expect(DEFAULT_PREFERENCES.guideRefreshHours).toBe(12);
    expect(DEFAULT_PREFERENCES.logoBackdropMode).toBe('plate');
    expect(DEFAULT_PREFERENCES.showSourceBadges).toBe(true);
    expect(DEFAULT_PREFERENCES.liveOkTwoStepPreview).toBe(false);
    expect(DEFAULT_PREFERENCES.cleanChannelTitles).toBe(false);
    expect(DEFAULT_PREFERENCES.artworkCacheLimitMb).toBe(128);
  });

  it('parses all valid union and boolean values across the new preference fields', () => {
    const subtitleModes: readonly SubtitleModePref[] = [
      'default',
      'smart',
      'onlyForced',
      'always',
      'off',
    ];
    for (const subtitleMode of subtitleModes) {
      expect(parsePreferences(JSON.stringify({ version: 1, subtitleMode })).subtitleMode).toBe(
        subtitleMode,
      );
    }

    const seekSteps: readonly SeekStepSecPref[] = [5, 10, 15, 30];
    for (const seekStepSec of seekSteps) {
      expect(parsePreferences(JSON.stringify({ version: 1, seekStepSec })).seekStepSec).toBe(
        seekStepSec,
      );
    }

    const resizeModes: readonly DefaultResizeModePref[] = ['fit', 'fill', 'stretch'];
    for (const defaultResizeMode of resizeModes) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, defaultResizeMode })).defaultResizeMode,
      ).toBe(defaultResizeMode);
    }

    const epgSpans: readonly EpgTimeSpanHoursPref[] = [2, 3, 6];
    for (const epgTimeSpanHours of epgSpans) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, epgTimeSpanHours })).epgTimeSpanHours,
      ).toBe(epgTimeSpanHours);
    }

    const liveModes: readonly DefaultLiveModePref[] = ['favorites', 'channels', 'epg'];
    for (const defaultLiveMode of liveModes) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, defaultLiveMode })).defaultLiveMode,
      ).toBe(defaultLiveMode);
    }

    const refreshHours: readonly GuideRefreshHoursPref[] = [6, 12, 24];
    for (const guideRefreshHours of refreshHours) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, guideRefreshHours })).guideRefreshHours,
      ).toBe(guideRefreshHours);
    }

    const backdropModes: readonly LogoBackdropModePref[] = ['plate', 'invert', 'off'];
    for (const logoBackdropMode of backdropModes) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, logoBackdropMode })).logoBackdropMode,
      ).toBe(logoBackdropMode);
    }

    const cacheLimits: readonly ArtworkCacheLimitMbPref[] = [64, 128, 256];
    for (const artworkCacheLimitMb of cacheLimits) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, artworkCacheLimitMb })).artworkCacheLimitMb,
      ).toBe(artworkCacheLimitMb);
    }

    const booleans = parsePreferences(
      JSON.stringify({
        version: 1,
        epgGenreTints: false,
        epgShowClock: false,
        showSourceBadges: false,
        liveOkTwoStepPreview: true,
        cleanChannelTitles: true,
      }),
    );
    expect(booleans.epgGenreTints).toBe(false);
    expect(booleans.epgShowClock).toBe(false);
    expect(booleans.showSourceBadges).toBe(false);
    expect(booleans.liveOkTwoStepPreview).toBe(true);
    expect(booleans.cleanChannelTitles).toBe(true);
  });

  it('normalizes valid BCP-47/ISO language preferences and rejects malformed or oversized values', () => {
    const validCases: ReadonlyArray<readonly [string, string]> = [
      ['en', 'en'],
      ['  TR-tr  ', 'tr-tr'],
      ['eng', 'eng'],
      ['zh-Hans', 'zh-hans'],
      ['es-419', 'es-419'],
      ['abc-12345678', 'abc-12345678'],
      ['', ''],
      ['   ', ''],
    ];
    for (const [input, expected] of validCases) {
      const parsed = parsePreferences(
        JSON.stringify({
          version: 1,
          preferredAudioLang: input,
          preferredSubtitleLang: input,
        }),
      );
      expect(parsed.preferredAudioLang).toBe(expected);
      expect(parsed.preferredSubtitleLang).toBe(expected);
    }

    const invalidInputs: readonly unknown[] = [
      'a',
      'abcd',
      'en_US',
      'en-a',
      'en-US-x-1',
      'abc-123456789',
      '123',
      'en!',
      42,
      null,
      true,
      ['en'],
    ];
    for (const bad of invalidInputs) {
      const parsed = parsePreferences(
        JSON.stringify({
          version: 1,
          preferredAudioLang: bad,
          preferredSubtitleLang: bad,
        }),
      );
      expect(parsed.preferredAudioLang).toBe('');
      expect(parsed.preferredSubtitleLang).toBe('');
    }
  });

  it('falls back per field to defaults when extended fields have invalid types or values', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        preferredAudioLang: 'invalid_lang',
        preferredSubtitleLang: 99,
        subtitleMode: 'forced',
        seekStepSec: 20,
        defaultResizeMode: 'zoom',
        epgTimeSpanHours: 4,
        epgGenreTints: 'yes',
        epgShowClock: 0,
        defaultLiveMode: 'watch',
        guideRefreshHours: 1,
        logoBackdropMode: 'glow',
        showSourceBadges: 'true',
        liveOkTwoStepPreview: 1,
        cleanChannelTitles: 'false',
        artworkCacheLimitMb: 512,
      }),
    );
    expect(parsed).toEqual(DEFAULT_PREFERENCES);
  });

  it('serializes a fully populated snapshot well under 1500 bytes (and MAX_PREFERENCES_BYTES) and round-trips cleanly', () => {
    const full: PreferencesSnapshot = {
      version: 1,
      themePreset: 'obsidianCrimson',
      locale: 'tr-TR',
      fontScale: 1.15,
      reduceMotion: true,
      bufferPreset: 'large',
      useTextureView: true,
      autoSubtitlesOnSkipBack: true,
      autoPlayNextEpisode: false,
      playerVolume: 85,
      preferredAudioLang: 'abc-12345678',
      preferredSubtitleLang: 'zh-hant',
      preferredAudioLanguages: ['abc-12345678'],
      preferredSubtitleLanguages: ['zh-hant'],
      preferDefaultAudioTrack: false,
      preferHevcOverDolbyVision: true,
      filterSdhSubtitles: true,
      subtitleMode: 'always',
      seekStepSec: 30,
      defaultResizeMode: 'stretch',
      osdTimeDisplayMode: 'endsAt',
      oledScreensaverTimeoutMin: 15,
      stillWatchingTimeoutMin: 180,
      sleepTimerDefaultAction: 'pause',
      epgTimeSpanHours: 6,
      epgGenreTints: false,
      epgShowClock: false,
      defaultLiveMode: 'channels',
      guideRefreshHours: 24,
      catalogRefreshHours: 48,
      liveChannelSwitchMode: 'preview',
      logoBackdropMode: 'invert',
      showSourceBadges: false,
      liveOkTwoStepPreview: true,
      cleanChannelTitles: true,
      artworkCacheLimitMb: 256,
      confirmExitOnBack: false,
      preferredAudioDevice: 'wasapi/{0.0.0.00000000}.{11111111-2222-3333-4444-555555555555}',
      androidDecoderMode: 'hardware',
      collapseLiveVariants: true,
      groupVodVersions: false,
    };

    const encoded = serializePreferences(full);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      const byteLen = new TextEncoder().encode(encoded.value).byteLength;
      expect(byteLen).toBeLessThan(1700);
      expect(byteLen).toBeLessThan(MAX_PREFERENCES_BYTES);
      expect(parsePreferences(encoded.value)).toEqual(full);
    }
  });

  it('normalizes invalid extended values during direct serializePreferences calls', () => {
    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      preferredAudioLang: '  EN-us ',
      preferredSubtitleLang: 'not_valid',
      subtitleMode: 'bogus' as unknown as SubtitleModePref,
      seekStepSec: 99 as unknown as SeekStepSecPref,
      defaultResizeMode: 'bogus' as unknown as DefaultResizeModePref,
      epgTimeSpanHours: 10 as unknown as EpgTimeSpanHoursPref,
      defaultLiveMode: 'bogus' as unknown as DefaultLiveModePref,
      guideRefreshHours: 48 as unknown as GuideRefreshHoursPref,
      logoBackdropMode: 'bogus' as unknown as LogoBackdropModePref,
      artworkCacheLimitMb: 1024 as unknown as ArtworkCacheLimitMbPref,
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(parsePreferences(encoded.value)).toEqual({
        ...DEFAULT_PREFERENCES,
        preferredAudioLang: 'en-us',
        preferredAudioLanguages: ['en-us'],
        preferredSubtitleLang: '',
        preferredSubtitleLanguages: [],
      });
    }
  });

  it('updates, clears, validates, persists, and resets all extended fields through PreferencesStore', async () => {
    const map = new Map<string, string>();
    const backend: PreferencesKvBackend = {
      get: (k) => map.get(k),
      set: (k, v) => {
        map.set(k, v);
      },
      delete: (k) => {
        map.delete(k);
      },
    };
    const kvStore = createKvPreferencesStore(backend);

    const updated = await kvStore.update({
      preferredAudioLang: '  TR-tr ',
      preferredSubtitleLang: 'EN',
      subtitleMode: 'always',
      seekStepSec: 15,
      defaultResizeMode: 'fill',
      epgTimeSpanHours: 6,
      epgGenreTints: false,
      epgShowClock: false,
      defaultLiveMode: 'epg',
      guideRefreshHours: 24,
      logoBackdropMode: 'off',
      showSourceBadges: false,
      liveOkTwoStepPreview: true,
      cleanChannelTitles: true,
      artworkCacheLimitMb: 64,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value).toEqual({
        ...DEFAULT_PREFERENCES,
        preferredAudioLang: 'tr-tr',
        preferredAudioLanguages: ['tr-tr'],
        preferredSubtitleLang: 'en',
        preferredSubtitleLanguages: ['en'],
        subtitleMode: 'always',
        seekStepSec: 15,
        defaultResizeMode: 'fill',
        epgTimeSpanHours: 6,
        epgGenreTints: false,
        epgShowClock: false,
        defaultLiveMode: 'epg',
        guideRefreshHours: 24,
        logoBackdropMode: 'off',
        showSourceBadges: false,
        liveOkTwoStepPreview: true,
        cleanChannelTitles: true,
        artworkCacheLimitMb: 64,
      });
    }

    // Clearing language preferences back to automatic ('') works
    const cleared = await kvStore.update({
      preferredAudioLang: '',
      preferredSubtitleLang: '   ',
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.preferredAudioLang).toBe('');
      expect(cleared.value.preferredSubtitleLang).toBe('');
    }

    // Invalid union patches preserve previously committed valid values
    const ignoredInvalid = await kvStore.update({
      subtitleMode: 'invalid' as unknown as SubtitleModePref,
      seekStepSec: 99 as unknown as SeekStepSecPref,
      defaultResizeMode: 'crop' as unknown as DefaultResizeModePref,
      epgTimeSpanHours: 5 as unknown as EpgTimeSpanHoursPref,
      defaultLiveMode: 'invalid' as unknown as DefaultLiveModePref,
      guideRefreshHours: 3 as unknown as GuideRefreshHoursPref,
      logoBackdropMode: 'shadow' as unknown as LogoBackdropModePref,
      artworkCacheLimitMb: 32 as unknown as ArtworkCacheLimitMbPref,
    });
    expect(ignoredInvalid.ok).toBe(true);
    if (ignoredInvalid.ok) {
      expect(ignoredInvalid.value.subtitleMode).toBe('always');
      expect(ignoredInvalid.value.seekStepSec).toBe(15);
      expect(ignoredInvalid.value.defaultResizeMode).toBe('fill');
      expect(ignoredInvalid.value.epgTimeSpanHours).toBe(6);
      expect(ignoredInvalid.value.defaultLiveMode).toBe('epg');
      expect(ignoredInvalid.value.guideRefreshHours).toBe(24);
      expect(ignoredInvalid.value.logoBackdropMode).toBe('off');
      expect(ignoredInvalid.value.artworkCacheLimitMb).toBe(64);
    }

    // Reloading from backend preserves persisted values
    const reloaded = await createKvPreferencesStore(backend).load();
    expect(reloaded.seekStepSec).toBe(15);
    expect(reloaded.artworkCacheLimitMb).toBe(64);
    expect(reloaded.liveOkTwoStepPreview).toBe(true);

    // Memory store seeds and resets extended fields cleanly
    const memStore = createMemoryPreferencesStore({
      seekStepSec: 5,
      logoBackdropMode: 'invert',
      cleanChannelTitles: true,
    });
    const memLoaded = await memStore.load();
    expect(memLoaded.seekStepSec).toBe(5);
    expect(memLoaded.logoBackdropMode).toBe('invert');
    expect(memLoaded.cleanChannelTitles).toBe(true);

    const reset = await memStore.reset();
    expect(reset).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
  });
});

describe('Wave P4 ergonomics preferences (#55, #408)', () => {
  it('defaults confirmExitOnBack to true and preferredAudioDevice to auto', () => {
    expect(DEFAULT_PREFERENCES.confirmExitOnBack).toBe(true);
    expect(DEFAULT_PREFERENCES.preferredAudioDevice).toBe('auto');
  });

  it('parses, trims, and validates confirmExitOnBack and preferredAudioDevice', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        confirmExitOnBack: false,
        preferredAudioDevice: '  wasapi/{abc-123}  ',
      }),
    );
    expect(parsed.confirmExitOnBack).toBe(false);
    expect(parsed.preferredAudioDevice).toBe('wasapi/{abc-123}');

    // Exactly 160 chars is accepted
    const maxLen = 'd'.repeat(160);
    expect(
      parsePreferences(JSON.stringify({ version: 1, preferredAudioDevice: `  ${maxLen}  ` }))
        .preferredAudioDevice,
    ).toBe(maxLen);

    // Invalid types, empty/blank, >160 chars, and control characters fall back to defaults
    const invalidDevices: readonly unknown[] = [
      '',
      '   ',
      'd'.repeat(161),
      'wasapi/dev\u0000id',
      'wasapi/dev\nid',
      'wasapi/dev\rid',
      'wasapi/dev\tid',
      'wasapi/dev\u001fid',
      'wasapi/dev\u007fid',
      '\nwasapi/dev',
      42,
      null,
      true,
      ['auto'],
    ];
    for (const bad of invalidDevices) {
      const res = parsePreferences(
        JSON.stringify({
          version: 1,
          confirmExitOnBack: 'no',
          preferredAudioDevice: bad,
        }),
      );
      expect(res.confirmExitOnBack).toBe(true);
      expect(res.preferredAudioDevice).toBe('auto');
    }
  });

  it('keeps a maximal serialized snapshot (with 160-char audio device) well under 1700 bytes', () => {
    const maximal: PreferencesSnapshot = {
      ...DEFAULT_PREFERENCES,
      themePreset: 'obsidianCrimson',
      locale: 'tr-TR',
      fontScale: 1.15,
      reduceMotion: true,
      bufferPreset: 'large',
      useTextureView: true,
      autoSubtitlesOnSkipBack: true,
      autoPlayNextEpisode: false,
      playerVolume: 85,
      preferredAudioLang: 'abc-12345678',
      preferredSubtitleLang: 'zh-hant',
      preferredAudioLanguages: ['abc-12345678'],
      preferredSubtitleLanguages: ['zh-hant'],
      preferDefaultAudioTrack: false,
      preferHevcOverDolbyVision: true,
      filterSdhSubtitles: true,
      subtitleMode: 'always',
      seekStepSec: 30,
      defaultResizeMode: 'stretch',
      osdTimeDisplayMode: 'endsAt',
      oledScreensaverTimeoutMin: 15,
      stillWatchingTimeoutMin: 180,
      sleepTimerDefaultAction: 'pause',
      epgTimeSpanHours: 6,
      epgGenreTints: false,
      epgShowClock: false,
      defaultLiveMode: 'channels',
      guideRefreshHours: 24,
      catalogRefreshHours: 48,
      liveChannelSwitchMode: 'preview',
      logoBackdropMode: 'invert',
      showSourceBadges: false,
      liveOkTwoStepPreview: true,
      cleanChannelTitles: true,
      artworkCacheLimitMb: 256,
      confirmExitOnBack: false,
      preferredAudioDevice: `wasapi/${'x'.repeat(153)}`,
    };
    const encoded = serializePreferences(maximal);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      const byteLen = new TextEncoder().encode(encoded.value).byteLength;
      expect(byteLen).toBeLessThan(1700);
      expect(byteLen).toBeLessThan(MAX_PREFERENCES_BYTES);
      expect(parsePreferences(encoded.value)).toEqual(maximal);
    }
  });

  it('normalizes invalid preferredAudioDevice during direct serializePreferences and store updates', async () => {
    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      preferredAudioDevice: 'bad\u0007device',
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(parsePreferences(encoded.value).preferredAudioDevice).toBe('auto');
    }

    const store = createMemoryPreferencesStore();
    const u1 = await store.update({
      confirmExitOnBack: false,
      preferredAudioDevice: '  pulse/alsa_output.pci  ',
    });
    expect(u1.ok).toBe(true);
    if (u1.ok) {
      expect(u1.value.confirmExitOnBack).toBe(false);
      expect(u1.value.preferredAudioDevice).toBe('pulse/alsa_output.pci');
    }

    // Passing non-boolean/non-string preserves previous values
    const u2 = await store.update({
      confirmExitOnBack: 'false' as unknown as boolean,
      preferredAudioDevice: 123 as unknown as string,
    });
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.confirmExitOnBack).toBe(false);
      expect(u2.value.preferredAudioDevice).toBe('pulse/alsa_output.pci');
    }

    // Passing blank or control-char string resets preferredAudioDevice to 'auto'
    const u3 = await store.update({ preferredAudioDevice: '   ' });
    expect(u3.ok && u3.value.preferredAudioDevice).toBe('auto');
  });
});

describe('Wave P5 Android decoder mode preference (#411)', () => {
  it('exposes ANDROID_DECODER_MODES, isAndroidDecoderMode, and default auto mode', () => {
    expect(ANDROID_DECODER_MODES).toEqual(['auto', 'hardware', 'software']);
    expect(DEFAULT_PREFERENCES.androidDecoderMode).toBe('auto');
    expect(isAndroidDecoderMode('auto')).toBe(true);
    expect(isAndroidDecoderMode('hardware')).toBe(true);
    expect(isAndroidDecoderMode('software')).toBe(true);
    expect(isAndroidDecoderMode('hybrid')).toBe(false);
    expect(isAndroidDecoderMode(null)).toBe(false);
    expect(isAndroidDecoderMode(123)).toBe(false);
  });

  it('parses valid androidDecoderMode values and falls back on invalid values', () => {
    for (const androidDecoderMode of ANDROID_DECODER_MODES) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, androidDecoderMode })).androidDecoderMode,
      ).toBe(androidDecoderMode);
    }

    for (const bad of ['', 'hw', 'sw', 'AUTO', 0, true, null, ['software']]) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, androidDecoderMode: bad }))
          .androidDecoderMode,
      ).toBe('auto');
    }
  });

  it('serializes, merges, validates, persists, and resets androidDecoderMode within byte budget', async () => {
    const normalized = serializePreferences({
      ...DEFAULT_PREFERENCES,
      androidDecoderMode: 'invalid' as unknown as AndroidDecoderMode,
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(parsePreferences(normalized.value).androidDecoderMode).toBe('auto');
      expect(new TextEncoder().encode(normalized.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
    }

    const store = createMemoryPreferencesStore();
    const u1 = await store.update({ androidDecoderMode: 'software' });
    expect(u1.ok && u1.value.androidDecoderMode).toBe('software');

    const u2 = await store.update({
      androidDecoderMode: 'bogus' as unknown as AndroidDecoderMode,
    });
    expect(u2.ok && u2.value.androidDecoderMode).toBe('software');

    const u3 = await store.update({ androidDecoderMode: 'hardware' });
    expect(u3.ok && u3.value.androidDecoderMode).toBe('hardware');

    const reset = await store.reset();
    expect(reset.ok && reset.value.androidDecoderMode).toBe('auto');
  });
});

describe('Wave C1 cinema player preferences (#124, #393, #310, #160, #118)', () => {
  it('exposes safe defaults for all Wave C1 preference fields', () => {
    expect(DEFAULT_PREFERENCES.subtitleMode).toBe('smart');
    expect(DEFAULT_PREFERENCES.preferredAudioLanguages).toEqual([]);
    expect(DEFAULT_PREFERENCES.preferredSubtitleLanguages).toEqual([]);
    expect(DEFAULT_PREFERENCES.preferDefaultAudioTrack).toBe(true);
    expect(DEFAULT_PREFERENCES.preferHevcOverDolbyVision).toBe(false);
    expect(DEFAULT_PREFERENCES.filterSdhSubtitles).toBe(false);
    expect(DEFAULT_PREFERENCES.osdTimeDisplayMode).toBe('total');
    expect(DEFAULT_PREFERENCES.oledScreensaverTimeoutMin).toBe(0);
    expect(DEFAULT_PREFERENCES.stillWatchingTimeoutMin).toBe(0);
    expect(DEFAULT_PREFERENCES.sleepTimerDefaultAction).toBe('stop');
  });

  it('maps legacy subtitleMode values auto -> smart and none -> off', () => {
    expect(
      parsePreferences(JSON.stringify({ version: 1, subtitleMode: 'auto' })).subtitleMode,
    ).toBe('smart');
    expect(
      parsePreferences(JSON.stringify({ version: 1, subtitleMode: 'none' })).subtitleMode,
    ).toBe('off');
    expect(
      parsePreferences(JSON.stringify({ version: 1, subtitleMode: 'onlyForced' })).subtitleMode,
    ).toBe('onlyForced');
    expect(
      parsePreferences(JSON.stringify({ version: 1, subtitleMode: 'default' })).subtitleMode,
    ).toBe('default');
  });

  it('normalizes, deduplicates, caps at 5, and syncs preferredAudioLanguages / preferredSubtitleLanguages', async () => {
    const seeded = parsePreferences(
      JSON.stringify({ version: 1, preferredAudioLang: '  TR ', preferredSubtitleLang: 'EN-us' }),
    );
    expect(seeded.preferredAudioLanguages).toEqual(['tr']);
    expect(seeded.preferredAudioLang).toBe('tr');
    expect(seeded.preferredSubtitleLanguages).toEqual(['en-us']);
    expect(seeded.preferredSubtitleLang).toBe('en-us');

    const fromArray = parsePreferences(
      JSON.stringify({
        version: 1,
        preferredAudioLang: 'fr',
        preferredAudioLanguages: [
          '  TR ',
          'en',
          'tr',
          'und',
          'bad_lang',
          42,
          'de',
          'fr',
          'es',
          'it',
        ],
        preferredSubtitleLanguages: ['en', 'tr', 'EN'],
      }),
    );
    expect(fromArray.preferredAudioLanguages).toEqual(['tr', 'en', 'de', 'fr', 'es']);
    expect(fromArray.preferredAudioLang).toBe('tr');
    expect(fromArray.preferredSubtitleLanguages).toEqual(['en', 'tr']);
    expect(fromArray.preferredSubtitleLang).toBe('en');

    const clearedArray = parsePreferences(
      JSON.stringify({ version: 1, preferredAudioLang: 'tr', preferredAudioLanguages: [] }),
    );
    expect(clearedArray.preferredAudioLanguages).toEqual([]);
    expect(clearedArray.preferredAudioLang).toBe('');

    const store = createMemoryPreferencesStore();
    const u1 = await store.update({
      preferredAudioLanguages: ['de', 'en', 'tr'],
      preferredSubtitleLanguages: ['tr', 'en'],
    });
    expect(u1.ok && u1.value.preferredAudioLang).toBe('de');
    expect(u1.ok && u1.value.preferredAudioLanguages).toEqual(['de', 'en', 'tr']);
    expect(u1.ok && u1.value.preferredSubtitleLang).toBe('tr');
    expect(u1.ok && u1.value.preferredSubtitleLanguages).toEqual(['tr', 'en']);

    const u2 = await store.update({ preferredAudioLang: 'ja' });
    expect(u2.ok && u2.value.preferredAudioLang).toBe('ja');
    expect(u2.ok && u2.value.preferredAudioLanguages).toEqual(['ja']);

    const u3 = await store.update({ preferredAudioLanguages: [] });
    expect(u3.ok && u3.value.preferredAudioLang).toBe('');
    expect(u3.ok && u3.value.preferredAudioLanguages).toEqual([]);
  });

  it('validates and clamps osdTimeDisplayMode, sleepTimerDefaultAction, timeouts, and booleans', async () => {
    const osdModes: readonly OsdTimeDisplayMode[] = ['total', 'remaining', 'endsAt'];
    for (const osdTimeDisplayMode of osdModes) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, osdTimeDisplayMode })).osdTimeDisplayMode,
      ).toBe(osdTimeDisplayMode);
    }
    const actions: readonly SleepTimerAction[] = ['stop', 'pause'];
    for (const sleepTimerDefaultAction of actions) {
      expect(
        parsePreferences(JSON.stringify({ version: 1, sleepTimerDefaultAction }))
          .sleepTimerDefaultAction,
      ).toBe(sleepTimerDefaultAction);
    }

    const clamped = parsePreferences(
      JSON.stringify({
        version: 1,
        oledScreensaverTimeoutMin: 90,
        stillWatchingTimeoutMin: 999,
        preferDefaultAudioTrack: false,
        preferHevcOverDolbyVision: true,
        filterSdhSubtitles: true,
      }),
    );
    expect(clamped.oledScreensaverTimeoutMin).toBe(60);
    expect(clamped.stillWatchingTimeoutMin).toBe(480);
    expect(clamped.preferDefaultAudioTrack).toBe(false);
    expect(clamped.preferHevcOverDolbyVision).toBe(true);
    expect(clamped.filterSdhSubtitles).toBe(true);

    const neg = parsePreferences(
      JSON.stringify({ version: 1, oledScreensaverTimeoutMin: -5, stillWatchingTimeoutMin: -0.2 }),
    );
    expect(Object.is(neg.oledScreensaverTimeoutMin, 0)).toBe(true);
    expect(Object.is(neg.stillWatchingTimeoutMin, 0)).toBe(true);

    const invalid = parsePreferences(
      JSON.stringify({
        version: 1,
        osdTimeDisplayMode: 'clock',
        sleepTimerDefaultAction: 'quit',
        oledScreensaverTimeoutMin: '15',
        stillWatchingTimeoutMin: Number.NaN,
        preferDefaultAudioTrack: 'no',
        preferHevcOverDolbyVision: 1,
        filterSdhSubtitles: 'yes',
      }),
    );
    expect(invalid).toEqual(DEFAULT_PREFERENCES);

    const store = createMemoryPreferencesStore();
    const u = await store.update({
      osdTimeDisplayMode: 'remaining',
      sleepTimerDefaultAction: 'pause',
      oledScreensaverTimeoutMin: 10.4,
      stillWatchingTimeoutMin: 120.6,
      preferDefaultAudioTrack: false,
      preferHevcOverDolbyVision: true,
      filterSdhSubtitles: true,
    });
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.value.osdTimeDisplayMode).toBe('remaining');
      expect(u.value.sleepTimerDefaultAction).toBe('pause');
      expect(u.value.oledScreensaverTimeoutMin).toBe(10);
      expect(u.value.stillWatchingTimeoutMin).toBe(121);
      expect(u.value.preferDefaultAudioTrack).toBe(false);
      expect(u.value.preferHevcOverDolbyVision).toBe(true);
      expect(u.value.filterSdhSubtitles).toBe(true);
    }

    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      preferredAudioLanguages: ['tr', 'en', 'de', 'fr', 'es'],
      preferredSubtitleLanguages: ['tr', 'en', 'de', 'fr', 'es'],
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
    }
  });
});
