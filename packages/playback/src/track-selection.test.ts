import { describe, expect, it } from 'vitest';
import type { MediaTracks } from './engine';
import { resolveInitialTrackSelection } from './track-selection';

const SAMPLE_TRACKS: MediaTracks = {
  audio: [
    { id: 'a-en', language: 'eng', label: 'English 5.1', isDefault: true },
    { id: 'a-tr', language: 'tur', label: 'Turkish Stereo' },
    { id: 'a-de', language: 'und', label: 'Deutsch AC3' },
  ],
  subtitles: [
    { id: 's-en-forced', language: 'en', label: 'English Forced', forced: true },
    { id: 's-en', language: 'eng', label: 'English', isDefault: true },
    { id: 's-tr-forced', language: 'tr', label: 'Türkçe Forced', forced: true },
    { id: 's-tr', language: 'tur', label: 'Turkish Full' },
    { id: 's-de', language: 'und', label: 'German' },
  ],
  selectedAudioId: 'a-en',
  selectedSubtitleId: 's-en',
};

describe('resolveInitialTrackSelection (#393, #208)', () => {
  it('enforces strict precedence: sessionOverride > targetOverride > persistedItemPref > profileRules', () => {
    const res = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      sessionOverride: { audioId: 'a-de', subtitleId: 's-de' },
      targetOverride: { audioId: 'a-tr', subtitleId: 's-tr' },
      persistedItemPref: { audioLang: 'en', subLang: 'en' },
      profileRules: {
        preferredAudioLanguages: ['en'],
        preferredSubtitleLanguages: ['en'],
        subtitleMode: 'always',
      },
    });
    expect(res).toEqual({ audioId: 'a-de', subtitleId: 's-de' });

    const fromTarget = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      sessionOverride: { audioId: 'missing-id' },
      targetOverride: { audioId: 'a-tr', subtitleId: null },
      persistedItemPref: { audioLang: 'en', subLang: 'tr' },
      profileRules: { preferredAudioLanguages: ['en'], subtitleMode: 'always' },
    });
    expect(fromTarget).toEqual({ audioId: 'a-tr', subtitleId: null });
  });

  it('evaluates persistedItemPref audio and subtitle modalities independently (#208)', () => {
    // Persisted audio only; subtitles still governed by profileRules
    const audioOnly = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      persistedItemPref: { audioLang: 'tr', audioLabel: 'Turkish Stereo' },
      profileRules: {
        preferredSubtitleLanguages: ['en'],
        subtitleMode: 'always',
      },
    });
    expect(audioOnly).toEqual({ audioId: 'a-tr', subtitleId: 's-en' });

    // Persisted subDisabled = true explicitly disables subtitles while audio uses profileRules
    const subOff = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      persistedItemPref: { subDisabled: true },
      profileRules: {
        preferredAudioLanguages: ['de'],
        preferredSubtitleLanguages: ['tr'],
        subtitleMode: 'always',
      },
    });
    expect(subOff).toEqual({ audioId: 'a-de', subtitleId: null });

    // Persisted subtitle matches by normalized language + label fallback
    const subOnly = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      persistedItemPref: { subLang: 'tr', subLabel: 'Turkish Full' },
      profileRules: {
        preferredAudioLanguages: ['en'],
        subtitleMode: 'off',
      },
    });
    expect(subOnly).toEqual({ audioId: 'a-en', subtitleId: 's-tr' });
  });

  it('uses effective chosen audio language from step 1 in smart mode (never stale selectedAudioId)', () => {
    // Stale selectedAudioId is 'a-en', but step 1 picks 'a-tr' (Turkish).
    // With preferredSubtitleLanguages: ['tr'], smart mode sees audio === 'tr' and picks forced Turkish (not full Turkish)!
    const sameLangWithForced = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      profileRules: {
        preferredAudioLanguages: ['tr'],
        preferredSubtitleLanguages: ['tr'],
        subtitleMode: 'smart',
      },
    });
    expect(sameLangWithForced).toEqual({ audioId: 'a-tr', subtitleId: 's-tr-forced' });

    // When audio is 'a-de' (extracted from label 'Deutsch AC3') and preferred sub is 'tr',
    // smart mode sees audio !== 'tr' and picks full Turkish subtitle!
    const foreignAudio = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      profileRules: {
        preferredAudioLanguages: ['de'],
        preferredSubtitleLanguages: ['tr'],
        subtitleMode: 'smart',
      },
    });
    expect(foreignAudio).toEqual({ audioId: 'a-de', subtitleId: 's-tr' });

    // When audio matches preferred language and NO forced subtitle exists, smart mode explicitly returns null
    const noForcedTracks: MediaTracks = {
      ...SAMPLE_TRACKS,
      subtitles: [{ id: 's-tr', language: 'tur', label: 'Turkish Full' }],
    };
    const smartOff = resolveInitialTrackSelection(noForcedTracks, {
      profileRules: {
        preferredAudioLanguages: ['tr'],
        preferredSubtitleLanguages: ['tr'],
        subtitleMode: 'smart',
      },
    });
    expect(smartOff).toEqual({ audioId: 'a-tr', subtitleId: null });
  });

  it('implements all 5 subtitle modes: default, smart, onlyForced, always, off', () => {
    // off -> always null
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        profileRules: { preferredSubtitleLanguages: ['tr'], subtitleMode: 'off' },
      }).subtitleId,
    ).toBeNull();

    // onlyForced -> picks forced track for preferred sub lang, else null
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        profileRules: { preferredSubtitleLanguages: ['tr'], subtitleMode: 'onlyForced' },
      }).subtitleId,
    ).toBe('s-tr-forced');

    expect(
      resolveInitialTrackSelection(
        { ...SAMPLE_TRACKS, subtitles: [{ id: 's-tr', language: 'tr', label: 'Turkish' }] },
        { profileRules: { preferredSubtitleLanguages: ['tr'], subtitleMode: 'onlyForced' } },
      ).subtitleId,
    ).toBeNull();

    // always -> prefers non-forced preferred lang, falls back to default/first
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        profileRules: { preferredSubtitleLanguages: ['tr'], subtitleMode: 'always' },
      }).subtitleId,
    ).toBe('s-tr');

    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        profileRules: { preferredSubtitleLanguages: ['ja'], subtitleMode: 'always' },
      }).subtitleId,
    ).toBe('s-en');

    // default -> picks isDefault subtitle track, else forced for effective audio, else null
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        profileRules: { subtitleMode: 'default' },
      }).subtitleId,
    ).toBe('s-en');

    const noDefaultSubs: MediaTracks = {
      ...SAMPLE_TRACKS,
      subtitles: [{ id: 's-de', language: 'de', label: 'German' }],
    };
    expect(
      resolveInitialTrackSelection(noDefaultSubs, {
        profileRules: { subtitleMode: 'default' },
      }).subtitleId,
    ).toBeNull();
  });

  it('respects preferDefaultAudioTrack when no preferred audio language matches', () => {
    const withDefault = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      profileRules: {
        preferredAudioLanguages: ['ja'],
        preferDefaultAudioTrack: true,
        subtitleMode: 'off',
      },
    });
    expect(withDefault.audioId).toBe('a-en');

    const withoutDefault = resolveInitialTrackSelection(SAMPLE_TRACKS, {
      profileRules: {
        preferredAudioLanguages: ['ja'],
        preferDefaultAudioTrack: false,
        subtitleMode: 'off',
      },
    });
    expect(withoutDefault.audioId).toBeUndefined();
  });

  it('smart mode falls back to preferredAudioLanguages when preferredSubtitleLanguages is empty (#393)', () => {
    const japaneseAudioTracks: MediaTracks = {
      audio: [{ id: 'a-ja', language: 'ja', label: 'Japanese', isDefault: true }],
      subtitles: [
        { id: 's-es', language: 'es', label: 'Spanish' },
        { id: 's-en', language: 'en', label: 'English' },
      ],
      selectedAudioId: 'a-ja',
      selectedSubtitleId: null,
    };
    const resolved = resolveInitialTrackSelection(japaneseAudioTracks, {
      profileRules: {
        preferredAudioLanguages: ['en'],
        preferredSubtitleLanguages: [],
        subtitleMode: 'smart',
      },
    });
    expect(resolved.subtitleId).toBe('s-en');
  });

  it('uses fallbackLocale in smart, always, and onlyForced modes when preferred audio & subtitle languages are empty (Wave P7)', () => {
    const englishAudioTracks: MediaTracks = {
      audio: [{ id: 'a-en', language: 'eng', label: 'English', isDefault: true }],
      subtitles: [
        { id: 's-en', language: 'en', label: 'English', isDefault: true },
        { id: 's-tr-forced', language: 'tr', label: 'Türkçe Forced', forced: true },
        { id: 's-tr', language: 'tur', label: 'Turkish' },
      ],
      selectedAudioId: 'a-en',
      selectedSubtitleId: null,
    };

    // Fresh install with app locale 'tr-TR' watching English audio -> enables Turkish subtitles in smart mode
    expect(
      resolveInitialTrackSelection(englishAudioTracks, {
        profileRules: {
          preferredAudioLanguages: [],
          preferredSubtitleLanguages: [],
          subtitleMode: 'smart',
          fallbackLocale: 'tr-TR',
        },
      }).subtitleId,
    ).toBe('s-tr');

    // Fresh install with app locale 'en-US' watching English audio -> keeps subtitles off (no forced English track)
    expect(
      resolveInitialTrackSelection(englishAudioTracks, {
        profileRules: {
          preferredAudioLanguages: [],
          preferredSubtitleLanguages: [],
          subtitleMode: 'smart',
          fallbackLocale: 'en-US',
        },
      }).subtitleId,
    ).toBeNull();

    // Always mode with empty preferred lists uses fallbackLocale
    expect(
      resolveInitialTrackSelection(englishAudioTracks, {
        profileRules: {
          preferredAudioLanguages: [],
          preferredSubtitleLanguages: [],
          subtitleMode: 'always',
          fallbackLocale: 'tr',
        },
      }).subtitleId,
    ).toBe('s-tr');

    // onlyForced mode with empty preferred lists uses fallbackLocale
    expect(
      resolveInitialTrackSelection(englishAudioTracks, {
        profileRules: {
          preferredAudioLanguages: [],
          preferredSubtitleLanguages: [],
          subtitleMode: 'onlyForced',
          fallbackLocale: 'tr',
        },
      }).subtitleId,
    ).toBe('s-tr-forced');

    // Explicit preferredSubtitleLanguages takes precedence over fallbackLocale
    expect(
      resolveInitialTrackSelection(englishAudioTracks, {
        profileRules: {
          preferredAudioLanguages: [],
          preferredSubtitleLanguages: ['en'],
          subtitleMode: 'always',
          fallbackLocale: 'tr',
        },
      }).subtitleId,
    ).toBe('s-en');
  });

  it('defaults Live TV initial subtitles to null across all profile rules while honoring explicit per-channel overrides (Wave Q4)', () => {
    for (const subtitleMode of ['smart', 'default', 'always', 'onlyForced', 'off'] as const) {
      const liveResolved = resolveInitialTrackSelection(SAMPLE_TRACKS, {
        mediaKind: 'live',
        profileRules: {
          preferredAudioLanguages: ['tr'],
          preferredSubtitleLanguages: ['en', 'tr'],
          subtitleMode,
          fallbackLocale: 'en-US',
        },
      });
      expect(liveResolved).toEqual({ audioId: 'a-tr', subtitleId: null });
    }

    // Audio-only persisted pref on live still keeps subtitles off
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        mediaKind: 'live',
        persistedItemPref: { audioLang: 'de', audioLabel: 'Deutsch AC3' },
        profileRules: {
          preferredSubtitleLanguages: ['tr'],
          subtitleMode: 'always',
        },
      }),
    ).toEqual({ audioId: 'a-de', subtitleId: null });

    // Explicit per-channel persisted subtitle preference IS honored on live
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        mediaKind: 'live',
        persistedItemPref: { subLang: 'tr', subLabel: 'Turkish Full' },
        profileRules: {
          preferredAudioLanguages: ['en'],
          subtitleMode: 'always',
        },
      }),
    ).toEqual({ audioId: 'a-en', subtitleId: 's-tr' });

    // Explicit targetOverride and sessionOverride ARE honored on live
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        mediaKind: 'live',
        targetOverride: { subtitleId: 's-en' },
        profileRules: { subtitleMode: 'smart' },
      }).subtitleId,
    ).toBe('s-en');

    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        mediaKind: 'live',
        sessionOverride: { subtitleId: 's-de' },
        profileRules: { subtitleMode: 'smart' },
      }).subtitleId,
    ).toBe('s-de');

    // VOD with mediaKind: 'vod' keeps profile-rule subtitle selection untouched
    expect(
      resolveInitialTrackSelection(SAMPLE_TRACKS, {
        mediaKind: 'vod',
        profileRules: {
          preferredAudioLanguages: ['de'],
          preferredSubtitleLanguages: ['tr'],
          subtitleMode: 'smart',
        },
      }),
    ).toEqual({ audioId: 'a-de', subtitleId: 's-tr' });
  });
});
