import type { LiveVariantOption } from '@elv/data';
import type { AndroidDecoderMode, DeinterlaceMode, OsdTimeDisplayMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { ChapterInfo, MediaTracks } from '@elv/playback';
import {
  AdaptiveSheet,
  type FormFactor,
  Icon,
  IconButton,
  type IconName,
  TABULAR_NUMS_STYLE,
  useTheme,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AudioDeviceInfo, VideoResizeMode } from '../ports/video-host';
import { useDesktopDialogTrap } from './desktop-dialog-trap';
import { blurWebTarget, SettingsToggleRow, settingsRowStyle } from './PlayerSettingsRows';
import type { SettingsMenuState, SettingsMenuView } from './settings-menu-nav';
import { buildSettingsNavRows, buildSettingsRadioItems } from './settings-sheet-items';
import type { SleepTimerSnapshot } from './sleep-timer';

const APPROX_ROW_PITCH = 50;

/** Props of {@link PlayerSettingsSheet}. */
export interface PlayerSettingsSheetProps {
  readonly visible: boolean;
  readonly docked?: boolean;
  readonly menuState: SettingsMenuState;
  readonly tracks: MediaTracks;
  readonly isVod?: boolean;
  readonly playbackSpeed?: number;
  readonly resizeMode?: VideoResizeMode;
  readonly timeDisplayMode?: OsdTimeDisplayMode;
  readonly alwaysOnTop?: boolean;
  readonly deinterlace?: boolean;
  readonly deinterlaceMode?: DeinterlaceMode;
  readonly pitchLock?: boolean;
  readonly audioNormalization?: boolean;
  readonly autoSubtitlesOnSkipBack?: boolean;
  readonly autoPlayNextEpisode?: boolean;
  readonly statsVisible: boolean;
  readonly chapters?: readonly ChapterInfo[] | undefined;
  readonly sleepTimer?: SleepTimerSnapshot | undefined;
  readonly audioDevices?: readonly AudioDeviceInfo[];
  readonly activeAudioDevice?: string;
  readonly qualityVariants?: readonly LiveVariantOption[];
  readonly activeQualityKey?: string;
  readonly androidDecoderMode?: AndroidDecoderMode;
  readonly isTv: boolean;
  readonly formFactor: FormFactor;
  readonly i18n: AppI18n;
  readonly onOpenView: (view: SettingsMenuView) => void;
  readonly onSelectAudio: (id: string) => void;
  readonly onSelectAudioDevice?: (name: string) => void;
  readonly onSelectQualityVariant?: (itemKey: string) => void;
  readonly onSelectSubtitle: (id: string | null) => void;
  readonly onSelectSpeed?: (rate: number) => void;
  readonly onSelectChapter?: (startMs: number) => void;
  readonly onSelectSleepTimer?: (minutes: number) => void;
  readonly onToggleSleepTimerAction?: () => void;
  readonly onSelectAndroidDecoderMode?: (mode: AndroidDecoderMode) => void;
  readonly onToggleResizeMode?: () => void;
  readonly onCycleTimeDisplayMode?: () => void;
  readonly onToggleInfo?: () => void;
  readonly onToggleAlwaysOnTop?: () => void;
  readonly onToggleDeinterlace?: () => void;
  readonly onCycleDeinterlaceMode?: () => void;
  readonly onTogglePitchLock?: () => void;
  readonly onToggleAudioNormalization?: () => void;
  readonly onToggleAutoSubtitlesOnSkipBack?: () => void;
  readonly onToggleAutoPlayNextEpisode?: () => void;
  readonly onToggleStats: () => void;
  readonly onClose: () => void;
}

interface ToggleDescriptor {
  readonly testID: string;
  readonly icon: IconName;
  readonly label: string;
  readonly pillLabel: string;
  readonly active: boolean;
  readonly role: 'button' | 'switch';
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}

function resolveViewTitle(view: SettingsMenuView, i18n: AppI18n): string {
  switch (view) {
    case 'root':
      return i18n.t('player.settings');
    case 'subtitles':
      return i18n.t('player.subtitleTracks');
    case 'audioDevice':
      return i18n.t('player.audioDevice');
    case 'quality':
      return i18n.t('player.qualityVariant');
    case 'speed':
      return i18n.t('player.speed');
    case 'chapters':
      return i18n.t('player.chapters');
    case 'sleepTimer':
      return i18n.t('player.sleepTimer');
    case 'videoDecoder':
      return i18n.t('player.videoDecoder');
    case 'audio':
      return i18n.t('player.audioTracks');
  }
}

/**
 * Adaptive 2-level Cinema Quietude Player Settings popover / portrait bottom sheet
 * (`Subtitles`, `Audio`, `Speed`, `Chapters`, `Sleep timer`, `Aspect`, `Time display`,
 * `Programme info`, `Always on top`, `Deinterlace`, `Stats HUD`).
 */
export function PlayerSettingsSheet(props: PlayerSettingsSheetProps): ReactElement | null {
  const { visible, menuState, tracks, statsVisible, isTv, formFactor, i18n } = props;
  const isVod = props.isVod === true;
  const playbackSpeed = props.playbackSpeed ?? 1;
  const theme = useTheme();
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  const rowPitch = Math.round(APPROX_ROW_PITCH * safeFontScale);
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
      y: Math.max(0, (menuState.index - 1) * rowPitch),
      animated: false,
    });
  }, [menuState.index, menuState.view, rowPitch, showCursor, visible]);

  if (!visible) return null;

  const showAudioDevice =
    (props.audioDevices?.length ?? 0) > 0 && props.onSelectAudioDevice !== undefined;
  const activeAudioDevice = props.activeAudioDevice ?? 'auto';
  const showVideoDecoder =
    props.androidDecoderMode !== undefined && props.onSelectAndroidDecoderMode !== undefined;
  const androidDecoderMode = props.androidDecoderMode ?? 'auto';
  const showSleepTimer = props.onSelectSleepTimer !== undefined;
  const isRoot = menuState.view === 'root';
  const title = resolveViewTitle(menuState.view, i18n);

  const navRows = isRoot
    ? buildSettingsNavRows(
        tracks,
        isVod,
        playbackSpeed,
        i18n,
        {
          show: showAudioDevice,
          devices: props.audioDevices ?? [],
          activeDevice: activeAudioDevice,
        },
        { show: showVideoDecoder, mode: androidDecoderMode },
        {
          chapters: props.chapters,
          showSleepTimer,
          sleepTimer: props.sleepTimer,
          qualityVariants: props.qualityVariants,
          activeQualityKey: props.activeQualityKey,
        },
      )
    : [];

  const toggles: ToggleDescriptor[] = [];
  if (isRoot) {
    if (props.onToggleResizeMode !== undefined) {
      const rm = props.resizeMode ?? 'fit';
      const rmLabel =
        rm === 'fill'
          ? i18n.t('player.aspect.fill')
          : rm === 'stretch'
            ? i18n.t('player.aspect.stretch')
            : i18n.t('player.aspect.fit');
      toggles.push({
        testID: 'player-resize-mode-toggle',
        icon: 'aspect',
        label: i18n.t('player.aspect'),
        pillLabel: rmLabel,
        active: rm !== 'fit',
        role: 'button',
        accessibilityLabel: `${i18n.t('player.aspect')}: ${rmLabel}`,
        onPress: props.onToggleResizeMode,
      });
    }
    if (props.onCycleTimeDisplayMode !== undefined) {
      const tm = props.timeDisplayMode ?? 'total';
      const tmLabel =
        tm === 'remaining'
          ? i18n.t('player.remainingTime')
          : tm === 'endsAt'
            ? i18n.t('player.endsAt', { time: 'HH:MM' })
            : i18n.t('player.totalDuration');
      toggles.push({
        testID: 'player-time-display-toggle',
        icon: 'speed',
        label: i18n.t('player.timeDisplayMode'),
        pillLabel: tmLabel,
        active: tm !== 'total',
        role: 'button',
        accessibilityLabel: `${i18n.t('player.timeDisplayMode')}: ${tmLabel}`,
        onPress: props.onCycleTimeDisplayMode,
      });
    }
    if (props.onToggleInfo !== undefined) {
      toggles.push({
        testID: 'player-info-button',
        icon: 'info',
        label: i18n.t('player.info'),
        pillLabel: i18n.t('home.details'),
        active: false,
        role: 'button',
        accessibilityLabel: i18n.t('player.info'),
        onPress: props.onToggleInfo,
      });
    }
    if (props.onToggleAlwaysOnTop !== undefined) {
      const pinned = props.alwaysOnTop === true;
      toggles.push({
        testID: 'player-always-on-top-button',
        icon: 'pin',
        label: pinned ? i18n.t('player.exitAlwaysOnTop') : i18n.t('player.alwaysOnTop'),
        pillLabel: pinned ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: pinned,
        role: 'switch',
        accessibilityLabel: pinned
          ? i18n.t('player.exitAlwaysOnTop')
          : i18n.t('player.alwaysOnTop'),
        onPress: props.onToggleAlwaysOnTop,
      });
    }
    if (props.onCycleDeinterlaceMode !== undefined) {
      const mode: DeinterlaceMode =
        props.deinterlaceMode ?? (props.deinterlace === true ? 'auto' : 'off');
      const modeLabel =
        mode === 'bwdif'
          ? i18n.t('settings.deinterlaceBwdif')
          : mode === 'auto'
            ? i18n.t('settings.deinterlaceAuto')
            : i18n.t('settings.deinterlaceOff');
      toggles.push({
        testID: 'player-deinterlace-toggle',
        icon: 'layers',
        label: i18n.t('player.deinterlace'),
        pillLabel: modeLabel,
        active: mode !== 'off',
        role: 'button',
        accessibilityLabel: `${i18n.t('player.deinterlace')}: ${modeLabel}`,
        onPress: props.onCycleDeinterlaceMode,
      });
    } else if (props.onToggleDeinterlace !== undefined) {
      const on = props.deinterlace === true;
      toggles.push({
        testID: 'player-deinterlace-toggle',
        icon: 'layers',
        label: i18n.t('player.deinterlace'),
        pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: on,
        role: 'switch',
        accessibilityLabel: i18n.t('player.deinterlace'),
        onPress: props.onToggleDeinterlace,
      });
    }
    if (props.onTogglePitchLock !== undefined) {
      const on = props.pitchLock !== false;
      toggles.push({
        testID: 'player-pitch-lock-toggle',
        icon: 'speed',
        label: i18n.t('settings.pitchLock'),
        pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: on,
        role: 'switch',
        accessibilityLabel: i18n.t('settings.pitchLock'),
        onPress: props.onTogglePitchLock,
      });
    }
    if (props.onToggleAudioNormalization !== undefined) {
      const on = props.audioNormalization === true;
      toggles.push({
        testID: 'player-audio-normalization-toggle',
        icon: 'audio',
        label: i18n.t('settings.audioNormalization'),
        pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: on,
        role: 'switch',
        accessibilityLabel: i18n.t('settings.audioNormalization'),
        onPress: props.onToggleAudioNormalization,
      });
    }
    if (isVod && props.onToggleAutoSubtitlesOnSkipBack !== undefined) {
      const on = props.autoSubtitlesOnSkipBack === true;
      toggles.push({
        testID: 'player-auto-subtitles-skip-back-toggle',
        icon: 'subtitles',
        label: i18n.t('player.autoSubtitlesOnSkipBack'),
        pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: on,
        role: 'switch',
        accessibilityLabel: i18n.t('player.autoSubtitlesOnSkipBack'),
        onPress: props.onToggleAutoSubtitlesOnSkipBack,
      });
    }
    if (isVod && props.onToggleAutoPlayNextEpisode !== undefined) {
      const on = props.autoPlayNextEpisode !== false;
      toggles.push({
        testID: 'player-auto-play-next-toggle',
        icon: 'play',
        label: i18n.t('player.autoPlayNextEpisode'),
        pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: on,
        role: 'switch',
        accessibilityLabel: i18n.t('player.autoPlayNextEpisode'),
        onPress: props.onToggleAutoPlayNextEpisode,
      });
    }
    toggles.push({
      testID: 'player-stats-toggle',
      icon: 'info',
      label: i18n.t('player.statsHud'),
      pillLabel: statsVisible ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
      active: statsVisible,
      role: 'switch',
      accessibilityLabel: i18n.t('player.statsHud'),
      onPress: props.onToggleStats,
    });
  }

  const radioItems = isRoot
    ? []
    : buildSettingsRadioItems({
        view: menuState.view,
        tracks,
        playbackSpeed,
        audioDevices: props.audioDevices,
        activeAudioDevice,
        qualityVariants: props.qualityVariants,
        activeQualityKey: props.activeQualityKey,
        androidDecoderMode,
        chapters: props.chapters,
        sleepTimer: props.sleepTimer,
        i18n,
        onSelectAudio: props.onSelectAudio,
        onSelectAudioDevice: props.onSelectAudioDevice,
        onSelectQualityVariant: props.onSelectQualityVariant,
        onSelectSubtitle: props.onSelectSubtitle,
        onSelectSpeed: props.onSelectSpeed,
        onSelectChapter: props.onSelectChapter,
        onSelectSleepTimer: props.onSelectSleepTimer,
        onToggleSleepTimerAction: props.onToggleSleepTimerAction,
        onSelectAndroidDecoderMode: props.onSelectAndroidDecoderMode,
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
        <ScrollView
          focusable={!isTv}
          style={styles.rootList}
          contentContainerStyle={styles.listGap}
        >
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
          {toggles.map((item, idx) => (
            <SettingsToggleRow
              key={item.testID}
              {...item}
              focused={showCursor && menuState.index === navRows.length + idx}
              isTv={isTv}
              theme={theme}
            />
          ))}
        </ScrollView>
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
    const dockedMode = props.docked ?? true;
    return (
      <View
        ref={desktopPanelRef}
        testID="player-settings-desktop-dialog"
        {...dialogA11yProps}
        style={[
          dockedMode ? styles.desktopPanelDocked : styles.desktopPanelFloating,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            ...(dockedMode ? {} : { borderRadius: theme.radius.modal }),
          },
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
      popoverWidth={310}
    >
      {content}
    </AdaptiveSheet>
  );
}

const styles = StyleSheet.create({
  desktopPanelDocked: { borderTopWidth: 1, paddingHorizontal: 18, paddingVertical: 12 },
  desktopPanelFloating: {
    position: 'absolute',
    top: 68,
    right: 24,
    width: 320,
    maxHeight: 520,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    zIndex: 35,
  },
  inner: { gap: 8 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex1: { flex: 1 },
  listGap: { gap: 2 },
  rootList: { maxHeight: 440 },
  subList: { maxHeight: 280 },
  summary: { maxWidth: 120, textAlign: 'right' },
  empty: { paddingVertical: 12, paddingHorizontal: 4 },
});
