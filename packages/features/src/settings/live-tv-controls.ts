import type {
  DefaultLiveModePref,
  EpgTimeSpanHoursPref,
  GuideRefreshHoursPref,
  LogoBackdropModePref,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import type { SettingsPreferencesController } from './appearance-controls';
import type { LiveTvFocusId } from './useTvSettingsNavigation';

export const DEFAULT_LIVE_MODE_OPTIONS: ReadonlyArray<{
  readonly value: DefaultLiveModePref;
  readonly focusId: LiveTvFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'favorites',
    focusId: 'live-mode-favorites',
    testID: 'settings-livetv-mode-favorites',
    labelKey: 'live.mode.favorites',
  },
  {
    value: 'channels',
    focusId: 'live-mode-channels',
    testID: 'settings-livetv-mode-channels',
    labelKey: 'live.mode.channels',
  },
  {
    value: 'epg',
    focusId: 'live-mode-epg',
    testID: 'settings-livetv-mode-epg',
    labelKey: 'live.mode.guide',
  },
];

export const EPG_SPAN_OPTIONS: ReadonlyArray<{
  readonly hours: EpgTimeSpanHoursPref;
  readonly focusId: LiveTvFocusId;
  readonly testID: string;
}> = [
  { hours: 2, focusId: 'epg-span-2', testID: 'settings-livetv-epg-span-2' },
  { hours: 3, focusId: 'epg-span-3', testID: 'settings-livetv-epg-span-3' },
  { hours: 6, focusId: 'epg-span-6', testID: 'settings-livetv-epg-span-6' },
];

export const GUIDE_REFRESH_OPTIONS: ReadonlyArray<{
  readonly hours: GuideRefreshHoursPref;
  readonly focusId: LiveTvFocusId;
  readonly testID: string;
}> = [
  { hours: 6, focusId: 'guide-refresh-6', testID: 'settings-livetv-guide-refresh-6' },
  { hours: 12, focusId: 'guide-refresh-12', testID: 'settings-livetv-guide-refresh-12' },
  { hours: 24, focusId: 'guide-refresh-24', testID: 'settings-livetv-guide-refresh-24' },
];

export const LOGO_BACKDROP_OPTIONS: ReadonlyArray<{
  readonly value: LogoBackdropModePref;
  readonly focusId: LiveTvFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'plate',
    focusId: 'logo-backdrop-plate',
    testID: 'settings-livetv-logo-backdrop-plate',
    labelKey: 'settings.liveTv.logoBackdrop.plate',
  },
  {
    value: 'invert',
    focusId: 'logo-backdrop-invert',
    testID: 'settings-livetv-logo-backdrop-invert',
    labelKey: 'settings.liveTv.logoBackdrop.invert',
  },
  {
    value: 'off',
    focusId: 'logo-backdrop-off',
    testID: 'settings-livetv-logo-backdrop-off',
    labelKey: 'settings.liveTv.logoBackdrop.off',
  },
];

/** Applies a TV D-pad activation on a Live TV & Guide settings control (`#401`, `#126`, `#145`). */
export function activateLiveTvControl(
  controlId: LiveTvFocusId,
  preferences?: SettingsPreferencesController,
): void {
  if (!preferences) return;
  const modeOpt = DEFAULT_LIVE_MODE_OPTIONS.find((o) => o.focusId === controlId);
  if (modeOpt) {
    void preferences.updatePreferences({ defaultLiveMode: modeOpt.value });
    return;
  }
  const spanOpt = EPG_SPAN_OPTIONS.find((o) => o.focusId === controlId);
  if (spanOpt) {
    void preferences.updatePreferences({ epgTimeSpanHours: spanOpt.hours });
    return;
  }
  if (controlId === 'toggle-epg-genre-tints') {
    void preferences.updatePreferences({ epgGenreTints: !preferences.preferences.epgGenreTints });
    return;
  }
  if (controlId === 'toggle-epg-show-clock') {
    void preferences.updatePreferences({ epgShowClock: !preferences.preferences.epgShowClock });
    return;
  }
  const refreshOpt = GUIDE_REFRESH_OPTIONS.find((o) => o.focusId === controlId);
  if (refreshOpt) {
    void preferences.updatePreferences({ guideRefreshHours: refreshOpt.hours });
    return;
  }
  const logoOpt = LOGO_BACKDROP_OPTIONS.find((o) => o.focusId === controlId);
  if (logoOpt) {
    void preferences.updatePreferences({ logoBackdropMode: logoOpt.value });
    return;
  }
  if (controlId === 'toggle-source-badges') {
    void preferences.updatePreferences({
      showSourceBadges: !preferences.preferences.showSourceBadges,
    });
    return;
  }
  if (controlId === 'toggle-two-step-preview') {
    void preferences.updatePreferences({
      liveOkTwoStepPreview: !preferences.preferences.liveOkTwoStepPreview,
    });
    return;
  }
  if (controlId === 'toggle-clean-titles') {
    void preferences.updatePreferences({
      cleanChannelTitles: !preferences.preferences.cleanChannelTitles,
    });
  }
}
