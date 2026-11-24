import { DEFAULT_PREFERENCES, mergeSubtitleStyle, ok, type PreferencesPatch } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsPreferencesController } from './appearance-controls';
import { activateLiveTvControl, EPG_ROW_DENSITY_OPTIONS } from './live-tv-controls';

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

describe('Wave F0A Live TV EPG row density settings (#6, #25)', () => {
  it('exposes compact, comfortable, and cinematic row density options with stable focusIds', () => {
    expect(EPG_ROW_DENSITY_OPTIONS.map((o) => o.value)).toEqual([
      'compact',
      'comfortable',
      'cinematic',
    ]);
    expect(EPG_ROW_DENSITY_OPTIONS.map((o) => o.focusId)).toEqual([
      'epg-density-compact',
      'epg-density-comfortable',
      'epg-density-cinematic',
    ]);
  });

  it('activates epgRowDensity presets via TV D-pad controls', () => {
    const { controller, patches } = makeController();
    activateLiveTvControl('epg-density-compact', controller);
    activateLiveTvControl('epg-density-comfortable', controller);
    activateLiveTvControl('epg-density-cinematic', controller);
    expect(patches).toEqual([
      { epgRowDensity: 'compact' },
      { epgRowDensity: 'comfortable' },
      { epgRowDensity: 'cinematic' },
    ]);
  });
});
