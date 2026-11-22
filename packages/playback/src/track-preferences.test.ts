import { describe, expect, it } from 'vitest';
import { EMPTY_TRACKS, type MediaTracks } from './engine';
import { createTrackPreferences } from './track-preferences';

describe('createTrackPreferences', () => {
  it('resolves shifted IDs by language+label, language, label, and exact-id fallback', () => {
    const prefs = createTrackPreferences();
    const initial: MediaTracks = {
      audio: [
        { id: 'a:1', language: 'eng', label: 'Commentary' },
        { id: 'a:2', language: 'eng', label: 'Main' },
      ],
      subtitles: [{ id: 's:1', label: 'Director Notes' }],
      selectedAudioId: 'a:1',
      selectedSubtitleId: null,
    };
    prefs.selectAudio('a:2', initial, true);
    prefs.selectSubtitle('s:1', initial, true);
    expect(prefs.loadOptions({ softwareAudio: true })).toEqual({
      softwareAudio: true,
      audioTrackId: 'a:2',
      subtitleTrackId: 's:1',
    });

    // Reload #1: language + label picks Main ('a:9') over Commentary ('a:8'); label fallback picks 's:4'
    prefs.beginReload();
    expect(prefs.reconcile(EMPTY_TRACKS)).toEqual({});
    expect(
      prefs.reconcile({
        audio: [
          { id: 'a:8', language: 'ENG', label: 'Commentary' },
          { id: 'a:9', language: 'ENG', label: 'Main' },
        ],
        subtitles: [
          { id: 's:3', label: 'Forced' },
          { id: 's:4', label: 'Director Notes' },
        ],
        selectedAudioId: 'a:8',
        selectedSubtitleId: 's:3',
      }),
    ).toEqual({ audioTrackId: 'a:9', subtitleTrackId: 's:4' });
    expect(prefs.loadOptions()).toEqual({ audioTrackId: 'a:9', subtitleTrackId: 's:4' });

    // Reload #2: exact-id fallback when reloaded container strips language/label tags
    prefs.beginReload();
    expect(
      prefs.reconcile({
        audio: [{ id: 'a:9' }],
        subtitles: [{ id: 's:4' }],
        selectedAudioId: null,
        selectedSubtitleId: null,
      }),
    ).toEqual({ audioTrackId: 'a:9', subtitleTrackId: 's:4' });

    // Subtitle Off waits past empty tracks and latches once subtitles are present with null selection
    prefs.selectSubtitle(null, EMPTY_TRACKS, false);
    prefs.beginReload();
    expect(prefs.reconcile(EMPTY_TRACKS)).toEqual({});
    expect(
      prefs.reconcile({
        audio: [],
        subtitles: [{ id: 's:1', language: 'tur' }],
        selectedAudioId: null,
        selectedSubtitleId: null,
      }),
    ).toEqual({});

    prefs.reset();
    expect(prefs.loadOptions()).toEqual({});
  });

  it('normalizes ISO 639-1/639-2(T+B)/BCP-47 codes and checks label compatibility on swapped IDs (#253)', () => {
    const prefs = createTrackPreferences();
    prefs.selectAudio(
      'a:2',
      {
        audio: [
          { id: 'a:1', language: 'ger', label: 'Commentary' },
          { id: 'a:2', language: 'ger', label: 'Main' },
        ],
        subtitles: [
          { id: 's:1', language: 'und', label: 'Forced' },
          { id: 's:2', language: 'und', label: 'Full' },
        ],
        selectedAudioId: 'a:1',
        selectedSubtitleId: null,
      },
      true,
    );
    prefs.selectSubtitle(
      's:2',
      {
        audio: [],
        subtitles: [
          { id: 's:1', language: 'und', label: 'Forced' },
          { id: 's:2', language: 'und', label: 'Full' },
        ],
        selectedAudioId: null,
        selectedSubtitleId: null,
      },
      true,
    );

    // Reload swaps track IDs AND changes ISO 639-2B 'ger' -> BCP-47 'de-DE'
    prefs.beginReload();
    expect(
      prefs.reconcile({
        audio: [
          { id: 'a:1', language: 'de-DE', label: 'Main' },
          { id: 'a:2', language: 'de-DE', label: 'Commentary' },
        ],
        subtitles: [
          { id: 's:1', language: 'und', label: 'Full' },
          { id: 's:2', language: 'und', label: 'Forced' },
        ],
        selectedAudioId: 'a:2',
        selectedSubtitleId: 's:2',
      }),
    ).toEqual({ audioTrackId: 'a:1', subtitleTrackId: 's:1' });
  });

  it('matches ISO 639-2(T+B) pairs without substring false positives and preserves preferHevcOverDolbyVision (#189)', () => {
    const prefs = createTrackPreferences();
    prefs.selectAudio(
      'a:1',
      {
        audio: [{ id: 'a:1', language: 'fre', label: 'Français' }],
        subtitles: [{ id: 's:1', language: 'tib', label: 'Tibetan' }],
        selectedAudioId: 'a:1',
        selectedSubtitleId: null,
      },
      true,
    );
    prefs.selectSubtitle(
      's:1',
      {
        audio: [],
        subtitles: [{ id: 's:1', language: 'tib', label: 'Tibetan' }],
        selectedAudioId: null,
        selectedSubtitleId: 's:1',
      },
      true,
    );
    expect(prefs.loadOptions({ preferHevcOverDolbyVision: true })).toEqual({
      preferHevcOverDolbyVision: true,
      audioTrackId: 'a:1',
      subtitleTrackId: 's:1',
    });

    prefs.beginReload();
    expect(
      prefs.reconcile({
        audio: [{ id: 'a:9', language: 'fra', label: 'Audio 2' }],
        subtitles: [{ id: 's:9', language: 'bod', label: 'Sub 2' }],
        selectedAudioId: null,
        selectedSubtitleId: null,
      }),
    ).toEqual({ audioTrackId: 'a:9', subtitleTrackId: 's:9' });

    // Anti-substring: 'es' must never match 'Chinese' or 'Japanese'
    prefs.reset();
    prefs.selectSubtitle(
      's:es',
      {
        audio: [],
        subtitles: [{ id: 's:es', language: 'es', label: 'Spanish' }],
        selectedAudioId: null,
        selectedSubtitleId: 's:es',
      },
      true,
    );
    prefs.beginReload();
    expect(
      prefs.reconcile({
        audio: [],
        subtitles: [
          { id: 's:zh', language: 'Chinese', label: 'Chinese' },
          { id: 's:ja', language: 'Japanese', label: 'Japanese' },
        ],
        selectedAudioId: null,
        selectedSubtitleId: null,
      }),
    ).toEqual({});
  });
});
