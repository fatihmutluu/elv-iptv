import { DEFAULT_PREFERENCES, ok, type PreferencesPatch } from '@elv/domain';
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
      return ok({ ...DEFAULT_PREFERENCES, ...patch });
    }),
    resetPreferences: vi.fn(async () => ok(DEFAULT_PREFERENCES)),
  };
  return { controller, patches };
}

describe('Wave C3 settings toggles (#218, #404)', () => {
  it('toggles collapseLiveVariants via Live TV TV-nav control (#218)', () => {
    const { controller, patches } = makeController();
    activateLiveTvControl('toggle-collapse-variants', controller);
    expect(patches).toEqual([{ collapseLiveVariants: true }]);
  });

  it('toggles groupVodVersions via Playback TV-nav control (#404)', () => {
    const { controller, patches } = makeController();
    activatePlaybackControl('toggle-group-vod-versions', controller);
    expect(patches).toEqual([{ groupVodVersions: false }]);
  });

  it('activates Wave C5A deinterlaceMode, pitchLock, audioNormalization, and windowAspectRatioLock controls (#243, #332)', () => {
    const { controller, patches } = makeController();
    activatePlaybackControl('deinterlace-auto', controller);
    activatePlaybackControl('deinterlace-bwdif', controller);
    activatePlaybackControl('deinterlace-off', controller);
    activatePlaybackControl('toggle-pitch-lock', controller);
    activatePlaybackControl('toggle-audio-normalization', controller);
    activatePlaybackControl('toggle-window-aspect-ratio-lock', controller);
    expect(patches).toEqual([
      { deinterlaceMode: 'auto' },
      { deinterlaceMode: 'bwdif' },
      { deinterlaceMode: 'off' },
      { pitchLock: false },
      { audioNormalization: true },
      { windowAspectRatioLock: true },
    ]);
  });
});
