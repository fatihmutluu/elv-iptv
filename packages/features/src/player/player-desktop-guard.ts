import type { KeyEvent } from '@elv/focus-core';
import type { PlaybackService } from '@elv/playback';
import type { MutableRefObject } from 'react';
import {
  type OverlayKeyRouteDeps,
  type PlayerControlsParams,
  readSettingsMenuOptionsFromControls,
} from './player-key-routing';
import type { PlayerOverlayLive } from './player-overlay-model';
import type { ScrubController } from './scrub-controller';
import type { SettingsMenuState, SettingsMenuView } from './settings-menu-nav';
import type { TvOsdAction } from './tv-osd-nav';
import type { DesktopShortcutGuard } from './useDesktopPlayerShortcuts';

/** Inputs for {@link buildDesktopShortcutGuard}. */
export interface BuildDesktopShortcutGuardParams {
  readonly cbRef: MutableRefObject<PlayerControlsParams>;
  readonly externalOverlayOpenRef: MutableRefObject<boolean>;
  readonly overlayLiveRef: MutableRefObject<PlayerOverlayLive>;
  readonly openSettings: (view?: SettingsMenuView) => void;
  readonly closeSettings: () => void;
  readonly toggleStats: () => void;
  readonly toggleChannelList: () => void;
  readonly toggleMute: () => void;
  readonly toggleFullscreen: () => void;
  readonly getStepSeekMs: () => number;
  readonly seekBy: (deltaMs: number) => void;
  readonly seekToRatio: (ratio: number) => void;
  readonly seekToEnd: () => void;
  readonly togglePlayPause: () => void;
  readonly handleKeyEvent: (event: KeyEvent) => void;
}

/** Builds the live ref-backed {@link DesktopShortcutGuard} passed to `useDesktopPlayerShortcuts`. */
export function buildDesktopShortcutGuard(
  p: BuildDesktopShortcutGuardParams,
): DesktopShortcutGuard {
  const { cbRef, externalOverlayOpenRef, overlayLiveRef } = p;
  const canUseShortcuts = (): boolean => {
    if (cbRef.current.stillWatchingVisible) return false;
    const s = overlayLiveRef.current;
    return !s.locked && !s.settingsOpen && !s.windowModeOpen && !s.channelListOpen;
  };
  const isOnSubtitlesView = (): boolean => {
    const s = overlayLiveRef.current;
    return (
      s.settingsOpen &&
      (s.settingsMenu.view === 'subtitles' || s.settingsMenu.view === 'subtitleSettings')
    );
  };

  return {
    isSuspended: () => externalOverlayOpenRef.current,
    canJumpPreviousChannel: () =>
      cbRef.current.activeTarget.kind === 'live' &&
      cbRef.current.hasPreviousChannel === true &&
      canUseShortcuts(),
    onJumpPreviousChannel: () => cbRef.current.onJumpPreviousChannel?.(),
    canToggleSubtitles: () => {
      const s = overlayLiveRef.current;
      return (
        !s.locked &&
        !s.windowModeOpen &&
        !s.channelListOpen &&
        (isOnSubtitlesView() || (!s.settingsOpen && s.hasTracks && s.hasService))
      );
    },
    onToggleSubtitles: () =>
      isOnSubtitlesView() ? p.closeSettings() : p.openSettings('subtitles'),
    canToggleStats: () => !overlayLiveRef.current.locked,
    onToggleStats: p.toggleStats,
    canToggleChannelList: () => {
      const s = overlayLiveRef.current;
      return (
        !s.locked &&
        !s.settingsOpen &&
        !s.windowModeOpen &&
        (s.channelListOpen || s.canOpenChannelList)
      );
    },
    onToggleChannelList: p.toggleChannelList,
    canToggleMute: () => canUseShortcuts() && cbRef.current.onToggleMute !== undefined,
    onToggleMute: p.toggleMute,
    canToggleFullscreen: () =>
      !overlayLiveRef.current.locked && cbRef.current.onToggleFullscreen !== undefined,
    onToggleFullscreen: p.toggleFullscreen,
    isVod: () => cbRef.current.activeTarget.kind === 'vod',
    liveTimeShiftSupported: () =>
      cbRef.current.activeTarget.kind === 'live' && cbRef.current.liveTimeShiftSupported === true,
    canUseShortcuts,
    stepSeekMs: p.getStepSeekMs,
    onSeekBy: p.seekBy,
    onSeekToRatio: p.seekToRatio,
    onSeekToEnd: p.seekToEnd,
    onTogglePlayPause: p.togglePlayPause,
    onKeyEvent: p.handleKeyEvent,
  };
}

/** Builds shared {@link OverlayKeyRouteDeps} from live controls state and callbacks. */
export function buildOverlayKeyRouteDeps(p: {
  readonly isTv: boolean;
  readonly playbackSpeed: number;
  readonly state: PlayerOverlayLive;
  readonly service: PlaybackService | null;
  readonly scrub: ScrubController;
  readonly digitBuf: OverlayKeyRouteDeps['digitBuf'];
  readonly allowTvSelect: () => boolean;
  readonly params: PlayerControlsParams;
  readonly overlay: {
    readonly showOsd: () => void;
    readonly toggleStats: () => void;
    readonly toggleChannelList: () => void;
    readonly toggleResizeMode: () => void;
    readonly toggleDeinterlace: () => void;
    readonly closeWindowMode: () => void;
    readonly openSettings: (view?: SettingsMenuView) => void;
    readonly closeSettings: () => void;
    readonly updateSettingsMenu: (next: SettingsMenuState) => void;
    readonly focusTvOsd: (action: TvOsdAction) => void;
    readonly blurTvOsd: () => void;
    readonly focusTvScrubber: () => void;
    readonly blurTvScrubber: () => void;
  };
  readonly togglePlayPause: () => void;
  readonly activateTvOsd: (action: TvOsdAction) => void;
  readonly selectSpeed: (rate: number) => void;
  readonly selectProgram: (id: string) => void;
  readonly selectAudio: (id: string) => void;
  readonly selectSubtitle: (id: string | null) => void;
  readonly onExit: () => void;
  readonly keymapOverrides: OverlayKeyRouteDeps['keymapOverrides'];
  readonly seekBy: (deltaMs: number) => void;
  readonly stepSeekMs: number;
  readonly zapBy: (delta: 1 | -1) => void;
  readonly toggleMute: () => void;
}): OverlayKeyRouteDeps {
  const { params: c, overlay: o } = p;
  return {
    isTv: p.isTv,
    liveTimeShiftSupported: c.liveTimeShiftSupported === true,
    ...readSettingsMenuOptionsFromControls(c),
    playbackSpeed: p.playbackSpeed,
    state: p.state,
    service: p.service,
    scrub: p.scrub,
    digitBuf: p.digitBuf,
    allowTvSelect: p.allowTvSelect,
    showOsd: o.showOsd,
    toggleStats: o.toggleStats,
    toggleChannelList: o.toggleChannelList,
    toggleResizeMode: o.toggleResizeMode,
    toggleDeinterlace: c.onCycleDeinterlaceMode ?? o.toggleDeinterlace,
    togglePitchLock: c.onTogglePitchLock,
    toggleAudioNormalization: c.onToggleAudioNormalization,
    toggleAutoPlayNextEpisode: c.onToggleAutoPlayNextEpisode,
    onEnterPip: c.onEnterPip,
    onEnterMultiView: c.onEnterMultiView,
    onChannelListMove: c.onChannelListMove,
    onChannelListSwitchTab: c.onChannelListSwitchTab,
    onChannelListSelect: c.onChannelListSelect,
    togglePlayPause: p.togglePlayPause,
    closeWindowMode: o.closeWindowMode,
    openSettings: o.openSettings,
    closeSettings: o.closeSettings,
    updateSettingsMenu: o.updateSettingsMenu,
    focusTvOsd: o.focusTvOsd,
    blurTvOsd: o.blurTvOsd,
    focusTvScrubber: o.focusTvScrubber,
    blurTvScrubber: o.blurTvScrubber,
    activateTvOsd: p.activateTvOsd,
    selectSpeed: p.selectSpeed,
    selectProgram: p.selectProgram,
    selectAudio: p.selectAudio,
    selectSubtitle: p.selectSubtitle,
    selectSecondarySubtitle: c.onSelectSecondarySubtitle,
    pickSubtitleFile: c.onPickSubtitleFile,
    loadSubtitleUrl: c.onLoadSubtitleUrl,
    stepSubtitleStyle: c.onStepSubtitleStyle,
    resetSubtitleStyle: c.onResetSubtitleStyle,
    selectSleepTimer: c.onSelectSleepTimer,
    toggleSleepTimerAction: c.onToggleSleepTimerAction,
    selectAudioDevice: c.onSelectAudioDevice,
    adjustAudioDelay: c.onAdjustAudioDelay,
    adjustSubtitleDelay: c.onAdjustSubtitleDelay,
    selectVideoQuality: c.onSelectVideoQuality,
    selectQualityVariant: c.onSelectQualityVariant,
    selectAndroidDecoderMode: c.onSelectAndroidDecoderMode,
    onExit: p.onExit,
    onJumpPreviousChannel: c.onJumpPreviousChannel,
    keymapOverrides: p.keymapOverrides,
    seekBy: p.seekBy,
    stepSeekMs: p.stepSeekMs,
    zapBy: p.zapBy,
    toggleMute: c.onToggleMute !== undefined ? p.toggleMute : undefined,
  };
}
