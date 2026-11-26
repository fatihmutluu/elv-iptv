import {
  type CatalogRefreshHoursPref,
  DEFAULT_PREFERENCES,
  type GuideRefreshHoursPref,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import { CtaButton, Surface, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SettingsPreferencesController } from './appearance-controls';
import {
  CATALOG_REFRESH_OPTIONS,
  CHANNEL_SWITCH_MODE_OPTIONS,
  DEFAULT_LIVE_MODE_OPTIONS,
  EPG_ROW_DENSITY_OPTIONS,
  EPG_SPAN_OPTIONS,
  GUIDE_REFRESH_OPTIONS,
} from './live-tv-controls';
import { type SettingsDropdownOption, SettingsDropdownRow } from './SettingsDropdownRow';
import { SettingsDivider, SettingsOptionRow, SettingsToggleRow } from './SettingsRowParts';
import type { LiveTvFocusId } from './useTvSettingsNavigation';

const REFRESHED_FEEDBACK_MS = 2_500;

type RefreshStatus = 'idle' | 'refreshing' | 'refreshed';

/** Props of {@link LiveTvSettingsPanel}. */
export interface LiveTvSettingsPanelProps {
  /** Reactive preferences controller (supplied by `AppShell` via `usePreferences()`). */
  readonly preferences?: SettingsPreferencesController;
  /** Currently focused Live TV & Guide control on 10-foot TV D-pad navigation. */
  readonly focusedControlId?: LiveTvFocusId | null;
  /** Triggers an immediate catalog refresh across active sources. */
  readonly onRefreshCatalogNow?: () => Promise<void> | void;
  /** Triggers an immediate TV guide (EPG) refresh across active sources. */
  readonly onRefreshGuideNow?: () => Promise<void> | void;
  /** Optional controlled TV dropdown modal id owned by `SettingsScreen`. */
  readonly openTvDropdownId?: 'catalog-refresh-dropdown' | 'guide-refresh-dropdown' | null;
  /** Invoked when a TV dropdown modal opens or closes. */
  readonly onOpenTvDropdownChange?: (
    id: 'catalog-refresh-dropdown' | 'guide-refresh-dropdown' | null,
  ) => void;
  /** Optional controlled catalog refresh status owned by `SettingsScreen` (for TV D-pad trigger). */
  readonly catalogRefreshStatus?: RefreshStatus;
  /** Optional controlled guide refresh status owned by `SettingsScreen` (for TV D-pad trigger). */
  readonly guideRefreshStatus?: RefreshStatus;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;

/**
 * Cinema Quietude Live TV & Guide preferences panel:
 * default Live TV sub-mode, EPG time window, EPG row density, live guide clock,
 * Catalog & Guide refresh interval dropdowns (`3–48 h`) with adjacent "Refresh now" actions,
 * and TV-only `CH+/CH-` channel switch mode.
 */
export function LiveTvSettingsPanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
  onRefreshCatalogNow,
  onRefreshGuideNow,
  openTvDropdownId = null,
  onOpenTvDropdownChange,
  catalogRefreshStatus: controlledCatalogStatus,
  guideRefreshStatus: controlledGuideStatus,
}: LiveTvSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const cardYRef = useRef<Partial<Record<'guide' | 'tvRemote', number>>>({});
  const mountedRef = useRef(true);
  const catalogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [localCatalogStatus, setLocalCatalogStatus] = useState<RefreshStatus>('idle');
  const [localGuideStatus, setLocalGuideStatus] = useState<RefreshStatus>('idle');
  const [openPopover, setOpenPopover] = useState<'catalog' | 'guide' | null>(null);

  const catalogStatus = controlledCatalogStatus ?? localCatalogStatus;
  const guideStatus = controlledGuideStatus ?? localGuideStatus;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (catalogTimerRef.current !== null) clearTimeout(catalogTimerRef.current);
      if (guideTimerRef.current !== null) clearTimeout(guideTimerRef.current);
    };
  }, []);

  const activePrefs: PreferencesSnapshot = suppliedPrefs?.preferences ?? DEFAULT_PREFERENCES;

  const applyPatch = useCallback(
    (patch: PreferencesPatch): void => {
      if (suppliedPrefs) void suppliedPrefs.updatePreferences(patch);
    },
    [suppliedPrefs],
  );

  const handleRefreshCatalog = useCallback(() => {
    if (catalogStatus === 'refreshing') return;
    if (controlledCatalogStatus !== undefined) {
      void onRefreshCatalogNow?.();
      return;
    }
    setLocalCatalogStatus('refreshing');
    if (catalogTimerRef.current !== null) {
      clearTimeout(catalogTimerRef.current);
      catalogTimerRef.current = null;
    }
    void Promise.resolve(onRefreshCatalogNow?.())
      .catch(() => undefined)
      .finally(() => {
        if (!mountedRef.current) return;
        setLocalCatalogStatus('refreshed');
        catalogTimerRef.current = setTimeout(() => {
          catalogTimerRef.current = null;
          if (mountedRef.current) setLocalCatalogStatus('idle');
        }, REFRESHED_FEEDBACK_MS);
      });
  }, [catalogStatus, controlledCatalogStatus, onRefreshCatalogNow]);

  const handleRefreshGuide = useCallback(() => {
    if (guideStatus === 'refreshing') return;
    if (controlledGuideStatus !== undefined) {
      void onRefreshGuideNow?.();
      return;
    }
    setLocalGuideStatus('refreshing');
    if (guideTimerRef.current !== null) {
      clearTimeout(guideTimerRef.current);
      guideTimerRef.current = null;
    }
    void Promise.resolve(onRefreshGuideNow?.())
      .catch(() => undefined)
      .finally(() => {
        if (!mountedRef.current) return;
        setLocalGuideStatus('refreshed');
        guideTimerRef.current = setTimeout(() => {
          guideTimerRef.current = null;
          if (mountedRef.current) setLocalGuideStatus('idle');
        }, REFRESHED_FEEDBACK_MS);
      });
  }, [controlledGuideStatus, guideStatus, onRefreshGuideNow]);

  useEffect(() => {
    if (!isTv || !focusedControlId) return;
    let targetY: number | undefined;
    if (focusedControlId.startsWith('live-mode-')) {
      targetY = 0;
    } else if (focusedControlId.startsWith('channel-switch-')) {
      if (cardYRef.current.tvRemote !== undefined) {
        targetY = Math.max(0, cardYRef.current.tvRemote - 12);
      }
    } else if (cardYRef.current.guide !== undefined) {
      targetY = Math.max(0, cardYRef.current.guide - 12);
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

  const epgRowDensityOptions = useMemo(
    () =>
      EPG_ROW_DENSITY_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const catalogRefreshOptions = useMemo<readonly SettingsDropdownOption<CatalogRefreshHoursPref>[]>(
    () =>
      CATALOG_REFRESH_OPTIONS.map((opt) => ({
        value: opt.hours,
        label: i18n.t('settings.liveTv.refreshHours', { hours: opt.hours }),
        testID: opt.testID,
      })),
    [i18n],
  );

  const guideRefreshOptions = useMemo<readonly SettingsDropdownOption<GuideRefreshHoursPref>[]>(
    () =>
      GUIDE_REFRESH_OPTIONS.map((opt) => ({
        value: opt.hours,
        label: i18n.t('settings.liveTv.guideRefreshHours', { hours: opt.hours }),
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

  const refreshLabel = (status: RefreshStatus): string =>
    status === 'refreshing'
      ? i18n.t('settings.liveTv.refreshing')
      : status === 'refreshed'
        ? i18n.t('settings.liveTv.refreshed')
        : i18n.t('settings.liveTv.refreshNow');

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
        style={[
          styles.sectionCard,
          openPopover !== null || openTvDropdownId !== null ? styles.elevatedCard : undefined,
        ]}
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

        <SettingsOptionRow
          title={i18n.t('settings.epgRowDensity')}
          options={epgRowDensityOptions}
          selectedValue={activePrefs.epgRowDensity}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(epgRowDensity) => applyPatch({ epgRowDensity })}
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

        <SettingsDropdownRow
          testID="settings-livetv-catalog-refresh-dropdown"
          title={i18n.t('settings.liveTv.catalogRefreshInterval')}
          description={i18n.t('settings.liveTv.catalogRefreshIntervalDesc')}
          options={catalogRefreshOptions}
          selectedValue={activePrefs.catalogRefreshHours}
          {...(activePrefs.catalogRefreshHours === 0
            ? { fallbackLabel: i18n.t('settings.liveTv.refreshManualOnly') }
            : {})}
          focused={focusedControlId === 'catalog-refresh-dropdown'}
          isTv={isTv}
          tabularNums
          open={
            isTv && onOpenTvDropdownChange !== undefined
              ? openTvDropdownId === 'catalog-refresh-dropdown'
              : openPopover === 'catalog'
          }
          onOpenChange={(next) => {
            if (isTv && onOpenTvDropdownChange !== undefined) {
              onOpenTvDropdownChange(next ? 'catalog-refresh-dropdown' : null);
            } else {
              setOpenPopover((prev) => (next ? 'catalog' : prev === 'catalog' ? null : prev));
            }
          }}
          onSelect={(catalogRefreshHours) => applyPatch({ catalogRefreshHours })}
          accessory={
            <CtaButton
              testID="settings-livetv-catalog-refresh-now"
              variant="secondary"
              label={refreshLabel(catalogStatus)}
              disabled={catalogStatus === 'refreshing'}
              focused={focusedControlId === 'catalog-refresh-now'}
              focusable={!isTv}
              onPress={handleRefreshCatalog}
            />
          }
        />

        <SettingsDivider />

        <SettingsDropdownRow
          testID="settings-livetv-guide-refresh-dropdown"
          title={i18n.t('settings.liveTv.guideRefresh')}
          options={guideRefreshOptions}
          selectedValue={activePrefs.guideRefreshHours}
          {...(activePrefs.guideRefreshHours === 0
            ? { fallbackLabel: i18n.t('settings.liveTv.refreshManualOnly') }
            : {})}
          focused={focusedControlId === 'guide-refresh-dropdown'}
          isTv={isTv}
          tabularNums
          open={
            isTv && onOpenTvDropdownChange !== undefined
              ? openTvDropdownId === 'guide-refresh-dropdown'
              : openPopover === 'guide'
          }
          onOpenChange={(next) => {
            if (isTv && onOpenTvDropdownChange !== undefined) {
              onOpenTvDropdownChange(next ? 'guide-refresh-dropdown' : null);
            } else {
              setOpenPopover((prev) => (next ? 'guide' : prev === 'guide' ? null : prev));
            }
          }}
          onSelect={(guideRefreshHours) => applyPatch({ guideRefreshHours })}
          accessory={
            <CtaButton
              testID="settings-livetv-guide-refresh-now"
              variant="secondary"
              label={refreshLabel(guideStatus)}
              disabled={guideStatus === 'refreshing'}
              focused={focusedControlId === 'guide-refresh-now'}
              focusable={!isTv}
              onPress={handleRefreshGuide}
            />
          }
        />
      </Surface>

      {isTv ? (
        <Surface
          tone="surface"
          bordered
          rounded="modal"
          style={styles.sectionCard}
          onLayout={(e) => {
            cardYRef.current.tvRemote = e.nativeEvent.layout.y;
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
        </Surface>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  headerBlock: { gap: 4 },
  sectionCard: { padding: 18, gap: 14 },
  elevatedCard: { zIndex: 40 },
});
