import { DEFAULT_PREFERENCES, type PreferencesPatch, type PreferencesSnapshot } from '@elv/domain';
import {
  CtaButton,
  FilterChip,
  Surface,
  THEME_PRESETS,
  type ThemePresetId,
  useI18n,
  useTheme,
  useThemeController,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  computeAppearanceScrollY,
  FONT_SCALE_OPTIONS,
  LANGUAGE_OPTIONS,
  type SettingsPreferencesController,
} from './appearance-controls';
import { ThemePresetGrid } from './ThemePresetGrid';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

export {
  activateAppearanceControl,
  type SettingsPreferencesController,
} from './appearance-controls';

/** Props of {@link AppearancePanel}. */
export interface AppearancePanelProps {
  /** Reactive preferences controller (supplied by `AppShell` via `usePreferences()`). */
  readonly preferences?: SettingsPreferencesController;
  /** Currently focused Appearance control on 10-foot TV D-pad navigation. */
  readonly focusedControlId?: AppearanceFocusId | null;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;
type SectionLayout = { readonly y: number; readonly height: number };

/**
 * Cinema Quietude Appearance & Accessibility settings panel:
 * live in-app Language switcher (`#16`), 6 dynamic Theme Presets including WCAG AAA High Contrast
 * (`#325`), Text Size scaling (`90%–120%`, `#62`), Reduce Motion toggle (`#325`), and Reset.
 */
export function AppearancePanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
}: AppearancePanelProps): ReactElement {
  const theme = useTheme();
  const themeCtrl = useThemeController();
  const i18n = useI18n();
  const viewport = useViewport();
  const [hoveredToggle, setHoveredToggle] = useState(false);

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const layoutsRef = useRef<Partial<Record<'theme' | 'font' | 'reset', SectionLayout>>>({});
  const motionOffsetYRef = useRef(0);

  const isTv = viewport.formFactor === 'tv';
  const activePrefs: PreferencesSnapshot = suppliedPrefs?.preferences ?? {
    version: DEFAULT_PREFERENCES.version,
    themePreset: theme.preset === 'custom' ? DEFAULT_PREFERENCES.themePreset : theme.preset,
    locale: i18n.locale,
    fontScale: theme.fontScale,
    reduceMotion: theme.reduceMotion,
  };

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

  const handleReset = useCallback(() => {
    if (suppliedPrefs) {
      void suppliedPrefs.resetPreferences();
      return;
    }
    themeCtrl.setPreset('obsidianCrimson');
    themeCtrl.setFontScale(1);
    themeCtrl.setReduceMotion(false);
  }, [suppliedPrefs, themeCtrl]);

  const cardTransition = webTransition(theme, 'transform, background-color, border-color');
  const cursorPointer = webCursorPointer();
  const toggleFocused = focusedControlId === 'toggle-reduce-motion';

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

        <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

        <Pressable
          testID="settings-toggle-reduce-motion"
          accessibilityRole="switch"
          accessibilityLabel={i18n.t('settings.reduceMotion.label')}
          accessibilityState={{ checked: activePrefs.reduceMotion }}
          aria-checked={activePrefs.reduceMotion}
          {...(isTv ? { focusable: false } : {})}
          onLayout={(e) => {
            motionOffsetYRef.current = e.nativeEvent.layout.y;
          }}
          onPress={() => applyPatch({ reduceMotion: !activePrefs.reduceMotion })}
          onHoverIn={() => setHoveredToggle(true)}
          onHoverOut={() => setHoveredToggle(false)}
          style={[
            styles.toggleRow,
            cardTransition,
            cursorPointer,
            {
              borderRadius: theme.radius.card,
              backgroundColor: toggleFocused
                ? theme.colors.focusFill
                : hoveredToggle
                  ? theme.colors.subtleHighlight
                  : 'transparent',
              borderWidth: toggleFocused ? theme.focus.ringWidth : 1,
              borderColor: toggleFocused ? theme.colors.focusRingColor : 'transparent',
            },
          ]}
        >
          <View style={styles.rowText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('settings.reduceMotion.label')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('settings.reduceMotion.description')}
            </Text>
          </View>

          <View
            style={[
              styles.switchTrack,
              cardTransition,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: activePrefs.reduceMotion
                  ? theme.colors.accent
                  : theme.colors.bgCard,
                borderColor: activePrefs.reduceMotion
                  ? theme.colors.accent
                  : theme.colors.chipBorder,
              },
            ]}
          >
            <View
              style={[
                styles.switchThumb,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: activePrefs.reduceMotion
                    ? theme.colors.accentContrast
                    : theme.colors.textPrimary,
                  alignSelf: activePrefs.reduceMotion ? 'flex-end' : 'flex-start',
                },
              ]}
            />
          </View>
        </Pressable>
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
  divider: { height: 1, width: '100%' },
  toggleRow: {
    minHeight: 48,
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginHorizontal: -8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  switchTrack: { width: 38, height: 22, borderWidth: 1, padding: 2, justifyContent: 'center' },
  switchThumb: { width: 16, height: 16 },
  footerRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 4 },
});
