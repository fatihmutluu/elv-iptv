import type { KeyEvent } from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import {
  FilterChip,
  Icon,
  type IconName,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useThemeController,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AboutLicensesPanel } from './AboutLicensesPanel';
import {
  AppearancePanel,
  activateAppearanceControl,
  type SettingsPreferencesController,
} from './AppearancePanel';
import {
  type AppearanceFocusId,
  SETTINGS_SECTIONS,
  type SettingsSection,
  useTvSettingsNavigation,
} from './useTvSettingsNavigation';

function SettingsTvKeyBridge({ onEvent }: { onEvent: (event: KeyEvent) => void }): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="settings-tv-focus-anchor" />;
}

/** Slot props supplied to embedded Sources and Third-Party Notices views inside {@link SettingsScreen}. */
export interface SettingsPaneSlotProps {
  /** Whether the embedded view currently owns 10-foot TV remote focus. */
  readonly isActiveScope: boolean;
  /** Returns TV focus from the embedded view back to the Settings category sidebar. */
  readonly onBack: () => void;
  /** Routes TV focus directly to the top navigation bar (e.g. D-pad Up at top edge). */
  readonly onFocusTopNav?: () => void;
}

/** Props of {@link SettingsScreen}. */
export interface SettingsScreenProps {
  /** Controlled active Settings section (`'appearance' | 'sources' | 'licenses'`). */
  readonly section?: SettingsSection;
  /** Initial Settings section when uncontrolled (defaults to `'appearance'`). */
  readonly initialSection?: SettingsSection;
  /** Invoked whenever the user switches Settings sections. */
  readonly onSectionChange?: (section: SettingsSection) => void;
  /** Reactive preferences controller wired by `AppShell` from `usePreferences()`. */
  readonly preferences?: SettingsPreferencesController;
  /** Slot rendering the embedded `SourcesScreen` inside the Sources section. */
  readonly renderSources?: (slot: SettingsPaneSlotProps) => ReactElement;
  /** Slot rendering the embedded `ThirdPartyNoticesScreen` inside the About & Licenses section. */
  readonly renderLicenses?: (slot: SettingsPaneSlotProps) => ReactElement;
  /** Invoked when TV D-pad Up at top edge or Back from the sidebar returns focus to Top Nav. */
  readonly onFocusTopNav?: () => void;
  /** Whether Settings currently owns TV remote focus (`false` while Top Nav owns focus). */
  readonly isActiveScope?: boolean;
}

interface NavSectionMeta {
  readonly id: SettingsSection;
  readonly icon: IconName;
  readonly labelKey: MessageId;
  readonly testID: string;
}

const SECTION_META: readonly NavSectionMeta[] = [
  {
    id: 'appearance',
    icon: 'layers',
    labelKey: 'settings.section.appearance',
    testID: 'settings-tab-appearance',
  },
  {
    id: 'sources',
    icon: 'sources',
    labelKey: 'settings.section.sources',
    testID: 'settings-tab-sources',
  },
  {
    id: 'licenses',
    icon: 'info',
    labelKey: 'settings.section.licenses',
    testID: 'settings-tab-licenses',
  },
];

/**
 * Cinema Quietude categorized Settings hub (`UI_UX_PHILOSOPHY.md` §2.2 & §3).
 *
 * - **Landscape (`TV`, `Desktop`, `Tablet-L`, `Phone-L`):** Centered `maxWidth: 1120` 2-column
 *   shell (`220px` left category sidebar + `flex: 1` right detail pane without an outer ScrollView).
 * - **Portrait (`Phone-P`, `Tablet-P`):** Horizontal scrollable `FilterChip` tab strip (`>= 40px`
 *   touch targets) above a `flex: 1` detail pane.
 * - **10-Foot TV D-Pad:** Uses `@elv/focus-core` for sidebar + Appearance controls and cleanly
 *   delegates `isActiveScope` to embedded Sources and Licenses views.
 */
export function SettingsScreen({
  section: controlledSection,
  initialSection = 'appearance',
  onSectionChange,
  preferences,
  renderSources,
  renderLicenses,
  onFocusTopNav,
  isActiveScope = true,
}: SettingsScreenProps): ReactElement {
  const theme = useTheme();
  const themeCtrl = useThemeController();
  const i18n = useI18n();
  const viewport = useViewport();

  const [uncontrolledSection, setUncontrolledSection] = useState<SettingsSection>(initialSection);
  const [hoveredSection, setHoveredSection] = useState<SettingsSection | null>(null);

  const activeSection = controlledSection ?? uncontrolledSection;
  const isTv = viewport.formFactor === 'tv';
  const isLandscape =
    viewport.orientation === 'landscape' ||
    viewport.formFactor === 'tv' ||
    viewport.formFactor === 'desktop';

  const handleSelectSection = useCallback(
    (next: SettingsSection) => {
      if (controlledSection === undefined) setUncontrolledSection(next);
      onSectionChange?.(next);
    },
    [controlledSection, onSectionChange],
  );

  const handleActivateAppearanceControl = useCallback(
    (controlId: AppearanceFocusId) => {
      activateAppearanceControl(controlId, {
        ...(preferences !== undefined ? { preferences } : {}),
        reduceMotion: theme.reduceMotion,
        setPreset: themeCtrl.setPreset,
        setFontScale: themeCtrl.setFontScale,
        setReduceMotion: themeCtrl.setReduceMotion,
        setLocale: (loc) => i18n.setLocale(loc),
      });
    },
    [i18n, preferences, theme.reduceMotion, themeCtrl],
  );

  const tv = useTvSettingsNavigation({
    isTv,
    isActiveScope,
    section: activeSection,
    onSectionChange: handleSelectSection,
    onActivateAppearanceControl: handleActivateAppearanceControl,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const embeddedSlot = useMemo<SettingsPaneSlotProps>(
    () => ({
      isActiveScope: isActiveScope && (!isTv || tv.pane === 'content'),
      onBack: tv.returnToSidebar,
      ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
    }),
    [isActiveScope, isTv, onFocusTopNav, tv.pane, tv.returnToSidebar],
  );

  const horizontalPadding = isTv
    ? Math.max(theme.spacing.xl, viewport.overscan.x)
    : isLandscape
      ? theme.spacing.lg
      : theme.spacing.md;
  const bottomPadding = isTv ? Math.max(theme.spacing.md, viewport.overscan.y) : theme.spacing.md;
  const itemTransition = webTransition(theme, 'color, background-color, border-color');
  const cursorPointer = webCursorPointer();

  const detailContent =
    activeSection === 'appearance' ? (
      <AppearancePanel
        {...(preferences !== undefined ? { preferences } : {})}
        focusedControlId={tv.focusedAppearanceId}
      />
    ) : activeSection === 'sources' ? (
      renderSources ? (
        renderSources(embeddedSlot)
      ) : null
    ) : (
      <AboutLicensesPanel>
        {renderLicenses ? renderLicenses(embeddedSlot) : null}
      </AboutLicensesPanel>
    );

  return (
    <View
      testID="settings-screen"
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.bgCanvas,
          paddingHorizontal: horizontalPadding,
          paddingTop: isLandscape ? theme.spacing.lg : theme.spacing.md,
          paddingBottom: bottomPadding,
        },
      ]}
    >
      {tv.ownsTvRemote ? <SettingsTvKeyBridge onEvent={tv.handleTvKey} /> : null}

      <View style={[styles.shell, { gap: isLandscape ? theme.spacing.lg : theme.spacing.md }]}>
        <View style={styles.header}>
          <Text style={[theme.typography.h1, { color: theme.colors.textPrimary }]}>
            {i18n.t('settings.title')}
          </Text>
          <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
            {i18n.t('settings.subtitle')}
          </Text>
        </View>

        {isLandscape ? (
          <View style={[styles.landscapeBody, { gap: theme.spacing.lg }]}>
            <View
              testID="settings-sidebar"
              accessibilityRole="tablist"
              style={[styles.sidebar, { gap: theme.spacing.xxs }]}
            >
              {SECTION_META.map((item) => {
                const selected = activeSection === item.id;
                const tvFocused = tv.focusedSection === item.id;
                const hovered = hoveredSection === item.id;
                const fgColor =
                  selected || hovered || tvFocused
                    ? theme.colors.textPrimary
                    : theme.colors.textSecondary;
                const bgColor = tvFocused
                  ? theme.colors.focusFill
                  : selected || hovered
                    ? theme.colors.subtleHighlight
                    : 'transparent';

                return (
                  <Pressable
                    key={item.id}
                    testID={item.testID}
                    accessibilityRole="tab"
                    accessibilityLabel={i18n.t(item.labelKey)}
                    accessibilityState={{ selected }}
                    aria-selected={selected}
                    {...(isTv ? { focusable: false } : {})}
                    onHoverIn={() => setHoveredSection(item.id)}
                    onHoverOut={() => setHoveredSection((prev) => (prev === item.id ? null : prev))}
                    onPress={() => handleSelectSection(item.id)}
                    style={[
                      styles.sidebarItem,
                      itemTransition,
                      cursorPointer,
                      {
                        borderRadius: theme.radius.button,
                        backgroundColor: bgColor,
                        borderWidth: isTv ? theme.focus.ringWidth : 0,
                        borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
                      },
                    ]}
                  >
                    {selected ? (
                      <View
                        testID={`${item.testID}-accent`}
                        style={[styles.sidebarAccentBar, { backgroundColor: theme.colors.accent }]}
                      />
                    ) : null}
                    <Icon
                      name={item.icon}
                      size={18}
                      color={selected ? theme.colors.accent : fgColor}
                    />
                    <Text
                      numberOfLines={1}
                      style={[
                        theme.typography.title,
                        styles.sidebarLabel,
                        { color: fgColor, fontWeight: selected ? '700' : '500' },
                      ]}
                    >
                      {i18n.t(item.labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.detailPane}>{detailContent}</View>
          </View>
        ) : (
          <View style={[styles.portraitBody, { gap: theme.spacing.md }]}>
            <ScrollView
              testID="settings-portrait-tabs"
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.portraitTabsScroll}
              contentContainerStyle={[styles.portraitTabsContent, { gap: theme.spacing.xs }]}
            >
              {SETTINGS_SECTIONS.map((id) => {
                const meta = SECTION_META.find((m) => m.id === id);
                if (!meta) return null;
                return (
                  <FilterChip
                    key={meta.id}
                    testID={meta.testID}
                    label={i18n.t(meta.labelKey)}
                    selected={activeSection === meta.id}
                    onPress={() => handleSelectSection(meta.id)}
                  />
                );
              })}
            </ScrollView>

            <View style={styles.detailPane}>{detailContent}</View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  shell: { flex: 1, width: '100%', maxWidth: 1120, alignSelf: 'center', minHeight: 0 },
  header: { gap: 4 },
  landscapeBody: { flex: 1, flexDirection: 'row', minHeight: 0 },
  sidebar: { width: 220, flexShrink: 0 },
  sidebarItem: {
    position: 'relative',
    minHeight: 44,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sidebarAccentBar: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 2.5,
    borderRadius: 2,
  },
  sidebarLabel: { flex: 1 },
  portraitBody: { flex: 1, minHeight: 0 },
  portraitTabsScroll: { flexGrow: 0, flexShrink: 0 },
  portraitTabsContent: { alignItems: 'center', paddingVertical: 2 },
  detailPane: { flex: 1, minWidth: 0, minHeight: 0 },
});
