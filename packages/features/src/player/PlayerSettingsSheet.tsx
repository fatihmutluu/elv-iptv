import type { AppI18n } from '@elv/i18n';
import type { MediaTracks, TrackInfo } from '@elv/playback';
import {
  AdaptiveSheet,
  type FormFactor,
  Icon,
  IconButton,
  type IconName,
  type Theme,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from './desktop-dialog-trap';
import type { SettingsMenuState, SettingsMenuView } from './settings-menu-nav';
import { formatTrackLabel } from './track-labels';

const APPROX_ROW_PITCH = 50;

/** Props of {@link PlayerSettingsSheet}. */
export interface PlayerSettingsSheetProps {
  readonly visible: boolean;
  readonly menuState: SettingsMenuState;
  readonly tracks: MediaTracks;
  readonly statsVisible: boolean;
  readonly isTv: boolean;
  readonly formFactor: FormFactor;
  readonly i18n: AppI18n;
  readonly onOpenView: (view: SettingsMenuView) => void;
  readonly onSelectAudio: (id: string) => void;
  readonly onSelectSubtitle: (id: string | null) => void;
  readonly onToggleStats: () => void;
  readonly onClose: () => void;
}

function blurWebTarget(target: unknown): void {
  if ((Platform.OS as string) === 'web') {
    (target as { blur?: () => void } | null | undefined)?.blur?.();
  }
}

function activeTrackSummary(
  list: readonly TrackInfo[],
  selectedId: string | null,
  fallback: string,
  i18n: AppI18n,
): string {
  if (selectedId === null) return fallback;
  const idx = list.findIndex((t) => t.id === selectedId);
  const track = idx >= 0 ? list[idx] : undefined;
  return track !== undefined ? formatTrackLabel(track, idx, list, i18n) : fallback;
}

function rowStyle(theme: Theme, focused: boolean, selected: boolean, isTv: boolean) {
  return [
    styles.row,
    {
      borderRadius: theme.radius.card,
      backgroundColor: selected
        ? theme.colors.accentTint
        : focused
          ? theme.colors.focusFill
          : theme.colors.bgSurface,
      borderColor: focused
        ? theme.colors.focusRingColor
        : selected
          ? theme.colors.accent
          : theme.colors.surfaceBorder,
      borderWidth: focused ? theme.focus.ringWidth : selected ? 1.5 : 1,
    },
    webTransition(theme, 'border-color, background-color'),
    !isTv ? webCursorPointer() : undefined,
  ];
}

/**
 * Adaptive 2-level Cinema Quietude Player Settings menu (`Subtitles`, `Audio`, `Stats HUD`).
 * Flex-docked below the video canvas on `desktop` (HWND-safe) and wrapped in `AdaptiveSheet`
 * (right popover on Landscape, inset bottom sheet on Portrait) on phone, tablet, and TV.
 */
export function PlayerSettingsSheet(props: PlayerSettingsSheetProps): ReactElement | null {
  const { visible, menuState, tracks, statsVisible, isTv, formFactor, i18n } = props;
  const theme = useTheme();
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const showCursor = isTv || formFactor === 'desktop';
  const desktopPanelRef = useRef<ComponentRef<typeof View> | null>(null);
  const listScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useDesktopDialogTrap(
    desktopPanelRef,
    visible && isWebDesktop,
    menuState.view === 'root' ? props.onClose : () => props.onOpenView('root'),
  );

  useEffect(() => {
    if (!visible || !showCursor || menuState.view === 'root') return;
    listScrollRef.current?.scrollTo?.({
      y: Math.max(0, (menuState.index - 1) * APPROX_ROW_PITCH),
      animated: false,
    });
  }, [menuState.index, menuState.view, showCursor, visible]);

  if (!visible) return null;

  const isRoot = menuState.view === 'root';
  const title = isRoot
    ? i18n.t('player.settings')
    : menuState.view === 'subtitles'
      ? i18n.t('player.subtitleTracks')
      : i18n.t('player.audioTracks');

  const subSummary = activeTrackSummary(
    tracks.subtitles,
    tracks.selectedSubtitleId,
    i18n.t('player.subtitlesOff'),
    i18n,
  );
  const audioSummary = activeTrackSummary(
    tracks.audio,
    tracks.selectedAudioId,
    i18n.t('player.stats.audioNone'),
    i18n,
  );
  const navRows: readonly [string, IconName, string, string, SettingsMenuView][] = [
    [
      'player-settings-row-subtitles',
      'subtitles',
      i18n.t('player.subtitleTracks'),
      subSummary,
      'subtitles',
    ],
    ['player-settings-row-audio', 'audio', i18n.t('player.audioTracks'), audioSummary, 'audio'],
  ];

  const radioItems =
    menuState.view === 'subtitles'
      ? [
          {
            key: 'off',
            testID: 'player-settings-sub-off',
            label: i18n.t('player.subtitlesOff'),
            selected: tracks.selectedSubtitleId === null,
            onPress: () => props.onSelectSubtitle(null),
          },
          ...tracks.subtitles.map((track, idx) => ({
            key: track.id,
            testID: `player-settings-sub-${track.id}`,
            label: formatTrackLabel(track, idx, tracks.subtitles, i18n),
            selected: tracks.selectedSubtitleId === track.id,
            onPress: () => props.onSelectSubtitle(track.id),
          })),
        ]
      : tracks.audio.map((track, idx) => ({
          key: track.id,
          testID: `player-settings-audio-${track.id}`,
          label: formatTrackLabel(track, idx, tracks.audio, i18n),
          selected: tracks.selectedAudioId === track.id,
          onPress: () => props.onSelectAudio(track.id),
        }));

  const content = (
    <View testID="player-settings-panel" style={styles.inner}>
      <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
        {!isRoot ? (
          <IconButton
            testID="player-settings-back"
            icon="back"
            size={40}
            accessibilityLabel={i18n.t('player.settingsBack')}
            focusable={!isTv}
            onPress={() => props.onOpenView('root')}
          />
        ) : null}
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.flex1, { color: theme.colors.textPrimary }]}
        >
          {title}
        </Text>
        <IconButton
          testID="player-settings-close"
          icon="close"
          size={40}
          accessibilityLabel={i18n.t('player.closeTracks')}
          focusable={!isTv}
          onPress={props.onClose}
        />
      </View>

      {isRoot ? (
        <View style={styles.listGap}>
          {navRows.map(([testID, icon, label, summary, targetView], idx) => (
            <Pressable
              key={testID}
              testID={testID}
              focusable={!isTv}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${summary}`}
              onPress={(e) => {
                blurWebTarget(e.currentTarget);
                props.onOpenView(targetView);
              }}
              style={rowStyle(theme, showCursor && menuState.index === idx, false, isTv)}
            >
              <Icon name={icon} size={18} color={theme.colors.textSecondary} />
              <Text
                numberOfLines={1}
                style={[theme.typography.title, styles.flex1, { color: theme.colors.textPrimary }]}
              >
                {label}
              </Text>
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  styles.summary,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {summary}
              </Text>
              <Icon name="chevronRight" size={16} color={theme.colors.textMuted} />
            </Pressable>
          ))}
          <Pressable
            testID="player-stats-toggle"
            focusable={!isTv}
            accessibilityRole="switch"
            accessibilityLabel={i18n.t('player.statsHud')}
            accessibilityState={{ checked: statsVisible }}
            onPress={(e) => {
              blurWebTarget(e.currentTarget);
              props.onToggleStats();
            }}
            style={rowStyle(theme, showCursor && menuState.index === 2, false, isTv)}
          >
            <Icon name="info" size={18} color={theme.colors.textSecondary} />
            <Text
              numberOfLines={1}
              style={[theme.typography.title, styles.flex1, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('player.statsHud')}
            </Text>
            <View
              style={[
                styles.togglePill,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: statsVisible ? theme.colors.accent : theme.colors.chipBg,
                  borderColor: statsVisible ? theme.colors.accent : theme.colors.chipBorder,
                },
              ]}
            >
              <Text
                style={[
                  theme.typography.micro,
                  {
                    color: statsVisible ? theme.colors.accentContrast : theme.colors.textSecondary,
                  },
                ]}
              >
                {statsVisible ? i18n.t('player.stats.on') : i18n.t('player.stats.off')}
              </Text>
            </View>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          ref={listScrollRef}
          focusable={!isTv}
          style={styles.subList}
          contentContainerStyle={styles.listGap}
        >
          {radioItems.length > 0 ? (
            radioItems.map((item, idx) => (
              <Pressable
                key={item.key}
                testID={item.testID}
                focusable={!isTv}
                accessibilityRole="radio"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: item.selected, checked: item.selected }}
                aria-checked={item.selected}
                onPress={(e) => {
                  blurWebTarget(e.currentTarget);
                  item.onPress();
                }}
                style={rowStyle(theme, showCursor && menuState.index === idx, item.selected, isTv)}
              >
                <View
                  style={[
                    styles.radioDot,
                    {
                      borderRadius: theme.radius.pill,
                      borderColor: item.selected ? theme.colors.accent : theme.colors.textMuted,
                      backgroundColor: item.selected ? theme.colors.accent : 'transparent',
                    },
                  ]}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    styles.flex1,
                    {
                      color: item.selected ? theme.colors.textPrimary : theme.colors.textSecondary,
                      fontWeight: item.selected ? '700' : '500',
                    },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))
          ) : (
            <Text
              style={[theme.typography.caption, styles.empty, { color: theme.colors.textMuted }]}
            >
              {i18n.t('player.stats.audioNone')}
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );

  if (formFactor === 'desktop') {
    const dialogA11yProps = isWebDesktop
      ? ({ role: 'dialog', 'aria-modal': true, 'aria-label': title } as Record<string, unknown>)
      : undefined;
    return (
      <View
        ref={desktopPanelRef}
        testID="player-settings-desktop-dialog"
        {...dialogA11yProps}
        style={[
          styles.desktopPanel,
          { backgroundColor: theme.colors.glassBg, borderTopColor: theme.colors.glassBorder },
          webBackdropBlur(20),
        ]}
      >
        {content}
      </View>
    );
  }

  return (
    <AdaptiveSheet
      visible={visible}
      onDismiss={props.onClose}
      testID="player-settings-sheet"
      popoverWidth={300}
    >
      {content}
    </AdaptiveSheet>
  );
}

const styles = StyleSheet.create({
  desktopPanel: { borderTopWidth: 1, paddingHorizontal: 16, paddingVertical: 12 },
  inner: { gap: 10 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex1: { flex: 1 },
  listGap: { gap: 6 },
  subList: { maxHeight: 220 },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  summary: { maxWidth: 120, textAlign: 'right' },
  radioDot: { width: 10, height: 10, borderWidth: 1.5 },
  togglePill: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 44,
    alignItems: 'center',
  },
  empty: { paddingVertical: 12, paddingHorizontal: 4 },
});
