import {
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
  useRef,
  useState,
} from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ARTWORK_CACHE_OPTIONS,
  computeAppearanceScrollY,
  FONT_SCALE_OPTIONS,
  LANGUAGE_OPTIONS,
  type SettingsPreferencesController,
} from './appearance-controls';
import { SettingsDivider, SettingsToggleRow } from './SettingsRowParts';
import { ThemePresetGrid } from './ThemePresetGrid';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

export {
  activateAppearanceControl,
  type SettingsPreferencesController,
} from './appearance-controls';

const CLEAR_FEEDBACK_MS = 3_000;

/** Props of {@link AppearancePanel}. */
export interface AppearancePanelProps {
  /** Reactive preferences controller (supplied by `AppShell` via `usePreferences()`). */
  readonly preferences?: SettingsPreferencesController;
  /** Currently focused Appearance control on 10-foot TV D-pad navigation. */
  readonly focusedControlId?: AppearanceFocusId | null;
  /** Optional external clear handler shared with TV D-pad activation in `SettingsScreen`. */
  readonly onClearArtworkCache?: () => void;
  /** Optional controlled cleared-confirmation flag owned by `SettingsScreen`. */
  readonly artworkCacheCleared?: boolean;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;
type SectionLayout = { readonly y: number; readonly height: number };

/**
 * Cinema Quietude Appearance, Accessibility & Artwork Cache settings panel:
 * live in-app Language switcher (`#16`), 6 dynamic Theme Presets including WCAG AAA High Contrast
 * (`#325`), Text Size scaling (`90%–120%`, `#62`), Reduce Motion toggle (`#325`), bounded Artwork
 * Cache budget & clear (`#405`), and Reset.
 */
export function AppearancePanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
  onClearArtworkCache,
  artworkCacheCleared: controlledCleared,
}: AppearancePanelProps): ReactElement {
  const theme = useTheme();
  const themeCtrl = useThemeController();
  const i18n = useI18n();
  const viewport = useViewport();
  const adapters = useUiAdapters();
  const [localCleared, setLocalCleared] = useState(false);

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutsRef = useRef<
    Partial<Record<'theme' | 'font' | 'artworkCache' | 'reset', SectionLayout>>
  >({});
  const motionOffsetYRef = useRef(0);

  const isTv = viewport.formFactor === 'tv';
  const activePrefs: PreferencesSnapshot = suppliedPrefs?.preferences ?? {
    ...DEFAULT_PREFERENCES,
    themePreset: theme.preset === 'custom' ? DEFAULT_PREFERENCES.themePreset : theme.preset,
    locale: i18n.locale,
    fontScale: theme.fontScale,
    reduceMotion: theme.reduceMotion,
  };

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    };
  }, []);

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
      if (patch.locale === 'tr' || patch.locale === 'en') i18n.setLocale(patch.locale);
    },
    [i18n, suppliedPrefs, themeCtrl],
  );

  const handleSelectArtworkCacheLimit = useCallback(
    (mb: ArtworkCacheLimitMbPref) => {
      applyPatch({ artworkCacheLimitMb: mb });
      const setLimitBytes = adapters.artworkCache?.setLimitBytes;
      if (setLimitBytes !== undefined) {
        void Promise.resolve(setLimitBytes(mb * 1024 * 1024)).catch(() => undefined);
      }
    },
    [adapters.artworkCache, applyPatch],
  );

  const handleClearArtworkCache = useCallback(() => {
    if (onClearArtworkCache) {
      onClearArtworkCache();
      return;
    }
    defaultLoadedArtworkUris.clear();
    void Promise.resolve(adapters.artworkCache?.clear()).catch(() => undefined);
    setLocalCleared(true);
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setLocalCleared(false);
    }, CLEAR_FEEDBACK_MS);
  }, [adapters.artworkCache, onClearArtworkCache]);

  const handleReset = useCallback(() => {
    if (suppliedPrefs) {
      void suppliedPrefs.resetPreferences();
      return;
    }
    themeCtrl.setPreset('obsidianCrimson');
    themeCtrl.setFontScale(1);
    themeCtrl.setReduceMotion(false);
  }, [suppliedPrefs, themeCtrl]);

  const showClearedMessage = controlledCleared ?? localCleared;

  return (
    <ScrollView
      ref={scrollRef}
      testID="settings-panel-appearance"
      {...(isTv ? { focusable: false } : {})}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
    >
      <Surface tone="surface" bordered rounded="modal" style={styles.sectionCard}>
        <View style={styles.rowHeader}>
          <View style={styles.rowText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('settings.language.label')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('settings.language.description')}
            </Text>
          </View>
          <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
            {LANGUAGE_OPTIONS.map((opt) => (
              <FilterChip
                key={opt.id}
                testID={opt.testID}
                label={i18n.t(opt.labelKey)}
                selected={activePrefs.locale === opt.id}
                focused={focusedControlId === opt.focusId}
                focusable={!isTv}
                onPress={() => applyPatch({ locale: opt.id })}
              />
            ))}
          </View>
        </View>
      </Surface>

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
      </Surface>

      <Surface
        testID="settings-section-artwork-cache"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          layoutsRef.current.artworkCache = {
            y: e.nativeEvent.layout.y,
            height: e.nativeEvent.layout.height,
          };
        }}
      >
        <View style={styles.rowHeader}>
          <View style={styles.rowText}>
            <Text
              style={[
                theme.typography.title,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textPrimary },
              ]}
            >
              {i18n.t('settings.artworkCache')}
            </Text>
          </View>
          <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
            {ARTWORK_CACHE_OPTIONS.map((opt) => (
              <FilterChip
                key={opt.testID}
                testID={opt.testID}
                label={i18n.t('settings.artworkCacheLimitMb', { mb: opt.mb })}
                selected={activePrefs.artworkCacheLimitMb === opt.mb}
                focused={focusedControlId === opt.focusId}
                focusable={!isTv}
                onPress={() => handleSelectArtworkCacheLimit(opt.mb)}
              />
            ))}
          </View>
        </View>

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
