import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  extractSyncablePreferences,
  type PreferencesSnapshot,
  SYNCABLE_PREFERENCE_KEYS,
  sanitizeInitialPreferencesPatch,
} from './index';

describe('syncable-preferences (Product Decision #40)', () => {
  it('extracts strictly allowlisted visual/editorial/language/playback-style keys and excludes hardware/device-local prefs', () => {
    const snapshot: PreferencesSnapshot = {
      ...DEFAULT_PREFERENCES,
      themePreset: 'midnightGold',
      fontScale: 1.1,
      reduceMotion: true,
      locale: 'tr',
      defaultResizeMode: 'fill',
      osdTimeDisplayMode: 'remaining',
      epgTimeSpanHours: 6,
      epgRowDensity: 'compact',
      epgGenreTints: false,
      epgShowClock: false,
      defaultLiveMode: 'epg',
      logoBackdropMode: 'invert',
      showSourceBadges: false,
      cleanChannelTitles: true,
      collapseLiveVariants: true,
      groupVodVersions: false,
      uiFontFamily: 'atkinson',
      subtitleFontFamily: 'opendyslexic',
      subtitleStyle: {
        fontSize: 'large',
        textColor: 'yellow',
        backgroundColor: 'opaque',
        edgeStyle: 'dropShadow',
        verticalPosition: 'raised',
      },
      subtitleMode: 'always',
      preferredAudioLang: 'tr',
      preferredSubtitleLang: 'en',
      preferredAudioLanguages: ['tr', 'en'],
      preferredSubtitleLanguages: ['en'],
      autoPlayNextEpisode: false,
      autoSubtitlesOnSkipBack: true,
      seekStepSec: 15,
      homeLayout: [
        { id: 'live', visible: true },
        { id: 'continue', visible: true },
        { id: 'mylist', visible: true },
        { id: 'movies', visible: false },
        { id: 'series', visible: true },
        { id: 'collections', visible: true },
      ],
      // Device-local / hardware keys that must NEVER be exported
      overscanX: 0.08,
      overscanY: 0.07,
      useTextureView: true,
      androidDecoderMode: 'software',
      preferredAudioDevice: 'HDMI-0',
      windowAspectRatioLock: true,
      minimizeToTray: true,
      syncServerUrl: 'https://sync.example.com',
      telemetryOptIn: true,
      artworkCacheLimitMb: 256,
      autoEnterPip: false,
      playerVolume: 42,
      deinterlaceMode: 'bwdif',
    };

    const extracted = extractSyncablePreferences(snapshot);
    expect(Object.keys(extracted).sort()).toEqual([...SYNCABLE_PREFERENCE_KEYS].sort());

    expect(extracted.themePreset).toBe('midnightGold');
    expect(extracted.locale).toBe('tr');
    expect(extracted.fontScale).toBe(1.1);
    expect(extracted.seekStepSec).toBe(15);
    expect(extracted.homeLayout).toEqual(snapshot.homeLayout);

    // Ensure hardware/device-local and locked/removed keys are strictly excluded
    const forbiddenKeys = [
      'overscanX',
      'overscanY',
      'useTextureView',
      'androidDecoderMode',
      'preferredAudioDevice',
      'windowAspectRatioLock',
      'minimizeToTray',
      'syncServerUrl',
      'telemetryOptIn',
      'artworkCacheLimitMb',
      'preferHevcOverDolbyVision',
      'audioPassthrough',
      'audioPassthroughCodecs',
      'audioExclusive',
      'audioAc3Encode',
      'audioChannelLayout',
      'autoEnterPip',
      'playerVolume',
      'deinterlaceMode',
      'bufferPreset',
      'version',
      'epgGenreTints',
      'logoBackdropMode',
      'showSourceBadges',
      'cleanChannelTitles',
      'collapseLiveVariants',
      'autoSubtitlesOnSkipBack',
    ];
    for (const key of forbiddenKeys) {
      expect(Object.hasOwn(extracted, key)).toBe(false);
    }
  });

  it('sanitizes untrusted/malformed payloads safely, ignoring invalid fields and forbidden keys', () => {
    expect(sanitizeInitialPreferencesPatch(null)).toEqual({});
    expect(sanitizeInitialPreferencesPatch('not-an-object')).toEqual({});
    expect(sanitizeInitialPreferencesPatch([])).toEqual({});

    const patch = sanitizeInitialPreferencesPatch({
      themePreset: 'obsidianCrimson',
      fontScale: 99, // clamped to 1.2
      reduceMotion: true,
      locale: 'de',
      defaultResizeMode: 'stretch',
      osdTimeDisplayMode: 'endsAt',
      epgTimeSpanHours: 6,
      epgRowDensity: 'cinematic',
      epgGenreTints: false,
      epgShowClock: true,
      defaultLiveMode: 'channels',
      logoBackdropMode: 'off',
      showSourceBadges: false,
      cleanChannelTitles: true,
      collapseLiveVariants: true,
      groupVodVersions: false,
      uiFontFamily: 'atkinson',
      subtitleFontFamily: 'invalid-font', // dropped
      subtitleStyle: {
        fontSize: 'extraLarge',
        textColor: 'cyan',
        edgeStyle: 'bogus', // ignored inside subtitleStyle
      },
      subtitleMode: 'auto', // normalized to 'smart'
      preferredAudioLang: 'TR',
      preferredSubtitleLang: 'invalid_lang_code_too_long', // dropped
      preferredAudioLanguages: ['tr', 'en', 'und', 42],
      preferredSubtitleLanguages: ['de'],
      autoPlayNextEpisode: false,
      autoSubtitlesOnSkipBack: true,
      seekStepSec: 30,
      homeLayout: [
        { id: 'live', visible: true },
        { id: 'movies', visible: false },
      ],
      // Forbidden hardware/device-local keys must be dropped
      overscanX: 0.1,
      useTextureView: true,
      androidDecoderMode: 'software',
      syncServerUrl: 'https://evil.example.com',
      telemetryOptIn: true,
      playerVolume: 10,
      __proto__: { polluted: true },
    });

    expect(patch).toEqual({
      themePreset: 'obsidianCrimson',
      fontScale: 1.2,
      reduceMotion: true,
      locale: 'de',
      defaultResizeMode: 'stretch',
      osdTimeDisplayMode: 'endsAt',
      epgTimeSpanHours: 6,
      epgRowDensity: 'cinematic',
      epgShowClock: true,
      defaultLiveMode: 'channels',
      groupVodVersions: false,
      uiFontFamily: 'atkinson',
      subtitleStyle: {
        fontSize: 'extraLarge',
        textColor: 'cyan',
      },
      subtitleMode: 'smart',
      preferredAudioLang: 'tr',
      preferredAudioLanguages: ['tr', 'en'],
      preferredSubtitleLanguages: ['de'],
      autoPlayNextEpisode: false,
      seekStepSec: 30,
      homeLayout: [
        { id: 'live', visible: true },
        { id: 'movies', visible: false },
        { id: 'continue', visible: true },
        { id: 'newEpisodes', visible: true },
        { id: 'mylist', visible: true },
        { id: 'series', visible: true },
        { id: 'collections', visible: true },
      ],
    });
    expect(Object.hasOwn(patch, 'subtitleFontFamily')).toBe(false);
    expect(Object.hasOwn(patch, 'preferredSubtitleLang')).toBe(false);
    expect(Object.hasOwn(patch, 'overscanX')).toBe(false);
    expect(Object.hasOwn(patch, 'syncServerUrl')).toBe(false);
  });

  it('drops completely invalid homeLayout or empty subtitleStyle in untrusted patches', () => {
    const patch = sanitizeInitialPreferencesPatch({
      homeLayout: [{ id: 'bogus', visible: true }],
      subtitleStyle: { fontSize: 'giant' },
      seekStepSec: 999,
      epgTimeSpanHours: 99,
    });
    expect(patch).toEqual({});
  });
});
