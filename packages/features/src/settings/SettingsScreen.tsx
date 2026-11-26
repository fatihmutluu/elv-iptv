import {
  type ArtworkCacheLimitMbPref,
  isRefreshRateBucket,
  type RefreshRateBucket,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import {
  defaultLoadedArtworkUris,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  Icon,
  type IconName,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useThemeController,
  useUiAdapters,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouteActive } from '../shared';
import { AboutLicensesPanel } from './AboutLicensesPanel';
import {
  AppearancePanel,
  activateAppearanceControl,
  adjustAppearanceControl,
  type SettingsPreferencesController,
} from './AppearancePanel';
import { LiveTvSettingsPanel } from './LiveTvSettingsPanel';
import { activateLiveTvControl } from './live-tv-controls';
import { PlaybackSettingsPanel } from './PlaybackSettingsPanel';
import { activatePlaybackControl, adjustPlaybackControl } from './playback-controls';
import { RemoteKeysSettingsPanel } from './RemoteKeysSettingsPanel';
import {
  type AppearanceFocusId,
  type LiveTvFocusId,
  type PlaybackFocusId,
  type PreferenceSettingsSection,
  SETTINGS_SECTIONS,
  type SettingsSection,
  useTvSettingsNavigation,
} from './useTvSettingsNavigation';

const CLEAR_FEEDBACK_MS = 3_000;

function SettingsTvKeyBridge({
  onEvent,
}: {
  onEvent: Parameters<typeof useKeyInterpreter>[0];
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="settings-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
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
  /** Controlled active Settings section (`'appearance' | 'playback' | 'liveTv' | 'sources' | 'licenses'`). */
  readonly section?: SettingsSection;
  /** Initial Settings section when uncontrolled (defaults to `'appearance'`). */
  readonly initialSection?: SettingsSection;
  /** Invoked whenever the user switches Settings sections. */
  readonly onSectionChange?: (section: SettingsSection) => void;
  /** Reactive preferences controller wired by `AppShell` from `usePreferences()`. */
  readonly preferences?: SettingsPreferencesController;
  /** Slot rendering the embedded `ProfilesAndParentalPanel` inside the Profiles & Parental section (`#15`, `#31`). */
  readonly renderProfiles?: (slot: SettingsPaneSlotProps) => ReactElement;
  /** Slot rendering the embedded `SourcesScreen` inside the Sources section. */
  readonly renderSources?: (slot: SettingsPaneSlotProps) => ReactElement;
  /** Slot rendering the embedded `AccountSettingsPanel` inside the Account & Sync section (`#26`). */
  readonly renderAccount?: (slot: SettingsPaneSlotProps) => ReactElement;
  /** Slot rendering the embedded `FeedbackSettingsPanel` inside the Feedback & Telemetry section (`#458`). */
  readonly renderFeedback?: (slot: SettingsPaneSlotProps) => ReactElement;
  /** Slot rendering the embedded `ThirdPartyNoticesScreen` inside the About & Licenses section. */
  readonly renderLicenses?: (slot: SettingsPaneSlotProps) => ReactElement;
  /** Invoked when TV D-pad Up at top edge or Back from the sidebar returns focus to Top Nav. */
  readonly onFocusTopNav?: () => void;
  /** Whether Settings currently owns TV remote focus (`false` while Top Nav owns focus). */
  readonly isActiveScope?: boolean;
  /** Whether a transient root overlay (e.g. PIN entry or Profile picker) temporarily stole focus; preserves Settings pane. */
  readonly hasTransientOverlay?: boolean;
  /** Overrides Android-only Video decoder row visibility in Playback settings (`#411`). */
  readonly showAndroidDecoder?: boolean;
  /** Overrides Android-only Night-Mode DRC row visibility in Playback settings (`#115`). */
  readonly showNightModeDrc?: boolean;
  /** Overrides mobile External Player row visibility in Playback settings (`#406`). */
  readonly showExternalPlayer?: boolean;
  /** Opens the opt-in redacted diagnostic report preview modal (`#226`). */
  readonly onPreviewDiagnostics?: () => void;
  /** Opens the Channel Management & Custom Groups overlay from Live TV settings (`#60`). */
  readonly onOpenChannelManagement?: () => void;
  /** Opens the Multi-Guide & Channel Mapper overlay lifted to `AppShell` root (`#30`). */
  readonly onOpenGuideManagement?: (sourceId: string) => void;
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
    id: 'playback',
    icon: 'play',
    labelKey: 'settings.section.playback',
    testID: 'settings-tab-playback',
  },
  {
    id: 'liveTv',
    icon: 'tv',
    labelKey: 'settings.section.liveTv',
    testID: 'settings-tab-liveTv',
  },
  {
    id: 'remote',
    icon: 'keypad',
    labelKey: 'settings.section.remote',
    testID: 'settings-tab-remote',
  },
  {
    id: 'profiles',
    icon: 'profile',
    labelKey: 'settings.section.profiles',
    testID: 'settings-tab-profiles',
  },
  {
    id: 'sources',
    icon: 'sources',
    labelKey: 'settings.section.sources',
    testID: 'settings-tab-sources',
  },
  {
    id: 'account',
    icon: 'refresh',
    labelKey: 'settings.section.account',
    testID: 'settings-tab-account',
  },
  {
    id: 'feedback',
    icon: 'like',
    labelKey: 'settings.section.feedback',
    testID: 'settings-tab-feedback',
  },
  {
    id: 'licenses',
    icon: 'info',
    labelKey: 'settings.section.licenses',
    testID: 'settings-tab-licenses',
  },
];

/**
 * Cinema Quietude categorized Settings hub (`UI_UX_PHILOSOPHY.md` §2.2 & §3):
 * `Appearance`, `Playback`, `Live TV & Guide`, `Sources`, and `About & Licenses`.
 *
 * - **Landscape (`TV`, `Desktop`, `Tablet-L`, `Phone-L`):** Centered `maxWidth: 1120` 2-column
 *   shell (`220px` left category sidebar + `flex: 1` right detail pane without an outer ScrollView).
 * - **Portrait (`Phone-P`, `Tablet-P`):** Horizontal scrollable `EditorialCategoryBar` tab strip
 *   (`>= 40px` touch targets) above a `flex: 1` detail pane.
 * - **10-Foot TV D-Pad:** Uses `@elv/focus-core` across sidebar + all 3 preference panels
 *   (`appearance`, `playback`, `liveTv`) and cleanly delegates `isActiveScope` to embedded Sources
 *   and Licenses views.
 */
export function SettingsScreen({
  section: controlledSection,
  initialSection = 'appearance',
  onSectionChange,
  preferences,
  renderProfiles,
  renderSources,
  renderAccount,
  renderFeedback,
  renderLicenses,
  onFocusTopNav,
  isActiveScope = true,
  hasTransientOverlay = false,
  showAndroidDecoder = Platform.OS === 'android',
  showNightModeDrc = Platform.OS === 'android',
  showExternalPlayer = Platform.OS === 'android' || (Platform.OS === 'ios' && !Platform.isTV),
  onPreviewDiagnostics,
  onOpenChannelManagement,
}: SettingsScreenProps): ReactElement {
  const theme = useTheme();
  const themeCtrl = useThemeController();
  const i18n = useI18n();
  const viewport = useViewport();
  const adapters = useUiAdapters();

  const [uncontrolledSection, setUncontrolledSection] = useState<SettingsSection>(initialSection);
  const [hoveredSection, setHoveredSection] = useState<SettingsSection | null>(null);
  const [artworkCacheCleared, setArtworkCacheCleared] = useState(false);
  const [selectedDelayBucket, setSelectedDelayBucket] = useState<RefreshRateBucket>('23.976');
  const selectedDelayBucketRef = useRef<RefreshRateBucket>(selectedDelayBucket);
  selectedDelayBucketRef.current = selectedDelayBucket;
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    };
  }, []);

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

  const portraitTabItems = useMemo<readonly EditorialCategoryItem[]>(
    () =>
      SETTINGS_SECTIONS.flatMap((id) => {
        const meta = SECTION_META.find((m) => m.id === id);
        return meta ? [{ id: meta.id, label: i18n.t(meta.labelKey), testID: meta.testID }] : [];
      }),
    [i18n],
  );

  const handleSelectSectionId = useCallback(
    (id: string) => {
      handleSelectSection(id as SettingsSection);
    },
    [handleSelectSection],
  );

  const handleSetArtworkCacheLimitMb = useCallback(
    (mb: ArtworkCacheLimitMbPref) => {
      const setLimitBytes = adapters.artworkCache?.setLimitBytes;
      if (setLimitBytes !== undefined) {
        void Promise.resolve(setLimitBytes(mb * 1024 * 1024)).catch(() => undefined);
      }
    },
    [adapters.artworkCache],
  );

  const handleClearArtworkCache = useCallback(() => {
    defaultLoadedArtworkUris.clear();
    void Promise.resolve(adapters.artworkCache?.clear()).catch(() => undefined);
    setArtworkCacheCleared(true);
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setArtworkCacheCleared(false);
    }, CLEAR_FEEDBACK_MS);
  }, [adapters.artworkCache]);

  const handleActivateControl = useCallback(
    (sec: PreferenceSettingsSection, controlId: string) => {
      if (sec === 'appearance') {
        activateAppearanceControl(controlId as AppearanceFocusId, {
          ...(preferences !== undefined ? { preferences } : {}),
          reduceMotion: theme.reduceMotion,
          setPreset: themeCtrl.setPreset,
          setFontScale: themeCtrl.setFontScale,
          setReduceMotion: themeCtrl.setReduceMotion,
          setUiFontFamily: themeCtrl.setUiFontFamily,
          setLocale: (loc) => i18n.setLocale(loc),
          onSetArtworkCacheLimitMb: handleSetArtworkCacheLimitMb,
          onClearArtworkCache: handleClearArtworkCache,
          ...(onPreviewDiagnostics !== undefined ? { onPreviewDiagnostics } : {}),
        });
        return;
      }
      if (sec === 'playback') {
        activatePlaybackControl(controlId as PlaybackFocusId, preferences, {
          selectedDelayBucket: selectedDelayBucketRef.current,
          onSelectDelayBucket: setSelectedDelayBucket,
        });
        return;
      }
      activateLiveTvControl(controlId as LiveTvFocusId, preferences, onOpenChannelManagement);
    },
    [
      handleClearArtworkCache,
      handleSetArtworkCacheLimitMb,
      i18n,
      onOpenChannelManagement,
      onPreviewDiagnostics,
      preferences,
      theme.reduceMotion,
      themeCtrl,
    ],
  );

  const handleAdjustControl = useCallback(
    (sec: PreferenceSettingsSection, controlId: string, delta: -1 | 1) => {
      if (sec === 'appearance') {
        adjustAppearanceControl(controlId as AppearanceFocusId, delta, preferences);
        return;
      }
      if (sec === 'playback') {
        adjustPlaybackControl(
          controlId as PlaybackFocusId,
          delta,
          preferences,
          selectedDelayBucketRef.current,
        );
      }
    },
    [preferences],
  );

  const tv = useTvSettingsNavigation({
    isTv,
    isActiveScope,
    section: activeSection,
    onSectionChange: handleSelectSection,
    onActivateControl: handleActivateControl,
    onAdjustControl: handleAdjustControl,
    showAndroidDecoder,
    showNightModeDrc,
    showExternalPlayer,
    preservePaneOnBlur: hasTransientOverlay,
    ...(preferences !== undefined ? { homeLayout: preferences.preferences.homeLayout } : {}),
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  useEffect(() => {
    if (activeSection !== 'playback' || tv.focusedControlId === null) return;
    if (tv.focusedControlId.startsWith('delay-bucket-')) {
      const bucket = tv.focusedControlId.slice('delay-bucket-'.length);
      if (isRefreshRateBucket(bucket)) {
        setSelectedDelayBucket(bucket);
      }
    }
  }, [activeSection, tv.focusedControlId]);

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
        onClearArtworkCache={handleClearArtworkCache}
        artworkCacheCleared={artworkCacheCleared}
        {...(onPreviewDiagnostics !== undefined ? { onPreviewDiagnostics } : {})}
      />
    ) : activeSection === 'playback' ? (
      <PlaybackSettingsPanel
        {...(preferences !== undefined ? { preferences } : {})}
        focusedControlId={
          activeSection === 'playback' ? (tv.focusedControlId as PlaybackFocusId | null) : null
        }
        showAndroidDecoder={showAndroidDecoder}
        showNightModeDrc={showNightModeDrc}
        showExternalPlayer={showExternalPlayer}
        selectedDelayBucket={selectedDelayBucket}
        onSelectDelayBucket={setSelectedDelayBucket}
      />
    ) : activeSection === 'liveTv' ? (
      <LiveTvSettingsPanel
        {...(preferences !== undefined ? { preferences } : {})}
        focusedControlId={
          activeSection === 'liveTv' ? (tv.focusedControlId as LiveTvFocusId | null) : null
        }
        {...(onOpenChannelManagement !== undefined ? { onOpenChannelManagement } : {})}
      />
    ) : activeSection === 'remote' ? (
      <RemoteKeysSettingsPanel {...embeddedSlot} />
    ) : activeSection === 'profiles' ? (
      renderProfiles ? (
        renderProfiles(embeddedSlot)
      ) : null
    ) : activeSection === 'sources' ? (
      renderSources ? (
        renderSources(embeddedSlot)
      ) : null
    ) : activeSection === 'account' ? (
      renderAccount ? (
        renderAccount(embeddedSlot)
      ) : null
    ) : activeSection === 'feedback' ? (
      renderFeedback ? (
        renderFeedback(embeddedSlot)
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
            <EditorialCategoryBar
              testID="settings-portrait-tabs"
              items={portraitTabItems}
              activeId={activeSection}
              onSelect={handleSelectSectionId}
              isTv={false}
              padX={0}
            />

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
  detailPane: { flex: 1, minWidth: 0, minHeight: 0 },
});
