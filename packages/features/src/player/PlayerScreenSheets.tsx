import type { LiveVariantOption } from '@elv/data';
import type { AndroidDecoderMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type {
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  PlaybackTimers,
} from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import type { MutableRefObject, ReactElement } from 'react';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { AudioDeviceInfo } from '../ports/video-host';
import { NextEpisodeBanner } from './NextEpisodeBanner';
import { type ChannelDrawerNavHandle, PlayerChannelDrawer } from './PlayerChannelDrawer';
import { buildSettingsSheetOptionalProps } from './PlayerScreenParts';
import { PlayerSettingsSheet, type PlayerSettingsSheetProps } from './PlayerSettingsSheet';
import { PlayerWindowModePopover } from './PlayerWindowModePopover';
import type { usePlayerCinemaExtras } from './usePlayerCinemaExtras';
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
  readonly isTv: boolean;
  readonly formFactor: FormFactor;
  readonly i18n: AppI18n;
  readonly useDockedDesktopLayout: boolean;
  readonly canZap: boolean;
  readonly tracks: MediaTracks;
  readonly hostSetDeinterlace: ((enabled: boolean) => void) | undefined;
  readonly hostSetAudioDevice: ((name: string) => void) | undefined;
  readonly audioDevices: readonly AudioDeviceInfo[];
  readonly activeAudioDevice: string;
  readonly selectAudioDevice: (name: string) => void;
  readonly showAndroidDecoder: boolean;
  readonly activeDecoderMode: AndroidDecoderMode | undefined;
  readonly handleSelectAndroidDecoderMode: (mode: AndroidDecoderMode) => void;
  readonly autoPlayNextEpisode: boolean | undefined;
  readonly onToggleAutoPlayNextEpisode: (() => void) | undefined;
  readonly reduceMotion: boolean | undefined;
  readonly extras: ReturnType<typeof usePlayerCinemaExtras>;
  readonly hasRecentChannels: boolean;
  readonly channelDrawerNavRef: MutableRefObject<ChannelDrawerNavHandle | null>;
  readonly controls: ReturnType<typeof usePlayerControls>;
  readonly qualitySheetProps: {
    readonly qualityVariants?: readonly LiveVariantOption[];
    readonly activeQualityKey?: string;
    readonly onSelectQualityVariant?: (itemKey: string) => void;
  };
  readonly syncAndQualitySheetProps: Partial<PlayerSettingsSheetProps>;
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
  readonly channelDrawerNode: ReactElement;
  readonly settingsSheetNode: ReactElement;
  readonly windowModePopoverNode: ReactElement | null;
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

  const channelDrawerNode = (
    <PlayerChannelDrawer
      visible={controls.channelListOpen && p.canZap}
      docked={p.useDockedDesktopLayout}
      playlist={p.activeTarget.playlist}
      currentItemKey={p.activeTarget.itemKey}
      formFactor={p.formFactor}
      isTv={p.isTv}
      i18n={p.i18n}
      fetchNowNext={p.extras.fetchChannelNowNext}
      {...(p.hasRecentChannels ? { fetchRecentChannels: p.extras.fetchRecentChannels } : {})}
      navigationRef={p.channelDrawerNavRef}
      onSelectChannel={(entry, index) => {
        p.extras.stillWatching.recordUserActivity();
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
      {...buildSettingsSheetOptionalProps({
        activeDeinterlaceMode: p.extras.activeDeinterlaceMode,
        cycleDeinterlaceMode: p.extras.cycleDeinterlaceMode,
        hostSetDeinterlace: p.hostSetDeinterlace,
        deinterlace: controls.deinterlace,
        toggleDeinterlace: controls.toggleDeinterlace,
        activePitchLock: p.extras.activePitchLock,
        togglePitchLock: p.extras.togglePitchLock,
        activeAudioNorm: p.extras.activeAudioNorm,
        toggleAudioNormalization: p.extras.toggleAudioNormalization,
        autoPlayNextEpisode: p.autoPlayNextEpisode,
        onToggleAutoPlayNextEpisode: p.onToggleAutoPlayNextEpisode,
        hostSetAudioDevice: p.hostSetAudioDevice,
        audioDevices: p.audioDevices,
        activeAudioDevice: p.activeAudioDevice,
        selectAudioDevice: p.selectAudioDevice,
        showAndroidDecoder: p.showAndroidDecoder,
        activeDecoderMode: p.activeDecoderMode,
        handleSelectAndroidDecoderMode: p.handleSelectAndroidDecoderMode,
        onEnterPip: p.onEnterPip,
        onEnterMultiView: p.onEnterMultiView,
      })}
      sleepTimer={p.extras.sleepTimer}
      onSelectSleepTimer={p.extras.selectSleepTimer}
      onToggleSleepTimerAction={p.extras.toggleSleepTimerAction}
      statsVisible={controls.statsVisible}
      {...p.qualitySheetProps}
      {...p.syncAndQualitySheetProps}
      {...p.subtitlesSettingsSheetProps}
      isTv={p.isTv}
      formFactor={p.formFactor}
      i18n={p.i18n}
      onOpenView={controls.openSettingsView}
      onSelectProgram={controls.selectProgram}
      onSelectAudio={controls.selectAudio}
      onSelectSubtitle={controls.selectSubtitle}
      onSelectSpeed={controls.selectSpeed}
      onToggleStats={controls.toggleStats}
      onClose={controls.closeSettings}
    />
  );

  const windowModePopoverNode =
    controls.windowModeOpen &&
    p.activeService !== null &&
    p.onMinimizeToMiniPlayer !== undefined &&
    p.onPopoutPlayer !== undefined ? (
      <PlayerWindowModePopover
        visible
        docked={p.useDockedDesktopLayout}
        i18n={p.i18n}
        isTv={p.isTv}
        onMinimizeToMiniPlayer={p.onMinimizeToMiniPlayer}
        onPopoutPlayer={p.onPopoutPlayer}
        onClose={controls.closeWindowMode}
      />
    ) : null;

  return {
    nextEpisodeNode,
    channelDrawerNode,
    settingsSheetNode,
    windowModePopoverNode,
  };
}
