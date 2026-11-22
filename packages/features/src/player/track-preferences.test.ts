import type { TrackInfo } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  chooseInitialAudioTrack,
  chooseInitialSubtitleTrack,
  normalizeTrackLanguage,
  resolveEffectiveTrackPrefs,
} from './track-preferences';

const AUDIO_TRACKS: readonly TrackInfo[] = [
  { id: 'a-en', language: 'eng', label: 'English', isDefault: true },
  { id: 'a-tr', language: 'tur', label: 'Turkish' },
  { id: 'a-de', language: 'de-DE', label: 'Deutsch' },
];

const SUBTITLE_TRACKS: readonly TrackInfo[] = [
  { id: 's-en-forced', language: 'en', label: 'English Forced', forced: true },
  { id: 's-en', language: 'eng', label: 'English' },
  { id: 's-tr', language: 'tr-TR', label: 'Türkçe', isDefault: true },
];

describe('track-preferences (#401)', () => {
  it('normalizes ISO 639-1, ISO 639-2/B/T, and BCP-47 region tags', () => {
    expect(normalizeTrackLanguage('tur')).toBe('tr');
    expect(normalizeTrackLanguage('tr-TR')).toBe('tr');
    expect(normalizeTrackLanguage('eng')).toBe('en');
    expect(normalizeTrackLanguage('en_US')).toBe('en');
    expect(normalizeTrackLanguage('deu')).toBe('de');
    expect(normalizeTrackLanguage('ger')).toBe('de');
    expect(normalizeTrackLanguage('fra')).toBe('fr');
    expect(normalizeTrackLanguage('fre')).toBe('fr');
    expect(normalizeTrackLanguage('spa')).toBe('es');
    expect(normalizeTrackLanguage('und')).toBe('');
    expect(normalizeTrackLanguage(undefined)).toBe('');
  });

  it('selects preferred audio track matching normalized language or leaves default when unset', () => {
    expect(chooseInitialAudioTrack(AUDIO_TRACKS, '')).toBeUndefined();
    expect(chooseInitialAudioTrack(AUDIO_TRACKS, 'tr')).toBe('a-tr');
    expect(chooseInitialAudioTrack(AUDIO_TRACKS, 'de')).toBe('a-de');
    expect(chooseInitialAudioTrack(AUDIO_TRACKS, 'fr')).toBeUndefined();
    expect(chooseInitialAudioTrack([], 'tr')).toBeUndefined();
  });

  it('applies subtitleMode off, auto, and always with preferred language fallback', () => {
    expect(
      chooseInitialSubtitleTrack(SUBTITLE_TRACKS, {
        preferredLang: 'tr',
        subtitleMode: 'off',
      }),
    ).toBeNull();

    expect(
      chooseInitialSubtitleTrack(SUBTITLE_TRACKS, {
        preferredLang: '',
        subtitleMode: 'auto',
      }),
    ).toBeUndefined();

    expect(
      chooseInitialSubtitleTrack(SUBTITLE_TRACKS, {
        preferredLang: 'en',
        subtitleMode: 'auto',
      }),
    ).toBe('s-en');

    expect(
      chooseInitialSubtitleTrack(SUBTITLE_TRACKS, {
        preferredLang: 'fr',
        subtitleMode: 'auto',
      }),
    ).toBeUndefined();

    expect(
      chooseInitialSubtitleTrack(SUBTITLE_TRACKS, {
        preferredLang: 'fr',
        subtitleMode: 'always',
      }),
    ).toBe('s-tr');

    expect(
      chooseInitialSubtitleTrack(SUBTITLE_TRACKS, {
        preferredLang: '',
        subtitleMode: 'always',
      }),
    ).toBe('s-tr');

    expect(
      chooseInitialSubtitleTrack([], {
        preferredLang: 'tr',
        subtitleMode: 'always',
      }),
    ).toBeUndefined();
  });

  it('merges global track preferences with per-target pre-play overrides', () => {
    expect(
      resolveEffectiveTrackPrefs({
        globalAudioLang: 'tr',
        globalSubtitleLang: 'en',
        globalSubtitleMode: 'off',
        targetAudioLang: 'de',
        targetSubtitleLang: 'fr',
      }),
    ).toEqual({ audioLang: 'de', subtitleLang: 'fr', subtitleMode: 'auto' });

    expect(
      resolveEffectiveTrackPrefs({
        globalAudioLang: 'tr',
        globalSubtitleLang: 'en',
        globalSubtitleMode: 'always',
        targetSubtitleLang: 'off',
      }),
    ).toEqual({ audioLang: 'tr', subtitleLang: 'en', subtitleMode: 'off' });
  });
});
