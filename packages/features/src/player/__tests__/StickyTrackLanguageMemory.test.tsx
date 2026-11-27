import { DEFAULT_PREFERENCES, type PreferencesPatch, type PreferencesSnapshot } from '@elv/domain';
import {
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  resolveInitialTrackSelection,
} from '@elv/playback';
import { act, renderHook } from '@testing-library/react-native';
import { useRef } from 'react';
import type { PlayTarget } from '../../ports/play-target';
import { computeGlobalTrackLanguagePatch } from '../track-preferences';
import { usePlayerCinemaExtras } from '../usePlayerCinemaExtras';

const MOVIE_A_TRACKS: MediaTracks = {
  audio: [
    { id: 'a-tr', language: 'tur', label: 'Turkish', isDefault: true },
    { id: 'a-en', language: 'eng', label: 'English' },
    { id: 'a-ja', language: 'jpn', label: 'Japanese' },
  ],
  subtitles: [
    { id: 's-en', language: 'eng', label: 'English' },
    { id: 's-tr', language: 'tr-TR', label: 'Türkçe' },
    { id: 's-de', language: 'deu', label: 'Deutsch' },
  ],
  selectedAudioId: 'a-tr',
  selectedSubtitleId: null,
};

const MOVIE_B_TRACKS: MediaTracks = {
  audio: [
    { id: 'b-ja', language: 'ja', label: 'Japanese', isDefault: true },
    { id: 'b-en', language: 'en-US', label: 'English' },
    { id: 'b-tr', language: 'tr', label: 'Turkish' },
  ],
  subtitles: [
    { id: 'bs-en', language: 'en', label: 'English' },
    { id: 'bs-tr', language: 'tur', label: 'Turkish' },
  ],
  selectedAudioId: 'b-ja',
  selectedSubtitleId: null,
};

const MOVIE_C_TURKISH_TRACKS: MediaTracks = {
  audio: [
    { id: 'c-tr', language: 'tur', label: 'Turkish', isDefault: true },
    { id: 'c-en', language: 'eng', label: 'English' },
  ],
  subtitles: [
    { id: 'cs-tr', language: 'tr', label: 'Türkçe' },
    { id: 'cs-en', language: 'en', label: 'English' },
  ],
  selectedAudioId: 'c-tr',
  selectedSubtitleId: null,
};

function applyPatch(
  prefs: PreferencesSnapshot,
  patch: PreferencesPatch | null,
): PreferencesSnapshot {
  if (patch === null) return prefs;
  return { ...prefs, ...patch, subtitleStyle: prefs.subtitleStyle };
}

describe('Sticky Smart Audio & Subtitle Language Memory', () => {
  describe('computeGlobalTrackLanguagePatch', () => {
    it('produces exact patches for English audio + Turkish subs on Movie A and auto-selects them on Movie B', () => {
      let prefs: PreferencesSnapshot = {
        ...DEFAULT_PREFERENCES,
        preferredAudioLanguages: ['de', 'en', 'fr', 'es', 'it'],
        preferredSubtitleLanguages: ['de'],
        subtitleMode: 'off',
      };

      const audioPatch = computeGlobalTrackLanguagePatch({
        kind: 'audio',
        track: MOVIE_A_TRACKS.audio[1], // English
        existingAudioLanguages: prefs.preferredAudioLanguages,
      });
      expect(audioPatch).toEqual({
        preferredAudioLang: 'en',
        preferredAudioLanguages: ['en', 'de', 'fr', 'es', 'it'],
        preferDefaultAudioTrack: false,
      });
      prefs = applyPatch(prefs, audioPatch);

      const subPatch = computeGlobalTrackLanguagePatch({
        kind: 'subtitle',
        track: MOVIE_A_TRACKS.subtitles[1], // Turkish
        activeAudioTrack: MOVIE_A_TRACKS.audio[1], // English
        existingSubtitleLanguages: prefs.preferredSubtitleLanguages,
        currentSubtitleMode: prefs.subtitleMode,
        mediaKind: 'vod',
      });
      expect(subPatch).toEqual({
        preferredSubtitleLang: 'tr',
        preferredSubtitleLanguages: ['tr', 'de'],
        subtitleMode: 'smart',
      });
      prefs = applyPatch(prefs, subPatch);

      // Unrelated Movie B should automatically pick English audio + Turkish subtitles!
      const resolvedB = resolveInitialTrackSelection(MOVIE_B_TRACKS, {
        profileRules: {
          preferredAudioLanguages: prefs.preferredAudioLanguages,
          preferDefaultAudioTrack: prefs.preferDefaultAudioTrack,
          preferredSubtitleLanguages: prefs.preferredSubtitleLanguages,
          subtitleMode: prefs.subtitleMode,
        },
      });
      expect(resolvedB).toEqual({
        audioId: 'b-en',
        subtitleId: 'bs-tr',
      });
    });

    it('sets subtitleMode to always when enabling same-language subtitles on a Turkish-audio movie', () => {
      let prefs: PreferencesSnapshot = {
        ...DEFAULT_PREFERENCES,
        preferredAudioLang: 'tr',
        preferredAudioLanguages: ['tr'],
        subtitleMode: 'smart',
      };

      const subPatch = computeGlobalTrackLanguagePatch({
        kind: 'subtitle',
        track: MOVIE_C_TURKISH_TRACKS.subtitles[0], // Turkish
        activeAudioTrack: MOVIE_C_TURKISH_TRACKS.audio[0], // Turkish
        existingSubtitleLanguages: prefs.preferredSubtitleLanguages,
        currentSubtitleMode: prefs.subtitleMode,
        mediaKind: 'vod',
      });
      expect(subPatch).toEqual({
        preferredSubtitleLang: 'tr',
        preferredSubtitleLanguages: ['tr'],
        subtitleMode: 'always',
      });
      prefs = applyPatch(prefs, subPatch);

      const resolvedC = resolveInitialTrackSelection(MOVIE_C_TURKISH_TRACKS, {
        profileRules: {
          preferredAudioLanguages: prefs.preferredAudioLanguages,
          preferDefaultAudioTrack: prefs.preferDefaultAudioTrack,
          preferredSubtitleLanguages: prefs.preferredSubtitleLanguages,
          subtitleMode: prefs.subtitleMode,
        },
      });
      expect(resolvedC).toEqual({
        audioId: 'c-tr',
        subtitleId: 'cs-tr',
      });
    });

    it('sets subtitleMode to off when explicitly disabling subtitles on VOD, and ignores off on Live TV', () => {
      const vodOff = computeGlobalTrackLanguagePatch({
        kind: 'subtitle',
        track: null,
        activeAudioTrack: MOVIE_A_TRACKS.audio[1],
        existingSubtitleLanguages: ['tr'],
        currentSubtitleMode: 'smart',
        mediaKind: 'vod',
      });
      expect(vodOff).toEqual({ subtitleMode: 'off' });

      const resolved = resolveInitialTrackSelection(MOVIE_B_TRACKS, {
        profileRules: {
          preferredAudioLanguages: ['en'],
          preferDefaultAudioTrack: false,
          preferredSubtitleLanguages: ['tr'],
          subtitleMode: vodOff?.subtitleMode ?? 'smart',
        },
      });
      expect(resolved.subtitleId).toBeNull();

      const liveOff = computeGlobalTrackLanguagePatch({
        kind: 'subtitle',
        track: null,
        activeAudioTrack: MOVIE_A_TRACKS.audio[1],
        existingSubtitleLanguages: ['tr'],
        currentSubtitleMode: 'smart',
        mediaKind: 'live',
      });
      expect(liveOff).toBeNull();
    });

    it('returns null for undetermined or empty language codes and caps language history at 5', () => {
      expect(
        computeGlobalTrackLanguagePatch({
          kind: 'audio',
          track: { id: 'a-und', language: 'und', label: 'Track 1' },
          existingAudioLanguages: ['en'],
        }),
      ).toBeNull();

      expect(
        computeGlobalTrackLanguagePatch({
          kind: 'subtitle',
          track: { id: 's-empty', language: '', label: 'Track 2' },
          activeAudioTrack: MOVIE_A_TRACKS.audio[0],
          existingSubtitleLanguages: ['tr'],
          currentSubtitleMode: 'smart',
          mediaKind: 'vod',
        }),
      ).toBeNull();

      const capped = computeGlobalTrackLanguagePatch({
        kind: 'audio',
        track: { id: 'a-ja', language: 'jpn', label: 'Japanese' },
        existingAudioLanguages: ['en', 'tr', 'de', 'fr', 'es'],
      });
      expect(capped?.preferredAudioLanguages).toEqual(['ja', 'en', 'tr', 'de', 'fr']);
    });
  });

  describe('usePlayerCinemaExtras integration', () => {
    it('emits global track language patches via onPersistTrackLanguagePatch on manual audio & subtitle selection', async () => {
      const onPersistTrackLanguagePatch = jest.fn();
      const saveTrackPreference = jest.fn(async () => undefined);
      const vodTarget: PlayTarget = {
        itemKey: 'x:s1:movie:100',
        sourceId: 's1',
        title: 'Movie A',
        kind: 'vod',
        itemKind: 'movie',
      };
      const status: PlaybackStatus = { kind: 'playing' };
      const clock: PlaybackClock = { now: () => 1000 };
      const timers: PlaybackTimers = {
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      };

      const { result, unmount } = await renderHook(() => {
        const catalogRef = useRef({ saveTrackPreference });
        const serviceRef = useRef<PlaybackService | null>(null);
        const clockRef = useRef(clock);
        const timersRef = useRef(timers);
        const flushProgressRef = useRef(() => undefined);
        const onExitRef = useRef(() => undefined);
        return usePlayerCinemaExtras({
          activeTarget: vodTarget,
          status,
          tracks: MOVIE_A_TRACKS,
          chapters: undefined,
          openedEngine: undefined,
          catalogRef,
          serviceRef,
          clockRef,
          timersRef,
          flushProgressRef,
          onExitRef,
          filterSdhSubtitles: false,
          sleepTimerDefaultAction: 'stop',
          stillWatchingTimeoutMin: 0,
          preferredAudioLanguages: [],
          preferredSubtitleLanguages: [],
          subtitleMode: 'off',
          onPersistTrackLanguagePatch,
        });
      });

      await act(async () => {
        result.current.handleAudioTrackSelected('a-en');
      });
      expect(onPersistTrackLanguagePatch).toHaveBeenNthCalledWith(1, {
        preferredAudioLang: 'en',
        preferredAudioLanguages: ['en'],
        preferDefaultAudioTrack: false,
      });

      // Immediately select Turkish subtitles in the same session (active audio is now English!)
      await act(async () => {
        result.current.handleSubtitleTrackSelected('s-tr');
      });
      expect(onPersistTrackLanguagePatch).toHaveBeenNthCalledWith(2, {
        preferredSubtitleLang: 'tr',
        preferredSubtitleLanguages: ['tr'],
        subtitleMode: 'smart',
      });

      // Explicitly disable subtitles on VOD
      await act(async () => {
        result.current.handleSubtitleTrackSelected(null);
      });
      expect(onPersistTrackLanguagePatch).toHaveBeenNthCalledWith(3, {
        subtitleMode: 'off',
      });

      await unmount();
    });
  });
});
