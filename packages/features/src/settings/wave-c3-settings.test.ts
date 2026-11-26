import { DEFAULT_PREFERENCES, mergeSubtitleStyle, ok, type PreferencesPatch } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsPreferencesController } from './appearance-controls';
import { activateLiveTvControl } from './live-tv-controls';
import { activatePlaybackControl } from './playback-controls';

function makeController() {
  const patches: PreferencesPatch[] = [];
  const controller: SettingsPreferencesController = {
    preferences: DEFAULT_PREFERENCES,
    updatePreferences: vi.fn(async (patch: PreferencesPatch) => {
      patches.push(patch);
      return ok({
        ...DEFAULT_PREFERENCES,
        ...patch,
        subtitleStyle: mergeSubtitleStyle(DEFAULT_PREFERENCES.subtitleStyle, patch.subtitleStyle),
      });
    }),
    resetPreferences: vi.fn(async () => ok(DEFAULT_PREFERENCES)),
  };
  return { controller, patches };
}

describe('Settings TV-nav control activation (Wave C3 / C5A / P7)', () => {
  it('activates Live TV mode, EPG span, clock, dropdowns, and refresh actions', () => {
    const { controller, patches } = makeController();
    const opened: string[] = [];
    const onRefreshCatalogNow = vi.fn();
    const onRefreshGuideNow = vi.fn();

    activateLiveTvControl('live-mode-epg', controller);
    activateLiveTvControl('toggle-epg-show-clock', controller);
    activateLiveTvControl('channel-switch-preview', controller);
    activateLiveTvControl('catalog-refresh-dropdown', controller, {
      onOpenDropdown: (id) => opened.push(id),
    });
    activateLiveTvControl('guide-refresh-dropdown', controller, {
      onOpenDropdown: (id) => opened.push(id),
    });
    activateLiveTvControl('catalog-refresh-now', controller, { onRefreshCatalogNow });
    activateLiveTvControl('guide-refresh-now', controller, { onRefreshGuideNow });

    expect(patches).toEqual([
      { defaultLiveMode: 'epg' },
      { epgShowClock: false },
      { liveChannelSwitchMode: 'preview' },
    ]);
    expect(opened).toEqual(['catalog-refresh-dropdown', 'guide-refresh-dropdown']);
    expect(onRefreshCatalogNow).toHaveBeenCalledTimes(1);
    expect(onRefreshGuideNow).toHaveBeenCalledTimes(1);
  });

  it('activates kept Playback controls (pitchLock, audioNormalization, filterSdh, preferHevcDv, autoPlayNext)', () => {
    const { controller, patches } = makeController();
    activatePlaybackControl('toggle-filter-sdh', controller);
    activatePlaybackControl('toggle-prefer-hevc-dv', controller);
    activatePlaybackControl('toggle-pitch-lock', controller);
    activatePlaybackControl('toggle-audio-normalization', controller);
    activatePlaybackControl('toggle-auto-play-next', controller);
    expect(patches).toEqual([
      { filterSdhSubtitles: true },
      { preferHevcOverDolbyVision: true },
      { pitchLock: false },
      { audioNormalization: true },
      { autoPlayNextEpisode: false },
    ]);
  });
});
