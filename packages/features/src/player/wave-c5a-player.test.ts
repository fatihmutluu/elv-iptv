import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { routeSettingsMenuKey, settingsRowCount } from './settings-menu-nav';
import { isEpisodePlayTarget } from './useGaplessEpisodeQueue';

const TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng' }],
  subtitles: [{ id: 's:1', language: 'eng' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

describe('Wave C5A player settings menu & episode detection (#243, #205)', () => {
  it('detects series episode PlayTargets across inline queues and cross-season rows (#205)', () => {
    expect(
      isEpisodePlayTarget({
        itemKey: 'ep:1',
        sourceId: 's1',
        title: 'S1 E1',
        kind: 'vod',
        itemKind: 'episode',
      }),
    ).toBe(true);

    expect(
      isEpisodePlayTarget({
        itemKey: 'ep:2',
        sourceId: 's1',
        title: 'S1 E2',
        kind: 'vod',
        seriesKey: 'ser:1',
        season: 1,
        episode: 2,
      }),
    ).toBe(true);

    expect(
      isEpisodePlayTarget({
        itemKey: 'mov:1',
        sourceId: 's1',
        title: 'Cinema Movie',
        kind: 'vod',
        itemKind: 'movie',
      }),
    ).toBe(false);

    expect(
      isEpisodePlayTarget({
        itemKey: 'ch:1',
        sourceId: 's1',
        title: 'Live News',
        kind: 'live',
      }),
    ).toBe(false);
  });

  it('routes pitchLock and audioNormalization in Wave R4 2-level Player Settings via D-pad (#243)', () => {
    const opts = {
      isVod: true,
      hasAspect: true,
      hasDeinterlace: true,
      hasPitchLock: true,
      hasAudioNormalization: true,
    };
    // Root rows: subtitles (0), audio (1), speed (2), aspect (3), stats (4), advanced (5)
    expect(settingsRowCount('root', TRACKS, opts)).toBe(6);

    // Selecting 'advanced' (5) opens 'advanced' with [deinterlace (0), audioNormalization (1), pitchLock (2)]
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 5 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'advanced', index: 0 } });

    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'advanced', index: 0 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'toggleDeinterlace' });

    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'advanced', index: 1 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'toggleAudioNormalization' });

    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'advanced', index: 2 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'togglePitchLock' });

    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 4 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'toggleStats' });
  });
});
