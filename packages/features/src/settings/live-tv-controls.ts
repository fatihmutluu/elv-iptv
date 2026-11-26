import type {
  CatalogRefreshHoursPref,
  DefaultLiveModePref,
  EpgRowDensity,
  EpgTimeSpanHoursPref,
  GuideRefreshHoursPref,
  LiveChannelSwitchModePref,
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

export const EPG_ROW_DENSITY_OPTIONS: ReadonlyArray<{
  readonly value: EpgRowDensity;
  readonly focusId: LiveTvFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'compact',
    focusId: 'epg-density-compact',
    testID: 'settings-livetv-epg-density-compact',
    labelKey: 'settings.epgRowDensityCompact',
  },
  {
    value: 'comfortable',
    focusId: 'epg-density-comfortable',
    testID: 'settings-livetv-epg-density-comfortable',
    labelKey: 'settings.epgRowDensityComfortable',
  },
  {
    value: 'cinematic',
    focusId: 'epg-density-cinematic',
    testID: 'settings-livetv-epg-density-cinematic',
    labelKey: 'settings.epgRowDensityCinematic',
  },
];

export const CATALOG_REFRESH_OPTIONS: ReadonlyArray<{
  readonly hours: CatalogRefreshHoursPref;
  readonly testID: string;
}> = [
  { hours: 3, testID: 'settings-livetv-catalog-refresh-3' },
  { hours: 6, testID: 'settings-livetv-catalog-refresh-6' },
  { hours: 12, testID: 'settings-livetv-catalog-refresh-12' },
  { hours: 24, testID: 'settings-livetv-catalog-refresh-24' },
  { hours: 48, testID: 'settings-livetv-catalog-refresh-48' },
];

export const GUIDE_REFRESH_OPTIONS: ReadonlyArray<{
  readonly hours: GuideRefreshHoursPref;
  readonly testID: string;
}> = [
  { hours: 3, testID: 'settings-livetv-guide-refresh-3' },
  { hours: 6, testID: 'settings-livetv-guide-refresh-6' },
  { hours: 12, testID: 'settings-livetv-guide-refresh-12' },
  { hours: 24, testID: 'settings-livetv-guide-refresh-24' },
  { hours: 48, testID: 'settings-livetv-guide-refresh-48' },
];

export const CHANNEL_SWITCH_MODE_OPTIONS: ReadonlyArray<{
  readonly value: LiveChannelSwitchModePref;
  readonly focusId: LiveTvFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'instant',
    focusId: 'channel-switch-instant',
    testID: 'settings-livetv-channel-switch-instant',
    labelKey: 'settings.liveTv.switchInstant',
  },
  {
    value: 'preview',
    focusId: 'channel-switch-preview',
    testID: 'settings-livetv-channel-switch-preview',
    labelKey: 'settings.liveTv.switchPreview',
  },
];

/** Optional action callbacks used when activating Live TV controls via 10-ft TV D-pad. */
export interface LiveTvControlActions {
  readonly onOpenDropdown?: (id: 'catalog-refresh-dropdown' | 'guide-refresh-dropdown') => void;
  readonly onRefreshCatalogNow?: () => void;
  readonly onRefreshGuideNow?: () => void;
}

/** Applies a TV D-pad activation on a Live TV & Guide settings control. */
export function activateLiveTvControl(
  controlId: LiveTvFocusId,
  preferences?: SettingsPreferencesController,
  actions?: LiveTvControlActions,
): void {
  if (controlId === 'catalog-refresh-dropdown' || controlId === 'guide-refresh-dropdown') {
    actions?.onOpenDropdown?.(controlId);
    return;
  }
  if (controlId === 'catalog-refresh-now') {
    actions?.onRefreshCatalogNow?.();
    return;
  }
  if (controlId === 'guide-refresh-now') {
    actions?.onRefreshGuideNow?.();
    return;
  }
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
  const densityOpt = EPG_ROW_DENSITY_OPTIONS.find((o) => o.focusId === controlId);
  if (densityOpt) {
    void preferences.updatePreferences({ epgRowDensity: densityOpt.value });
    return;
  }
  if (controlId === 'toggle-epg-show-clock') {
    void preferences.updatePreferences({ epgShowClock: !preferences.preferences.epgShowClock });
    return;
  }
  const switchOpt = CHANNEL_SWITCH_MODE_OPTIONS.find((o) => o.focusId === controlId);
  if (switchOpt) {
    void preferences.updatePreferences({ liveChannelSwitchMode: switchOpt.value });
  }
}
