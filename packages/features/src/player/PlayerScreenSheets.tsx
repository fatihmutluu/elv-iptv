import type { LiveVariantOption, NowNextEntry } from '@elv/data';
import type { AndroidDecoderMode, DeinterlaceMode, OsdTimeDisplayMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type {
  ChapterInfo,
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  PlaybackTimers,
  StreamVideoInfo,
} from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import type { ComponentProps, MutableRefObject, ReactElement } from 'react';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { AudioDeviceInfo } from '../ports/video-host';
import { NextEpisodeBanner } from './NextEpisodeBanner';
import { type ChannelDrawerNavHandle, PlayerChannelDrawer } from './PlayerChannelDrawer';
import { PlayerInfoSheet } from './PlayerInfoSheet';
import { buildSettingsSheetOptionalProps } from './PlayerScreenParts';
import { PlayerSettingsSheet, type PlayerSettingsSheetProps } from './PlayerSettingsSheet';
import type { SleepTimerSnapshot } from './sleep-timer';
import { TrackPickerModal } from './TrackPickerModal';
import type { usePlayerControls } from './usePlayerControls';

/** Inputs for {@link buildPlayerOverlayNodes}. */
export interface BuildPlayerOverlayNodesInput {
  readonly activeTarget: PlayTarget;
  readonly nextEpisode: PlayableEntry | undefined;
  readonly nextEpisodeDismissed: boolean;
  readonly isGaplessArmed: boolean;
  readonly status: PlaybackStatus;
  readonly activeService: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly timers: PlaybackTimers;
  readonly wallClock: () => number;
  readonly isTv: boolean;
  readonly formFactor: FormFactor;
  readonly i18n: AppI18n;
  readonly useDockedDesktopLayout: boolean;
  readonly canZap: boolean;
  readonly tracks: MediaTracks;
  readonly videoInfo: StreamVideoInfo | undefined;
  readonly nowNext: NowNextEntry | null;
  readonly chapters: readonly ChapterInfo[] | undefined;
  readonly alwaysOnTop: boolean;
  readonly hostToggleAlwaysOnTop: (() => void) | undefined;
  readonly hostSetDeinterlace: ((enabled: boolean) => void) | undefined;
  readonly hostSetAudioDevice: ((name: string) => void) | undefined;
  readonly audioDevices: readonly AudioDeviceInfo[];
  readonly activeAudioDevice: string;
  readonly selectAudioDevice: (name: string) => void;
  readonly showAndroidDecoder: boolean;
  readonly activeDecoderMode: AndroidDecoderMode | undefined;
  readonly handleSelectAndroidDecoderMode: (mode: AndroidDecoderMode) => void;
  readonly autoSubtitlesOnSkipBack: boolean | undefined;
  readonly onToggleAutoSubtitlesOnSkipBack: (() => void) | undefined;
  readonly autoPlayNextEpisode: boolean | undefined;
  readonly onToggleAutoPlayNextEpisode: (() => void) | undefined;
  readonly reduceMotion: boolean | undefined;
  readonly activeDeinterlaceMode: DeinterlaceMode;
  readonly cycleDeinterlaceMode: (() => void) | undefined;
  readonly activePitchLock: boolean;
  readonly togglePitchLock: (() => void) | undefined;
  readonly activeAudioNorm: boolean;
  readonly toggleAudioNormalization: (() => void) | undefined;
  readonly timeDisplayMode: OsdTimeDisplayMode;
  readonly handleCycleTimeDisplayMode: () => void;
  readonly handleSelectChapter: (startMs: number) => void;
  readonly sleepTimer: SleepTimerSnapshot;
  readonly selectSleepTimer: (minutes: number) => void;
  readonly toggleSleepTimerAction: () => void;
  readonly fetchChannelNowNext: (itemKey: string) => Promise<NowNextEntry | null>;
  readonly fetchRecentChannels: (() => Promise<readonly PlayableEntry[]>) | undefined;
  readonly channelDrawerNavRef: MutableRefObject<ChannelDrawerNavHandle | null>;
  readonly controls: ReturnType<typeof usePlayerControls>;
  readonly qualitySheetProps: {
    readonly qualityVariants?: readonly LiveVariantOption[];
    readonly activeQualityKey?: string;
    readonly onSelectQualityVariant?: (itemKey: string) => void;
  };
  readonly syncAndQualitySheetProps: Partial<PlayerSettingsSheetProps>;
  readonly subtitlesTrackPickerProps: Partial<ComponentProps<typeof TrackPickerModal>>;
  readonly subtitlesSettingsSheetProps: Partial<PlayerSettingsSheetProps>;
  readonly onRecordUserActivity: () => void;
  readonly onPlayNextEpisode: (expectedKey: string | undefined) => void;
  readonly onDismissNextEpisode: () => void;
  readonly onNextEpisodeVisibilityChange: (visible: boolean) => void;
  readonly onSelectChannel: (entry: PlayableEntry, index?: number) => void;
  readonly onMinimizeToMiniPlayer: (() => void) | undefined;
  readonly onEnterPip: (() => void) | undefined;
  readonly onEnterMultiView: (() => void) | undefined;
  readonly onPopoutPlayer: (() => void) | undefined;
}

/** Builds the auxiliary overlay/sheet React nodes consumed by `PlayerScreenStage`. */
export function buildPlayerOverlayNodes(p: BuildPlayerOverlayNodesInput): {
  readonly nextEpisodeNode: ReactElement;
  readonly trackPickerNode: ReactElement | null;
  readonly infoSheetNode: ReactElement;
  readonly channelDrawerNode: ReactElement;
  readonly settingsSheetNode: ReactElement;
} {
  const { controls } = p;

  const nextEpisodeNode = (
    <NextEpisodeBanner
      nextEpisode={p.nextEpisode}
      statusKind={p.status.kind}
      dismissed={p.nextEpisodeDismissed}
      service={p.activeService}
      clock={p.clock}
      isTv={p.isTv}
      tvFocused={p.isTv && controls.tvOsdFocused && controls.tvOsdAction === 'nextEpisode'}
      i18n={p.i18n}
      {...(p.autoPlayNextEpisode !== undefined
        ? { autoPlayNextEpisode: p.autoPlayNextEpisode }
        : {})}
      autoAdvanceDisabled={p.isGaplessArmed}
      {...(p.reduceMotion !== undefined ? { reduceMotion: p.reduceMotion } : {})}
      timers={p.timers}
      onPlayNext={(expectedKey) => p.onPlayNextEpisode(expectedKey)}
      onDismiss={() => {
        p.onRecordUserActivity();
        p.onDismissNextEpisode();
      }}
      onVisibilityChange={p.onNextEpisodeVisibilityChange}
    />
  );

  const trackPickerNode =
    controls.tracksOpen && p.activeService !== null ? (
      <TrackPickerModal
        tracks={p.tracks}
        cursor={controls.pickerCursor}
        isTv={p.isTv}
        formFactor={p.formFactor}
        i18n={p.i18n}
        onSelectProgram={controls.selectProgram}
        onSelectAudio={controls.selectAudio}
        onSelectSubtitle={controls.selectSubtitle}
        {...p.subtitlesTrackPickerProps}
        onClose={controls.closeTracks}
      />
    ) : null;

  const infoSheetNode = (
    <PlayerInfoSheet
      visible={controls.infoOpen && p.activeService !== null}
      docked={p.useDockedDesktopLayout}
      title={p.activeTarget.title}
      subtitle={p.activeTarget.subtitle}
      isVod={p.activeTarget.kind === 'vod'}
      nowNext={p.nowNext}
      videoInfo={p.videoInfo}
      tracks={p.tracks}
      formFactor={p.formFactor}
      isTv={p.isTv}
      i18n={p.i18n}
      nowMs={p.wallClock()}
      onClose={controls.closeInfo}
    />
  );

  const channelDrawerNode = (
    <PlayerChannelDrawer
      visible={controls.channelListOpen && p.canZap}
      docked={p.useDockedDesktopLayout}
      playlist={p.activeTarget.playlist}
      currentItemKey={p.activeTarget.itemKey}
      formFactor={p.formFactor}
      isTv={p.isTv}
      i18n={p.i18n}
      fetchNowNext={p.fetchChannelNowNext}
      {...(p.fetchRecentChannels !== undefined
        ? { fetchRecentChannels: p.fetchRecentChannels }
        : {})}
      navigationRef={p.channelDrawerNavRef}
      onSelectChannel={(entry, index) => {
        p.onRecordUserActivity();
        p.onSelectChannel(entry, index);
        controls.closeChannelList();
      }}
      onClose={controls.closeChannelList}
    />
  );

  const settingsSheetNode = (
    <PlayerSettingsSheet
      visible={controls.settingsOpen && p.activeService !== null}
      docked={p.useDockedDesktopLayout}
      menuState={controls.settingsMenu}
      tracks={p.tracks}
      isVod={p.activeTarget.kind === 'vod'}
      playbackSpeed={controls.playbackSpeed}
      resizeMode={controls.resizeMode}
      onToggleResizeMode={controls.toggleResizeMode}
      timeDisplayMode={p.timeDisplayMode}
      onCycleTimeDisplayMode={p.handleCycleTimeDisplayMode}
      onToggleInfo={controls.toggleInfo}
      {...buildSettingsSheetOptionalProps({
        alwaysOnTop: p.alwaysOnTop,
        hostToggleAlwaysOnTop: p.hostToggleAlwaysOnTop,
        activeDeinterlaceMode: p.activeDeinterlaceMode,
        cycleDeinterlaceMode: p.cycleDeinterlaceMode,
        hostSetDeinterlace: p.hostSetDeinterlace,
        deinterlace: controls.deinterlace,
        toggleDeinterlace: controls.toggleDeinterlace,
        activePitchLock: p.activePitchLock,
        togglePitchLock: p.togglePitchLock,
        activeAudioNorm: p.activeAudioNorm,
        toggleAudioNormalization: p.toggleAudioNormalization,
        autoSubtitlesOnSkipBack: p.autoSubtitlesOnSkipBack,
        onToggleAutoSubtitlesOnSkipBack: p.onToggleAutoSubtitlesOnSkipBack,
        autoPlayNextEpisode: p.autoPlayNextEpisode,
        onToggleAutoPlayNextEpisode: p.onToggleAutoPlayNextEpisode,
        hostSetAudioDevice: p.hostSetAudioDevice,
        audioDevices: p.audioDevices,
        activeAudioDevice: p.activeAudioDevice,
        selectAudioDevice: p.selectAudioDevice,
        showAndroidDecoder: p.showAndroidDecoder,
        activeDecoderMode: p.activeDecoderMode,
        handleSelectAndroidDecoderMode: p.handleSelectAndroidDecoderMode,
        onMinimizeToMiniPlayer: p.onMinimizeToMiniPlayer,
        onEnterPip: p.onEnterPip,
        onEnterMultiView: p.onEnterMultiView,
        onPopoutPlayer: p.onPopoutPlayer,
      })}
      chapters={p.chapters}
      onSelectChapter={p.handleSelectChapter}
      sleepTimer={p.sleepTimer}
      onSelectSleepTimer={p.selectSleepTimer}
      onToggleSleepTimerAction={p.toggleSleepTimerAction}
      statsVisible={controls.statsVisible}
      {...p.qualitySheetProps}
      {...p.syncAndQualitySheetProps}
      {...p.subtitlesSettingsSheetProps}
      isTv={p.isTv}
      formFactor={p.formFactor}
      i18n={p.i18n}
      onOpenView={controls.openSettingsView}
      onSelectAudio={controls.selectAudio}
      onSelectSubtitle={controls.selectSubtitle}
      onSelectSpeed={controls.selectSpeed}
      onToggleStats={controls.toggleStats}
      onClose={controls.closeSettings}
    />
  );

  return {
    nextEpisodeNode,
    trackPickerNode,
    infoSheetNode,
    channelDrawerNode,
    settingsSheetNode,
  };
}
