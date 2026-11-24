import { DEFAULT_PREFERENCES, mergeSubtitleStyle, ok, type PreferencesPatch } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { activatePlaybackControl } from './playback-controls';

describe('Wave C6 playback control activation (#412)', () => {
  it('toggles backgroundAudioPlayback via toggle-background-audio', () => {
    const patches: PreferencesPatch[] = [];
    const updatePreferences = vi.fn(async (patch: PreferencesPatch) => {
      patches.push(patch);
      return ok({
        ...DEFAULT_PREFERENCES,
        ...patch,
        subtitleStyle: mergeSubtitleStyle(DEFAULT_PREFERENCES.subtitleStyle, patch.subtitleStyle),
      });
    });

    activatePlaybackControl('toggle-background-audio', {
      preferences: { ...DEFAULT_PREFERENCES, backgroundAudioPlayback: false },
      updatePreferences,
      resetPreferences: vi.fn(async () => ok(DEFAULT_PREFERENCES)),
    });

    expect(patches).toEqual([{ backgroundAudioPlayback: true }]);
  });
});
