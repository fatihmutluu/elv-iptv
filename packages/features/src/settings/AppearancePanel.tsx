import {
  type ArtworkCacheFormFactor,
  type ArtworkCacheLimitMbPref,
  DEFAULT_PREFERENCES,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import {
  CtaButton,
  defaultLoadedArtworkUris,
  FilterChip,
  Surface,
  TABULAR_NUMS_STYLE,
  THEME_PRESETS,
  type ThemePresetId,
  useI18n,
  useTheme,
  useThemeController,
  useUiAdapters,
  useViewport,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ARTWORK_CACHE_OPTIONS,
  buildAppearanceResetPatch,
  computeAppearanceScrollY,
  FONT_SCALE_OPTIONS,
  LANGUAGE_OPTIONS,
  type SettingsPreferencesController,
  SUBTITLE_FONT_OPTIONS,
  stepOverscanRatio,
  UI_FONT_OPTIONS,
} from './appearance-controls';
import { DiagnosticsSettingsCard } from './DiagnosticsSettingsCard';
import { HomeLayoutEditor } from './HomeLayoutEditor';
import { type SettingsDropdownOption, SettingsDropdownRow } from './SettingsDropdownRow';
import { SettingsDivider, SettingsToggleRow } from './SettingsRowParts';
import { ThemePresetGrid } from './ThemePresetGrid';
import { TvDisplaySettingsCard } from './TvDisplaySettingsCard';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

export {
  activateAppearanceControl,
  adjustAppearanceControl,
  buildAppearanceResetPatch,
  type SettingsPreferencesController,
} from './appearance-controls';

const CLEAR_FEEDBACK_MS = 3_000;

function formatBytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** Props of {@link AppearancePanel}. */
export interface AppearancePanelProps {
  /** Reactive preferences controller (supplied by `AppShell` via `usePreferences()`). */
  readonly preferences?: SettingsPreferencesController;
  /** Currently focused Appearance control on 10-foot TV D-pad navigation. */
  readonly focusedControlId?: AppearanceFocusId | null;
  /** Optional external clear handler shared with TV D-pad activation in `SettingsScreen`. */
  readonly onClearArtworkCache?: () => Promise<void> | void;
  /** Optional controlled cleared-confirmation flag owned by `SettingsScreen`. */
  readonly artworkCacheCleared?: boolean;
  /** Invoked whenever unified Diagnostics & Performance Telemetry opt-in changes (`#509`). */
  readonly onTelemetryOptInChange?: (enabled: boolean) => void;
  /** Optional controlled TV dropdown modal id owned by `SettingsScreen`. */
  readonly openTvDropdownId?: 'lang-dropdown' | 'artwork-cache-dropdown' | null;
  /** Invoked when a TV dropdown modal opens or closes. */
  readonly onOpenTvDropdownChange?: (id: 'lang-dropdown' | 'artwork-cache-dropdown' | null) => void;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;
type SectionLayout = { readonly y: number; readonly height: number };

/**
 * Cinema Quietude Appearance, Accessibility & Artwork Cache settings panel:
 * live in-app Language dropdown (`#16`), 6 dynamic Theme Presets including WCAG AAA High Contrast
 * (`#325`), Home Layout Editor, Typography & Reduce Motion, Android Exit Guard, TV Display,
 * bounded Artwork Cache dropdown (`64–512 MB`) + live disk usage, Diagnostics, and scoped Appearance Reset.
 */
export function AppearancePanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
  onClearArtworkCache,
  artworkCacheCleared: controlledCleared,
  onTelemetryOptInChange,
  openTvDropdownId = null,
  onOpenTvDropdownChange,
}: AppearancePanelProps): ReactElement {
  const theme = useTheme();
  const themeCtrl = useThemeController();
  const i18n = useI18n();
  const viewport = useViewport();
  const adapters = useUiAdapters();
  const [localCleared, setLocalCleared] = useState(false);
  const [cacheUsedMb, setCacheUsedMb] = useState<number | null>(null);
  const [openPopover, setOpenPopover] = useState<'lang' | 'cache' | null>(null);

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const layoutsRef = useRef<
    Partial<
      Record<
        'theme' | 'font' | 'tvDisplay' | 'artworkCache' | 'reset' | 'diagnostics' | 'homeLayout',
        SectionLayout
      >
    >
  >({});
  const motionOffsetYRef = useRef(0);

  const isTv = viewport.formFactor === 'tv';
  const showConfirmExitOnBack = Platform.OS === 'android';
  const platformFormFactor: ArtworkCacheFormFactor =
    viewport.formFactor === 'desktop' ? 'desktop' : viewport.formFactor === 'tv' ? 'tv' : 'mobile';

  const activePrefs: PreferencesSnapshot = suppliedPrefs?.preferences ?? {
    ...DEFAULT_PREFERENCES,
    themePreset: theme.preset === 'custom' ? DEFAULT_PREFERENCES.themePreset : theme.preset,
    locale: i18n.locale,
    fontScale: theme.fontScale,
    reduceMotion: theme.reduceMotion,
    uiFontFamily: theme.uiFontFamily,
  };

  const refreshArtworkCacheStats = useCallback(() => {
    const readStats = adapters.artworkCache?.stats;
    if (!readStats) return;
    void Promise.resolve(readStats())
      .then((stats) => {
        if (mountedRef.current && stats) {
          setCacheUsedMb(formatBytesToMb(stats.bytes));
        }
      })
      .catch(() => undefined);
  }, [adapters.artworkCache]);

  useEffect(() => {
    mountedRef.current = true;
    refreshArtworkCacheStats();
    return () => {
      mountedRef.current = false;
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    };
  }, [refreshArtworkCacheStats]);

  useEffect(() => {
    if (controlledCleared) {
      refreshArtworkCacheStats();
    }
  }, [controlledCleared, refreshArtworkCacheStats]);

  useEffect(() => {
    if (!isTv || !focusedControlId) return;
    const targetY = computeAppearanceScrollY(
      focusedControlId,
      layoutsRef.current,
      motionOffsetYRef.current,
    );
    if (targetY !== undefined) {
      scrollRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
    }
  }, [focusedControlId, isTv, theme.reduceMotion]);

  const applyPatch = useCallback(
    (patch: PreferencesPatch): void => {
      if (suppliedPrefs) {
        void suppliedPrefs.updatePreferences(patch);
        return;
      }
      if (patch.themePreset && patch.themePreset in THEME_PRESETS) {
        themeCtrl.setPreset(patch.themePreset as ThemePresetId);
      }
      if (patch.fontScale !== undefined) themeCtrl.setFontScale(patch.fontScale);
      if (patch.reduceMotion !== undefined) themeCtrl.setReduceMotion(patch.reduceMotion);
      if (patch.uiFontFamily !== undefined) themeCtrl.setUiFontFamily(patch.uiFontFamily);
      if (patch.locale === 'tr' || patch.locale === 'en') i18n.setLocale(patch.locale);
    },
    [i18n, suppliedPrefs, themeCtrl],
  );

  const handleSelectArtworkCacheLimit = useCallback(
    (mb: ArtworkCacheLimitMbPref) => {
      applyPatch({ artworkCacheLimitMb: mb });
      const setLimitBytes = adapters.artworkCache?.setLimitBytes;
      if (setLimitBytes !== undefined) {
        void Promise.resolve(setLimitBytes(mb * 1024 * 1024))
          .then(() => refreshArtworkCacheStats())
          .catch(() => undefined);
      }
    },
    [adapters.artworkCache, applyPatch, refreshArtworkCacheStats],
  );

  const handleClearArtworkCache = useCallback(() => {
    if (onClearArtworkCache) {
      void Promise.resolve(onClearArtworkCache()).then(() => refreshArtworkCacheStats());
      return;
    }
    defaultLoadedArtworkUris.clear();
    void Promise.resolve(adapters.artworkCache?.clear())
      .then(() => refreshArtworkCacheStats())
      .catch(() => undefined);
    setLocalCleared(true);
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setLocalCleared(false);
    }, CLEAR_FEEDBACK_MS);
  }, [adapters.artworkCache, onClearArtworkCache, refreshArtworkCacheStats]);

  const handleReset = useCallback(() => {
    const { patch, platformDefaultMb } = buildAppearanceResetPatch(platformFormFactor);
    if (suppliedPrefs) {
      void suppliedPrefs.updatePreferences(patch);
    } else {
      themeCtrl.setPreset('obsidianCrimson');
      themeCtrl.setFontScale(1);
      themeCtrl.setReduceMotion(false);
      themeCtrl.setUiFontFamily('system');
    }
    const setLimitBytes = adapters.artworkCache?.setLimitBytes;
    if (setLimitBytes !== undefined) {
      void Promise.resolve(setLimitBytes(platformDefaultMb * 1024 * 1024))
        .then(() => refreshArtworkCacheStats())
        .catch(() => undefined);
    }
    onTelemetryOptInChange?.(false);
  }, [
    adapters.artworkCache,
    onTelemetryOptInChange,
    platformFormFactor,
    refreshArtworkCacheStats,
    suppliedPrefs,
    themeCtrl,
  ]);

  const languageOptions = useMemo<readonly SettingsDropdownOption<'system' | 'en' | 'tr'>[]>(
    () =>
      LANGUAGE_OPTIONS.map((opt) => ({
        value: opt.id,
        label: opt.id === 'en' ? 'English' : opt.id === 'tr' ? 'Türkçe' : i18n.t(opt.labelKey),
        testID: opt.testID,
      })),
    [i18n],
  );

  const artworkCacheOptions = useMemo<readonly SettingsDropdownOption<ArtworkCacheLimitMbPref>[]>(
    () =>
      ARTWORK_CACHE_OPTIONS.map((opt) => ({
        value: opt.mb,
        label: i18n.t('settings.artworkCacheLimitMb', { mb: opt.mb }),
        testID: opt.testID,
      })),
    [i18n],
  );

  const showClearedMessage = controlledCleared ?? localCleared;

  return (
    <ScrollView
      ref={scrollRef}
      testID="settings-panel-appearance"
      {...(isTv ? { focusable: false } : {})}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
    >
      {/* 1. Language */}
      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={[
          styles.sectionCard,
          openPopover === 'lang' || openTvDropdownId === 'lang-dropdown'
            ? styles.elevatedCard
            : undefined,
        ]}
      >
        <SettingsDropdownRow
          testID="settings-language-dropdown"
          title={i18n.t('settings.language.label')}
          description={i18n.t('settings.language.description')}
          options={languageOptions}
          selectedValue={activePrefs.locale}
          focused={focusedControlId === 'lang-dropdown'}
          isTv={isTv}
          open={
            isTv && onOpenTvDropdownChange !== undefined
              ? openTvDropdownId === 'lang-dropdown'
              : openPopover === 'lang'
          }
          onOpenChange={(next) => {
            if (isTv && onOpenTvDropdownChange !== undefined) {
              onOpenTvDropdownChange(next ? 'lang-dropdown' : null);
            } else {
              setOpenPopover((prev) => (next ? 'lang' : prev === 'lang' ? null : prev));
            }
          }}
          onSelect={(locale) => applyPatch({ locale })}
        />
      </Surface>

      {/* 2. Theme */}
      <Surface
        testID="settings-section-theme"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          layoutsRef.current.theme = {
            y: e.nativeEvent.layout.y,
            height: e.nativeEvent.layout.height,
          };
        }}
      >
        <View style={styles.blockHeader}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('settings.theme.label')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('settings.theme.description')}
          </Text>
        </View>

        <ThemePresetGrid
          activePreset={activePrefs.themePreset}
          focusedControlId={focusedControlId}
          onSelectPreset={(presetId) => applyPatch({ themePreset: presetId })}
        />
      </Surface>

      {/* 3. Home Layout Editor */}
      <HomeLayoutEditor
        layout={activePrefs.homeLayout}
        focusedControlId={focusedControlId}
        isTv={isTv}
        onChange={(nextLayout) => applyPatch({ homeLayout: nextLayout })}
        onLayoutBox={(box) => {
          layoutsRef.current.homeLayout = box;
        }}
      />

      {/* 4. Typography, Reduce Motion & Android Exit Guard */}
      <Surface
        testID="settings-section-font"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          layoutsRef.current.font = {
            y: e.nativeEvent.layout.y,
            height: e.nativeEvent.layout.height,
          };
        }}
      >
        <View style={styles.rowHeader}>
          <View style={styles.rowText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('settings.fontScale.label')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('settings.fontScale.description')}
            </Text>
          </View>
          <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
            {FONT_SCALE_OPTIONS.map((opt) => (
              <FilterChip
                key={opt.testID}
                testID={opt.testID}
                label={opt.label}
                selected={Math.abs(activePrefs.fontScale - opt.scale) < 0.01}
                focused={focusedControlId === opt.focusId}
                focusable={!isTv}
                onPress={() => applyPatch({ fontScale: opt.scale })}
              />
            ))}
          </View>
        </View>

        <SettingsDivider />

        <View style={styles.rowHeader}>
          <View style={styles.rowText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('settings.uiFont')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('settings.uiFontHint')}
            </Text>
          </View>
          <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
            {UI_FONT_OPTIONS.map((opt) => (
              <FilterChip
                key={opt.id}
                testID={opt.testID}
                label={i18n.t(opt.labelKey)}
                selected={activePrefs.uiFontFamily === opt.id}
                focused={focusedControlId === opt.focusId}
                focusable={!isTv}
                onPress={() => applyPatch({ uiFontFamily: opt.id })}
              />
            ))}
          </View>
        </View>

        <SettingsDivider />

        <View style={styles.rowHeader}>
          <View style={styles.rowText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('settings.subtitleFont')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('settings.subtitleFontHint')}
            </Text>
          </View>
          <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
            {SUBTITLE_FONT_OPTIONS.map((opt) => (
              <FilterChip
                key={opt.id}
                testID={opt.testID}
                label={i18n.t(opt.labelKey)}
                selected={activePrefs.subtitleFontFamily === opt.id}
                focused={focusedControlId === opt.focusId}
                focusable={!isTv}
                onPress={() => applyPatch({ subtitleFontFamily: opt.id })}
              />
            ))}
          </View>
        </View>

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-toggle-reduce-motion"
          title={i18n.t('settings.reduceMotion.label')}
          description={i18n.t('settings.reduceMotion.description')}
          checked={activePrefs.reduceMotion}
          focused={focusedControlId === 'toggle-reduce-motion'}
          isTv={isTv}
          onLayoutY={(y) => {
            motionOffsetYRef.current = y;
          }}
          onToggle={() => applyPatch({ reduceMotion: !activePrefs.reduceMotion })}
        />

        {showConfirmExitOnBack ? (
          <>
            <SettingsDivider />
            <SettingsToggleRow
              testID="settings-toggle-confirm-exit"
              title={i18n.t('settings.appearance.confirmExitOnBack')}
              checked={activePrefs.confirmExitOnBack}
              focused={focusedControlId === 'toggle-confirm-exit'}
              isTv={isTv}
              onToggle={() => applyPatch({ confirmExitOnBack: !activePrefs.confirmExitOnBack })}
            />
          </>
        ) : null}
      </Surface>

      {/* 5. (TV only) TvDisplaySettingsCard */}
      {isTv ? (
        <TvDisplaySettingsCard
          overscanX={activePrefs.overscanX}
          overscanY={activePrefs.overscanY}
          tvClockMode={activePrefs.tvClockMode}
          focusedControlId={focusedControlId}
          onStepOverscan={(axis, delta) => {
            if (axis === 'x') {
              applyPatch({ overscanX: stepOverscanRatio(activePrefs.overscanX, delta) });
            } else {
              applyPatch({ overscanY: stepOverscanRatio(activePrefs.overscanY, delta) });
            }
          }}
          onSelectTvClockMode={(tvClockMode) => applyPatch({ tvClockMode })}
          onLayoutBox={(box) => {
            layoutsRef.current.tvDisplay = box;
          }}
        />
      ) : null}

      {/* 6. Artwork Cache */}
      <Surface
        testID="settings-section-artwork-cache"
        tone="surface"
        bordered
        rounded="modal"
        style={[
          styles.sectionCard,
          openPopover === 'cache' || openTvDropdownId === 'artwork-cache-dropdown'
            ? styles.elevatedCard
            : undefined,
        ]}
        onLayout={(e) => {
          layoutsRef.current.artworkCache = {
            y: e.nativeEvent.layout.y,
            height: e.nativeEvent.layout.height,
          };
        }}
      >
        <SettingsDropdownRow
          testID="settings-artwork-cache-dropdown"
          title={i18n.t('settings.artworkCache')}
          options={artworkCacheOptions}
          selectedValue={activePrefs.artworkCacheLimitMb}
          focused={focusedControlId === 'artwork-cache-dropdown'}
          isTv={isTv}
          tabularNums
          open={
            isTv && onOpenTvDropdownChange !== undefined
              ? openTvDropdownId === 'artwork-cache-dropdown'
              : openPopover === 'cache'
          }
          onOpenChange={(next) => {
            if (isTv && onOpenTvDropdownChange !== undefined) {
              onOpenTvDropdownChange(next ? 'artwork-cache-dropdown' : null);
            } else {
              setOpenPopover((prev) => (next ? 'cache' : prev === 'cache' ? null : prev));
            }
          }}
          onSelect={handleSelectArtworkCacheLimit}
        />

        <SettingsDivider />

        <View style={styles.cacheActionRow}>
          <CtaButton
            testID="settings-artwork-cache-clear"
            variant="secondary"
            label={i18n.t('settings.artworkCacheClear')}
            focused={focusedControlId === 'artwork-cache-clear'}
            focusable={!isTv}
            onPress={handleClearArtworkCache}
          />
          {cacheUsedMb !== null ? (
            <Text
              testID="settings-artwork-cache-usage"
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textSecondary },
              ]}
            >
              {i18n.t('settings.artworkCacheUsage', {
                usedMb: cacheUsedMb,
                limitMb: activePrefs.artworkCacheLimitMb,
              })}
            </Text>
          ) : null}
          {showClearedMessage ? (
            <Text
              testID="settings-artwork-cache-cleared"
              accessibilityLiveRegion="polite"
              style={[theme.typography.caption, { color: theme.colors.successColor }]}
            >
              {i18n.t('settings.artworkCacheCleared')}
            </Text>
          ) : null}
        </View>
      </Surface>

      {/* 7. Unified Diagnostics & Performance Telemetry (directly above Reset) */}
      <DiagnosticsSettingsCard
        diagnosticsEnabled={activePrefs.telemetryOptIn || activePrefs.crashReportsOptIn}
        focusedControlId={focusedControlId}
        isTv={isTv}
        onToggleDiagnostics={() => {
          const next = !(activePrefs.telemetryOptIn || activePrefs.crashReportsOptIn);
          onTelemetryOptInChange?.(next);
          applyPatch({
            telemetryOptIn: next,
            crashReportsOptIn: next,
            privacyConsentAnswered: true,
          });
        }}
        onLayoutBox={(box) => {
          layoutsRef.current.diagnostics = box;
        }}
      />

      {/* 8. Reset Appearance (very bottom) */}
      <View
        testID="settings-section-reset"
        style={styles.footerRow}
        onLayout={(e) => {
          layoutsRef.current.reset = {
            y: e.nativeEvent.layout.y,
            height: e.nativeEvent.layout.height,
          };
        }}
      >
        <CtaButton
          testID="settings-reset-preferences"
          variant="secondary"
          label={i18n.t('settings.reset')}
          focused={focusedControlId === 'reset-preferences'}
          focusable={!isTv}
          onPress={handleReset}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  sectionCard: { padding: 18, gap: 14 },
  elevatedCard: { zIndex: 40 },
  blockHeader: { gap: 4 },
  rowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 200, gap: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  cacheActionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  footerRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 4 },
});
