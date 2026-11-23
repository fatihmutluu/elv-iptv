import { DEFAULT_PREFERENCES, type PreferencesPatch, type PreferencesSnapshot } from '@elv/domain';
import { Surface, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SettingsPreferencesController } from './appearance-controls';
import {
  CATALOG_REFRESH_OPTIONS,
  CHANNEL_SWITCH_MODE_OPTIONS,
  DEFAULT_LIVE_MODE_OPTIONS,
  EPG_SPAN_OPTIONS,
  GUIDE_REFRESH_OPTIONS,
  LOGO_BACKDROP_OPTIONS,
} from './live-tv-controls';
import { SettingsDivider, SettingsOptionRow, SettingsToggleRow } from './SettingsRowParts';
import type { LiveTvFocusId } from './useTvSettingsNavigation';

/** Props of {@link LiveTvSettingsPanel}. */
export interface LiveTvSettingsPanelProps {
  /** Reactive preferences controller (supplied by `AppShell` via `usePreferences()`). */
  readonly preferences?: SettingsPreferencesController;
  /** Currently focused Live TV & Guide control on 10-foot TV D-pad navigation. */
  readonly focusedControlId?: LiveTvFocusId | null;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;

/**
 * Cinema Quietude Live TV & Guide preferences panel (`#401`, `#126`, `#145`):
 * default Live TV sub-mode, EPG time window, genre tints, live clock, refresh interval,
 * channel logo readability backdrop, source badges, two-step OK preview, and title cleanup.
 */
export function LiveTvSettingsPanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
}: LiveTvSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const cardYRef = useRef<Partial<Record<'guide' | 'display', number>>>({});

  const activePrefs: PreferencesSnapshot = suppliedPrefs?.preferences ?? DEFAULT_PREFERENCES;

  const applyPatch = useCallback(
    (patch: PreferencesPatch): void => {
      if (suppliedPrefs) void suppliedPrefs.updatePreferences(patch);
    },
    [suppliedPrefs],
  );

  useEffect(() => {
    if (!isTv || !focusedControlId) return;
    let targetY: number | undefined;
    if (
      focusedControlId.startsWith('live-mode-') ||
      focusedControlId.startsWith('epg-span-') ||
      focusedControlId === 'toggle-epg-genre-tints' ||
      focusedControlId === 'toggle-epg-show-clock' ||
      focusedControlId.startsWith('catalog-refresh-') ||
      focusedControlId.startsWith('guide-refresh-')
    ) {
      targetY = focusedControlId.startsWith('live-mode-')
        ? 0
        : cardYRef.current.guide !== undefined
          ? Math.max(0, cardYRef.current.guide - 12)
          : 0;
    } else if (cardYRef.current.display !== undefined) {
      targetY = Math.max(0, cardYRef.current.display - 12);
    }
    if (targetY !== undefined) {
      scrollRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
    }
  }, [focusedControlId, isTv, theme.reduceMotion]);

  const liveModeOptions = useMemo(
    () =>
      DEFAULT_LIVE_MODE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const epgSpanOptions = useMemo(
    () =>
      EPG_SPAN_OPTIONS.map((opt) => ({
        value: opt.hours,
        label: i18n.t('settings.liveTv.epgSpanHours', { hours: opt.hours }),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const catalogRefreshOptions = useMemo(
    () =>
      CATALOG_REFRESH_OPTIONS.map((opt) => ({
        value: opt.hours,
        label:
          opt.hours === 0
            ? i18n.t('settings.liveTv.refreshManualOnly')
            : i18n.t('settings.liveTv.refreshHours', { hours: opt.hours }),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const guideRefreshOptions = useMemo(
    () =>
      GUIDE_REFRESH_OPTIONS.map((opt) => ({
        value: opt.hours,
        label:
          opt.hours === 0
            ? i18n.t('settings.liveTv.refreshManualOnly')
            : i18n.t('settings.liveTv.guideRefreshHours', { hours: opt.hours }),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const channelSwitchModeOptions = useMemo(
    () =>
      CHANNEL_SWITCH_MODE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const logoBackdropOptions = useMemo(
    () =>
      LOGO_BACKDROP_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  return (
    <ScrollView
      ref={scrollRef}
      testID="settings-panel-liveTv"
      {...(isTv ? { focusable: false } : {})}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
    >
      <View style={styles.headerBlock}>
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
          {i18n.t('settings.liveTv.title')}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('settings.liveTv.subtitle')}
        </Text>
      </View>

      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          cardYRef.current.guide = e.nativeEvent.layout.y;
        }}
      >
        <SettingsOptionRow
          title={i18n.t('settings.liveTv.defaultMode')}
          options={liveModeOptions}
          selectedValue={activePrefs.defaultLiveMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(defaultLiveMode) => applyPatch({ defaultLiveMode })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.liveTv.epgSpan')}
          options={epgSpanOptions}
          selectedValue={activePrefs.epgTimeSpanHours}
          focusedControlId={focusedControlId}
          isTv={isTv}
          tabularNums
          onSelect={(epgTimeSpanHours) => applyPatch({ epgTimeSpanHours })}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-livetv-toggle-epg-genre-tints"
          title={i18n.t('settings.liveTv.epgGenreTints')}
          checked={activePrefs.epgGenreTints}
          focused={focusedControlId === 'toggle-epg-genre-tints'}
          isTv={isTv}
          onToggle={() => applyPatch({ epgGenreTints: !activePrefs.epgGenreTints })}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-livetv-toggle-epg-show-clock"
          title={i18n.t('settings.liveTv.epgShowClock')}
          checked={activePrefs.epgShowClock}
          focused={focusedControlId === 'toggle-epg-show-clock'}
          isTv={isTv}
          onToggle={() => applyPatch({ epgShowClock: !activePrefs.epgShowClock })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.liveTv.catalogRefreshInterval')}
          description={i18n.t('settings.liveTv.catalogRefreshIntervalDesc')}
          options={catalogRefreshOptions}
          selectedValue={activePrefs.catalogRefreshHours}
          focusedControlId={focusedControlId}
          isTv={isTv}
          tabularNums
          onSelect={(catalogRefreshHours) => applyPatch({ catalogRefreshHours })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.liveTv.guideRefresh')}
          options={guideRefreshOptions}
          selectedValue={activePrefs.guideRefreshHours}
          focusedControlId={focusedControlId}
          isTv={isTv}
          tabularNums
          onSelect={(guideRefreshHours) => applyPatch({ guideRefreshHours })}
        />
      </Surface>

      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          cardYRef.current.display = e.nativeEvent.layout.y;
        }}
      >
        <SettingsOptionRow
          title={i18n.t('settings.liveTv.channelSwitchMode')}
          description={i18n.t('settings.liveTv.channelSwitchModeDesc')}
          options={channelSwitchModeOptions}
          selectedValue={activePrefs.liveChannelSwitchMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(liveChannelSwitchMode) => applyPatch({ liveChannelSwitchMode })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.liveTv.logoBackdrop')}
          options={logoBackdropOptions}
          selectedValue={activePrefs.logoBackdropMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(logoBackdropMode) => applyPatch({ logoBackdropMode })}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-livetv-toggle-source-badges"
          title={i18n.t('settings.liveTv.sourceBadges')}
          checked={activePrefs.showSourceBadges}
          focused={focusedControlId === 'toggle-source-badges'}
          isTv={isTv}
          onToggle={() => applyPatch({ showSourceBadges: !activePrefs.showSourceBadges })}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-livetv-toggle-two-step-preview"
          title={i18n.t('settings.liveTv.twoStepPreview')}
          checked={activePrefs.liveOkTwoStepPreview}
          focused={focusedControlId === 'toggle-two-step-preview'}
          isTv={isTv}
          onToggle={() => applyPatch({ liveOkTwoStepPreview: !activePrefs.liveOkTwoStepPreview })}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-livetv-toggle-clean-titles"
          title={i18n.t('settings.liveTv.cleanTitles')}
          checked={activePrefs.cleanChannelTitles}
          focused={focusedControlId === 'toggle-clean-titles'}
          isTv={isTv}
          onToggle={() => applyPatch({ cleanChannelTitles: !activePrefs.cleanChannelTitles })}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-livetv-toggle-collapse-variants"
          title={i18n.t('settings.liveTv.collapseVariants')}
          description={i18n.t('settings.liveTv.collapseVariantsDesc')}
          checked={activePrefs.collapseLiveVariants}
          focused={focusedControlId === 'toggle-collapse-variants'}
          isTv={isTv}
          onToggle={() => applyPatch({ collapseLiveVariants: !activePrefs.collapseLiveVariants })}
        />
      </Surface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  headerBlock: { gap: 4 },
  sectionCard: { padding: 18, gap: 14 },
});
