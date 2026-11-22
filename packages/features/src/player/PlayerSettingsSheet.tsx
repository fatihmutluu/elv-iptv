import type { AppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import {
  AdaptiveSheet,
  type FormFactor,
  Icon,
  IconButton,
  TABULAR_NUMS_STYLE,
  useTheme,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { VideoResizeMode } from '../ports/video-host';
import { useDesktopDialogTrap } from './desktop-dialog-trap';
import { blurWebTarget, SettingsToggleRow, settingsRowStyle } from './PlayerSettingsRows';
import type { SettingsMenuState, SettingsMenuView } from './settings-menu-nav';
import { buildSettingsNavRows, buildSettingsRadioItems } from './settings-sheet-items';

const APPROX_ROW_PITCH = 50;

/** Props of {@link PlayerSettingsSheet}. */
export interface PlayerSettingsSheetProps {
  readonly visible: boolean;
  readonly menuState: SettingsMenuState;
  readonly tracks: MediaTracks;
  readonly isVod?: boolean;
  readonly playbackSpeed?: number;
  readonly resizeMode?: VideoResizeMode;
  readonly deinterlace?: boolean;
  readonly statsVisible: boolean;
  readonly isTv: boolean;
  readonly formFactor: FormFactor;
  readonly i18n: AppI18n;
  readonly onOpenView: (view: SettingsMenuView) => void;
  readonly onSelectAudio: (id: string) => void;
  readonly onSelectSubtitle: (id: string | null) => void;
  readonly onSelectSpeed?: (rate: number) => void;
  readonly onToggleResizeMode?: () => void;
  readonly onToggleDeinterlace?: () => void;
  readonly onToggleStats: () => void;
  readonly onClose: () => void;
}

/**
 * Adaptive 2-level Cinema Quietude Player Settings menu (`Subtitles`, `Audio`, VOD `Speed`,
 * `Aspect` where supported, `Deinterlace` where supported, `Stats HUD`). Flex-docked below the video canvas
 * on `desktop` (HWND-safe) and wrapped in `AdaptiveSheet` elsewhere.
 */
export function PlayerSettingsSheet(props: PlayerSettingsSheetProps): ReactElement | null {
  const { visible, menuState, tracks, statsVisible, isTv, formFactor, i18n } = props;
  const isVod = props.isVod === true;
  const playbackSpeed = props.playbackSpeed ?? 1;
  const showAspect = props.onToggleResizeMode !== undefined;
  const showDeinterlace = props.onToggleDeinterlace !== undefined;
  const deinterlace = props.deinterlace === true;
  const resizeMode = props.resizeMode ?? 'fit';
  const resizeModeLabel =
    resizeMode === 'fill'
      ? i18n.t('player.aspect.fill')
      : resizeMode === 'stretch'
        ? i18n.t('player.aspect.stretch')
        : i18n.t('player.aspect.fit');
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
      : menuState.view === 'speed'
        ? i18n.t('player.speed')
        : i18n.t('player.audioTracks');

  const navRows = isRoot ? buildSettingsNavRows(tracks, isVod, playbackSpeed, i18n) : [];
  const radioItems = isRoot
    ? []
    : buildSettingsRadioItems({
        view: menuState.view,
        tracks,
        playbackSpeed,
        i18n,
        onSelectAudio: props.onSelectAudio,
        onSelectSubtitle: props.onSelectSubtitle,
        onSelectSpeed: props.onSelectSpeed,
      });

  const content = (
    <View testID="player-settings-panel" style={styles.inner}>
      <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
        {!isRoot ? (
          <IconButton
            testID="player-settings-back"
            icon="back"
            size={36}
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
          size={36}
          accessibilityLabel={i18n.t('player.closeTracks')}
          focusable={!isTv}
          onPress={props.onClose}
        />
      </View>

      {isRoot ? (
        <View style={styles.listGap}>
          {navRows.map(([testID, icon, label, summary, targetView, tabular], idx) => (
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
              style={settingsRowStyle(theme, showCursor && menuState.index === idx, false, isTv)}
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
                  tabular ? TABULAR_NUMS_STYLE : undefined,
                  styles.summary,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {summary}
              </Text>
              <Icon name="chevronRight" size={16} color={theme.colors.textMuted} />
            </Pressable>
          ))}
          {showAspect ? (
            <SettingsToggleRow
              testID="player-resize-mode-toggle"
              icon="aspect"
              label={i18n.t('player.aspect')}
              pillLabel={resizeModeLabel}
              active={resizeMode !== 'fit'}
              focused={showCursor && menuState.index === navRows.length}
              isTv={isTv}
              role="button"
              accessibilityLabel={`${i18n.t('player.aspect')}: ${resizeModeLabel}`}
              theme={theme}
              onPress={() => props.onToggleResizeMode?.()}
            />
          ) : null}
          {showDeinterlace ? (
            <SettingsToggleRow
              testID="player-deinterlace-toggle"
              icon="layers"
              label={i18n.t('player.deinterlace')}
              pillLabel={deinterlace ? i18n.t('player.stats.on') : i18n.t('player.stats.off')}
              active={deinterlace}
              focused={showCursor && menuState.index === navRows.length + (showAspect ? 1 : 0)}
              isTv={isTv}
              role="switch"
              accessibilityLabel={i18n.t('player.deinterlace')}
              theme={theme}
              onPress={() => props.onToggleDeinterlace?.()}
            />
          ) : null}
          <SettingsToggleRow
            testID="player-stats-toggle"
            icon="info"
            label={i18n.t('player.statsHud')}
            pillLabel={statsVisible ? i18n.t('player.stats.on') : i18n.t('player.stats.off')}
            active={statsVisible}
            focused={
              showCursor &&
              menuState.index === navRows.length + (showAspect ? 1 : 0) + (showDeinterlace ? 1 : 0)
            }
            isTv={isTv}
            role="switch"
            accessibilityLabel={i18n.t('player.statsHud')}
            theme={theme}
            onPress={props.onToggleStats}
          />
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
                style={settingsRowStyle(
                  theme,
                  showCursor && menuState.index === idx,
                  item.selected,
                  isTv,
                )}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    item.tabular === true ? TABULAR_NUMS_STYLE : undefined,
                    styles.flex1,
                    {
                      color: item.selected ? theme.colors.textPrimary : theme.colors.textSecondary,
                      fontWeight: item.selected ? '700' : '500',
                    },
                  ]}
                >
                  {item.label}
                </Text>
                {item.selected ? <Icon name="check" size={16} color={theme.colors.accent} /> : null}
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
  desktopPanel: { borderTopWidth: 1, paddingHorizontal: 18, paddingVertical: 12 },
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
  subList: { maxHeight: 240 },
  summary: { maxWidth: 120, textAlign: 'right' },
  empty: { paddingVertical: 12, paddingHorizontal: 4 },
});
