import type { LiveVariantOption } from '@elv/data';
import {
  type AndroidDecoderMode,
  DEFAULT_SUBTITLE_STYLE,
  type DeinterlaceMode,
  type SubtitleStyleConfig,
} from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { AdaptiveSheet, type FormFactor, IconButton, useTheme, webBackdropBlur } from '@elv/ui-kit';
import { type ComponentRef, Fragment, type ReactElement, useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AudioDeviceInfo, VideoResizeMode } from '../ports/video-host';
import { useDesktopDialogTrap } from './desktop-dialog-trap';
import { PlayerAudioSettingsView } from './PlayerAudioSettingsView';
import { SettingsRadioRow, SettingsRow, SettingsToggleRow } from './PlayerSettingsRows';
import { PlayerSubtitleSettingsView } from './PlayerSubtitleSettingsView';
import {
  getParentSettingsView,
  type SettingsMenuState,
  type SettingsMenuView,
} from './settings-menu-nav';
import {
  buildOrderedAdvancedEntries,
  buildOrderedRootSettingsEntries,
  buildSettingsRadioItems,
} from './settings-sheet-items';
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
  readonly deinterlace?: boolean;
  readonly deinterlaceMode?: DeinterlaceMode;
  readonly pitchLock?: boolean;
  readonly audioNormalization?: boolean;
  readonly autoPlayNextEpisode?: boolean;
  readonly statsVisible: boolean;
  readonly sleepTimer?: SleepTimerSnapshot | undefined;
  readonly audioDevices?: readonly AudioDeviceInfo[];
  readonly activeAudioDevice?: string;
  readonly audioDelayMs?: number;
  readonly subtitleDelayMs?: number;
  readonly subtitleStyle?: SubtitleStyleConfig;
  readonly dualSubtitles?: boolean;
  readonly selectedVideoQualityId?: string | null;
  readonly qualityVariants?: readonly LiveVariantOption[];
  readonly activeQualityKey?: string;
  readonly androidDecoderMode?: AndroidDecoderMode;
  readonly isTv: boolean;
  readonly formFactor: FormFactor;
  readonly i18n: AppI18n;
  readonly onOpenView: (view: SettingsMenuView) => void;
  readonly onSelectProgram?: (id: string) => void;
  readonly onSelectAudio: (id: string) => void;
  readonly onSelectAudioDevice?: (name: string) => void;
  readonly onAdjustAudioDelay?: (deltaMs: number, reset?: boolean) => void;
  readonly onAdjustSubtitleDelay?: (deltaMs: number, reset?: boolean) => void;
  readonly onSelectVideoQuality?: (id: string | null) => void;
  readonly onSelectQualityVariant?: (itemKey: string) => void;
  readonly onSelectSubtitle: (id: string | null) => void;
  readonly onSelectSecondarySubtitle?: (id: string | null) => void;
  readonly onPickSubtitleFile?: () => void;
  readonly onLoadSubtitleUrl?: () => void;
  readonly onChangeSubtitleStyle?: (next: SubtitleStyleConfig) => void;
  readonly onSelectSpeed?: (rate: number) => void;
  readonly onSelectSleepTimer?: (minutes: number) => void;
  readonly onToggleSleepTimerAction?: () => void;
  readonly onSelectAndroidDecoderMode?: (mode: AndroidDecoderMode) => void;
  readonly onToggleResizeMode?: () => void;
  readonly onToggleDeinterlace?: () => void;
  readonly onCycleDeinterlaceMode?: () => void;
  readonly onTogglePitchLock?: () => void;
  readonly onToggleAudioNormalization?: () => void;
  readonly onToggleAutoPlayNextEpisode?: () => void;
  readonly onEnterPip?: () => void;
  readonly onEnterMultiView?: () => void;
  readonly onToggleStats: () => void;
  readonly onClose: () => void;
}

function resolveViewTitle(view: SettingsMenuView, i18n: AppI18n): string {
  switch (view) {
    case 'root':
      return i18n.t('player.settings');
    case 'subtitles':
      return i18n.t('player.subtitleTracks');
    case 'subtitleSettings':
      return i18n.t('player.subtitleSettings');
    case 'audio':
      return i18n.t('player.audioTracks');
    case 'audioSettings':
      return i18n.t('player.audioSettings');
    case 'videoQuality':
      return i18n.t('player.videoQuality');
    case 'quality':
      return i18n.t('player.qualityVariant');
    case 'speed':
      return i18n.t('player.speed');
    case 'sleepTimer':
      return i18n.t('player.sleepTimer');
    case 'advanced':
      return i18n.t('player.advancedSettings');
    case 'videoDecoder':
      return i18n.t('player.videoDecoder');
  }
}

/**
 * Adaptive 2-level Cinema Quietude Player Settings popover / bottom sheet (`Wave R4`):
 * streamlined root list (`Subtitles`, `Audio`, `Speed`, `Quality`, `Aspect`, `Multi-View`,
 * `Sleep timer`, `Stats HUD`, `Advanced settings`), plus second-level sub-views for
 * Subtitle Settings, Audio Settings, and Advanced Settings with click-outside backdrop on desktop.
 */
export function PlayerSettingsSheet(props: PlayerSettingsSheetProps): ReactElement | null {
  const { visible, menuState, tracks, statsVisible, isTv, formFactor, i18n } = props;
  const isVod = props.isVod === true;
  const playbackSpeed = props.playbackSpeed ?? 1;
  const theme = useTheme();
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  const rowPitch = Math.round(APPROX_ROW_PITCH * safeFontScale);
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const dockedMode = props.docked ?? true;
  const showCursor = isTv || formFactor === 'desktop';
  const desktopPanelRef = useRef<ComponentRef<typeof View> | null>(null);
  const listScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const parentView = getParentSettingsView(menuState.view);

  useDesktopDialogTrap(
    desktopPanelRef,
    visible && isWebDesktop,
    parentView === null ? props.onClose : () => props.onOpenView(parentView),
    { modal: !dockedMode },
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
  const audioDelayMs = props.audioDelayMs ?? 0;
  const subtitleDelayMs = props.subtitleDelayMs ?? 0;
  const showAudioDelay = props.onAdjustAudioDelay !== undefined;
  const showSubtitleDelay = props.onAdjustSubtitleDelay !== undefined;
  const showSubtitleStyle = props.onChangeSubtitleStyle !== undefined;
  const activeSubtitleStyle = props.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE;
  const showVideoQuality =
    (tracks.videoQualities?.length ?? 0) > 1 && props.onSelectVideoQuality !== undefined;
  const showSleepTimer = props.onSelectSleepTimer !== undefined;
  const isRoot = menuState.view === 'root';
  const title = resolveViewTitle(menuState.view, i18n);

  const advancedEntries = buildOrderedAdvancedEntries({
    isVod,
    deinterlace: props.deinterlace,
    deinterlaceMode: props.deinterlaceMode,
    pitchLock: props.pitchLock,
    audioNormalization: props.audioNormalization,
    autoPlayNextEpisode: props.autoPlayNextEpisode,
    androidDecoderMode: props.androidDecoderMode,
    i18n,
    onToggleDeinterlace: props.onToggleDeinterlace,
    onCycleDeinterlaceMode: props.onCycleDeinterlaceMode,
    onSelectAndroidDecoderMode: props.onSelectAndroidDecoderMode,
    onToggleAudioNormalization: props.onToggleAudioNormalization,
    onTogglePitchLock: props.onTogglePitchLock,
    onToggleAutoPlayNextEpisode: props.onToggleAutoPlayNextEpisode,
    onEnterPip: props.onEnterPip,
    onClose: props.onClose,
  });

  const rootEntries = isRoot
    ? buildOrderedRootSettingsEntries({
        tracks,
        isVod,
        playbackSpeed,
        resizeMode: props.resizeMode ?? 'fit',
        statsVisible,
        sleepTimer: props.sleepTimer,
        qualityVariants: props.qualityVariants,
        activeQualityKey: props.activeQualityKey,
        showVideoQuality,
        selectedVideoQualityId: props.selectedVideoQualityId,
        showSleepTimer,
        hasAdvanced: advancedEntries.length > 0,
        i18n,
        onToggleResizeMode: props.onToggleResizeMode,
        onEnterMultiView: props.onEnterMultiView,
        onToggleStats: props.onToggleStats,
        onClose: props.onClose,
      })
    : [];

  const isStandardRadioView =
    !isRoot &&
    menuState.view !== 'subtitleSettings' &&
    menuState.view !== 'audioSettings' &&
    menuState.view !== 'advanced';

  const radioItems = isStandardRadioView
    ? buildSettingsRadioItems({
        view: menuState.view,
        tracks,
        isVod,
        playbackSpeed,
        androidDecoderMode: props.androidDecoderMode,
        qualityVariants: props.qualityVariants,
        activeQualityKey: props.activeQualityKey,
        selectedVideoQualityId: props.selectedVideoQualityId,
        sleepTimer: props.sleepTimer,
        i18n,
        onSelectProgram: props.onSelectProgram,
        onSelectAudio: props.onSelectAudio,
        onSelectVideoQuality: props.onSelectVideoQuality,
        onSelectQualityVariant: props.onSelectQualityVariant,
        onSelectSubtitle: props.onSelectSubtitle,
        hasSubtitleDelay: showSubtitleDelay,
        hasSubtitleStyle: showSubtitleStyle,
        dualSubtitles: props.dualSubtitles,
        onSelectSecondarySubtitle: props.onSelectSecondarySubtitle,
        onPickSubtitleFile: props.onPickSubtitleFile,
        onLoadSubtitleUrl: props.onLoadSubtitleUrl,
        hasAudioDelay: showAudioDelay,
        hasAudioDevice: showAudioDevice,
        hasAudioNormalization: props.onToggleAudioNormalization !== undefined,
        hasPitchLock: isVod && props.onTogglePitchLock !== undefined,
        onOpenView: props.onOpenView,
        onSelectSpeed: props.onSelectSpeed,
        onSelectSleepTimer: props.onSelectSleepTimer,
        onToggleSleepTimerAction: props.onToggleSleepTimerAction,
        onSelectAndroidDecoderMode: props.onSelectAndroidDecoderMode,
      })
    : [];

  const content = (
    <View testID="player-settings-panel" style={styles.inner}>
      <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
        {parentView !== null ? (
          <IconButton
            testID="player-settings-back"
            icon="back"
            size={36}
            accessibilityLabel={i18n.t('player.settingsBack')}
            focusable={!isTv}
            onPress={() => props.onOpenView(parentView)}
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
          {rootEntries.map((entry, idx) =>
            entry.kind === 'nav' ? (
              <SettingsRow
                key={entry.row[0]}
                testID={entry.row[0]}
                icon={entry.row[1]}
                label={entry.row[2]}
                summary={entry.row[3]}
                description={entry.row[6]}
                tabular={entry.row[5]}
                focused={showCursor && menuState.index === idx}
                isTv={isTv}
                theme={theme}
                onPress={() => props.onOpenView(entry.row[4])}
              />
            ) : (
              <SettingsToggleRow
                key={entry.toggle.testID}
                {...entry.toggle}
                focused={showCursor && menuState.index === idx}
                isTv={isTv}
                theme={theme}
              />
            ),
          )}
        </ScrollView>
      ) : menuState.view === 'subtitleSettings' ? (
        <ScrollView
          ref={listScrollRef}
          focusable={!isTv}
          style={styles.subList}
          contentContainerStyle={styles.listGap}
        >
          <PlayerSubtitleSettingsView
            tracks={tracks}
            showSubtitleDelay={showSubtitleDelay}
            subtitleDelayMs={subtitleDelayMs}
            showSubtitleStyle={showSubtitleStyle}
            subtitleStyle={activeSubtitleStyle}
            dualSubtitles={props.dualSubtitles === true}
            focusedIndex={menuState.index}
            showCursor={showCursor}
            isTv={isTv}
            theme={theme}
            i18n={i18n}
            onAdjustSubtitleDelay={props.onAdjustSubtitleDelay}
            onChangeSubtitleStyle={props.onChangeSubtitleStyle}
            onSelectSecondarySubtitle={props.onSelectSecondarySubtitle}
            onPickSubtitleFile={props.onPickSubtitleFile}
            onLoadSubtitleUrl={props.onLoadSubtitleUrl}
          />
        </ScrollView>
      ) : menuState.view === 'audioSettings' ? (
        <ScrollView
          ref={listScrollRef}
          focusable={!isTv}
          style={styles.subList}
          contentContainerStyle={styles.listGap}
        >
          <PlayerAudioSettingsView
            isVod={isVod}
            showAudioDelay={showAudioDelay}
            audioDelayMs={audioDelayMs}
            showAudioDevice={showAudioDevice}
            audioDevices={props.audioDevices ?? []}
            activeAudioDevice={activeAudioDevice}
            audioNormalization={props.audioNormalization}
            pitchLock={props.pitchLock}
            focusedIndex={menuState.index}
            showCursor={showCursor}
            isTv={isTv}
            theme={theme}
            i18n={i18n}
            onAdjustAudioDelay={props.onAdjustAudioDelay}
            onSelectAudioDevice={props.onSelectAudioDevice}
            onToggleAudioNormalization={props.onToggleAudioNormalization}
            onTogglePitchLock={props.onTogglePitchLock}
          />
        </ScrollView>
      ) : menuState.view === 'advanced' ? (
        <ScrollView
          ref={listScrollRef}
          focusable={!isTv}
          style={styles.subList}
          contentContainerStyle={styles.listGap}
        >
          {advancedEntries.map((entry, idx) =>
            entry.kind === 'nav' ? (
              <SettingsRow
                key={entry.row[0]}
                testID={entry.row[0]}
                icon={entry.row[1]}
                label={entry.row[2]}
                summary={entry.row[3]}
                description={entry.row[6]}
                tabular={entry.row[5]}
                focused={showCursor && menuState.index === idx}
                isTv={isTv}
                theme={theme}
                onPress={() => props.onOpenView(entry.row[4])}
              />
            ) : (
              <SettingsToggleRow
                key={entry.toggle.testID}
                {...entry.toggle}
                focused={showCursor && menuState.index === idx}
                isTv={isTv}
                theme={theme}
              />
            ),
          )}
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
              <Fragment key={item.key}>
                {item.sectionHeader !== undefined ? (
                  <Text
                    style={[
                      theme.typography.caption,
                      styles.sectionHeader,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    {item.sectionHeader}
                  </Text>
                ) : null}
                <SettingsRadioRow
                  item={item}
                  focused={showCursor && menuState.index === idx}
                  isTv={isTv}
                  theme={theme}
                />
              </Fragment>
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
    if (!dockedMode) {
      const backdropWebProps = isWebDesktop
        ? ({ tabIndex: -1 } as Record<string, unknown>)
        : undefined;
      return (
        <View
          ref={desktopPanelRef}
          testID="player-settings-desktop-overlay"
          pointerEvents="box-none"
          style={styles.floatingOverlayRoot}
        >
          <Pressable
            testID="player-settings-backdrop"
            accessible={false}
            aria-hidden
            focusable={false}
            {...backdropWebProps}
            onPress={props.onClose}
            style={StyleSheet.absoluteFill}
          />
          <View
            testID="player-settings-desktop-dialog"
            {...dialogA11yProps}
            style={[
              styles.desktopPanelFloating,
              {
                backgroundColor: theme.colors.glassBg,
                borderColor: theme.colors.glassBorder,
                borderRadius: theme.radius.modal,
              },
              webBackdropBlur(20),
            ]}
          >
            {content}
          </View>
        </View>
      );
    }
    return (
      <View
        ref={desktopPanelRef}
        testID="player-settings-desktop-dialog"
        {...dialogA11yProps}
        style={[
          styles.desktopPanelDocked,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
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
      popoverWidth={330}
    >
      {content}
    </AdaptiveSheet>
  );
}

const styles = StyleSheet.create({
  floatingOverlayRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 35,
  },
  desktopPanelDocked: { borderTopWidth: 1, paddingHorizontal: 18, paddingVertical: 12 },
  desktopPanelFloating: {
    position: 'absolute',
    top: 76,
    right: 24,
    width: 340,
    maxHeight: 540,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    zIndex: 1,
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
  rootList: { maxHeight: 460 },
  subList: { maxHeight: 360 },
  sectionHeader: { paddingTop: 8, paddingBottom: 2, paddingHorizontal: 10 },
  empty: { paddingVertical: 12, paddingHorizontal: 4 },
});
