import type { LiveVariantOption } from '@elv/data';
import type { AndroidDecoderMode, DefaultResizeModePref, SeekStepSecPref } from '@elv/domain';
import type { KeyEvent, KeymapOverrides, RemappableActionId } from '@elv/focus-core';
import type {
  ChapterInfo,
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  PlaybackTimers,
} from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import type { MutableRefObject } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { AudioDeviceInfo, HostKey, VideoResizeMode } from '../ports/video-host';
import { evaluateRemappedEvent } from '../shared';
import type { ChannelDigitBuffer } from './channel-digit-entry';
import type { PlayerOverlayLive } from './player-overlay-model';
import { COARSE_SEEK_MS, type ScrubController, STEP_SEEK_MS } from './scrub-controller';
import { routeSettingsMenuKey, type SettingsMenuState } from './settings-menu-nav';
import type { SubtitleStyleField } from './subtitle-style-helpers';
import { routePickerKey, type TrackPickerColumn, type TrackPickerCursor } from './track-picker-nav';
import {
  clampTvOsdAction,
  routeTvOsdKey,
  routeTvScrubberKey,
  type TvOsdAction,
} from './tv-osd-nav';

/** Parameters of {@link usePlayerControls}. */
export interface PlayerControlsParams {
  formFactor: FormFactor;
  activeTarget: PlayTarget;
  status: PlaybackStatus;
  tracks: MediaTracks;
  hasTracks: boolean;
  showRetry: boolean;
  hasService: boolean;
  hasSettings?: boolean;
  hasInfo?: boolean;
  hasChannelList?: boolean;
  hasNextEpisode?: boolean;
  hasPreviousChannel?: boolean;
  hasBackToLive?: boolean;
  liveTimeShiftSupported?: boolean;
  hasJumpToLive?: boolean;
  initialOsdHidden?: boolean | undefined;
  autoHideOsdMs?: number | undefined;
  initialVolume?: number | undefined;
  autoSubtitlesOnSkipBack?: boolean | undefined;
  seekStepSec?: SeekStepSecPref | undefined;
  defaultResizeMode?: DefaultResizeModePref | undefined;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  onExitRef: MutableRefObject<() => void>;
  zapByRef: MutableRefObject<(delta: 1 | -1, repeat?: boolean) => void>;
  onSeekCommit?: (positionMs: number) => void;
  onPlayNextEpisode?: () => void;
  onBackToLive?: () => void;
  onJumpPreviousChannel?: () => void;
  onJumpToChannel?: (channelNumber: number) => void;
  onToggleFullscreen?: (() => void) | undefined;
  onToggleAlwaysOnTop?: (() => void) | undefined;
  audioDevices?: readonly AudioDeviceInfo[] | undefined;
  activeAudioDevice?: string | undefined;
  onSelectAudioDevice?: ((name: string) => void) | undefined;
  audioDelayMs?: number | undefined;
  onAdjustAudioDelay?: ((deltaMs: number, reset?: boolean) => void) | undefined;
  subtitleDelayMs?: number | undefined;
  onAdjustSubtitleDelay?: ((deltaMs: number, reset?: boolean) => void) | undefined;
  selectedVideoQualityId?: string | null | undefined;
  onSelectVideoQuality?: ((id: string | null) => void) | undefined;
  qualityVariants?: readonly LiveVariantOption[] | undefined;
  onSelectQualityVariant?: ((itemKey: string) => void) | undefined;
  androidDecoderMode?: AndroidDecoderMode | undefined;
  onSelectAndroidDecoderMode?: ((mode: AndroidDecoderMode) => void) | undefined;
  onToggleMute?: (() => void) | undefined;
  onSetVolume?: ((volume: number) => void) | undefined;
  onPersistVolume?: ((volume: number) => void) | undefined;
  onToggleAutoSubtitlesOnSkipBack?: (() => void) | undefined;
  onToggleAutoPlayNextEpisode?: (() => void) | undefined;
  onChannelListMove?: ((delta: 1 | -1) => void) | undefined;
  onChannelListSwitchTab?: ((dir: -1 | 1) => void) | undefined;
  onChannelListSelect?: (() => void) | undefined;
  onSetOrientationLocked?: ((locked: boolean) => void) | undefined;
  onSetDeinterlace?: ((enabled: boolean) => void) | undefined;
  onCycleDeinterlaceMode?: (() => void) | undefined;
  onTogglePitchLock?: (() => void) | undefined;
  onToggleAudioNormalization?: (() => void) | undefined;
  onResizeModeChange?: ((mode: VideoResizeMode) => void) | undefined;
  onAudioTrackSelected?: ((id: string) => void) | undefined;
  onSubtitleTrackSelected?: ((id: string | null) => void) | undefined;
  hasDualSubtitles?: boolean | undefined;
  onSelectSecondarySubtitle?: ((id: string | null) => void) | undefined;
  canPickSubtitleFile?: boolean | undefined;
  onPickSubtitleFile?: (() => void) | undefined;
  canLoadSubtitleUrl?: boolean | undefined;
  onLoadSubtitleUrl?: (() => void) | undefined;
  hasSubtitleStyle?: boolean | undefined;
  onStepSubtitleStyle?: ((field: SubtitleStyleField, delta: -1 | 1) => void) | undefined;
  onResetSubtitleStyle?: (() => void) | undefined;
  chapters?: readonly ChapterInfo[] | undefined;
  onSelectChapter?: ((startMs: number) => void) | undefined;
  onPrevChapter?: (() => void) | undefined;
  onNextChapter?: (() => void) | undefined;
  sleepTimerMinutes?: number | undefined;
  onSelectSleepTimer?: ((minutes: number) => void) | undefined;
  onToggleSleepTimerAction?: (() => void) | undefined;
  onCycleTimeDisplayMode?: (() => void) | undefined;
  onUserActivity?: (() => void) | undefined;
  stillWatchingVisible?: boolean | undefined;
  onStillWatchingKey?: ((key: KeyEvent['key']) => void) | undefined;
  previewChannelActive?: boolean | undefined;
  onConfirmPreviewChannel?: (() => void) | undefined;
  onCancelPreviewChannel?: (() => void) | undefined;
  onMinimizeToMiniPlayer?: (() => void) | undefined;
  onEnterPip?: (() => void) | undefined;
  onEnterMultiView?: (() => void) | undefined;
  onPopoutPlayer?: (() => void) | undefined;
  tvBackMinimizesLive?: boolean | undefined;
  /** When `true`, suspends player remote/keyboard shortcuts while a root overlay is open. */
  externalOverlayOpen?: boolean | undefined;
}

/** Builds shared {@link SettingsMenuOptions} from live {@link PlayerControlsParams}. */
export function readSettingsMenuOptionsFromControls(p: PlayerControlsParams, canOpenInfo: boolean) {
  const isVod = p.activeTarget.kind === 'vod';
  return {
    isVod,
    hasAspect: true as const,
    hasDeinterlace: p.onSetDeinterlace !== undefined || p.onCycleDeinterlaceMode !== undefined,
    hasPitchLock: p.onTogglePitchLock !== undefined,
    hasAudioNormalization: p.onToggleAudioNormalization !== undefined,
    hasAutoSubtitlesOnSkipBack: isVod && p.onToggleAutoSubtitlesOnSkipBack !== undefined,
    hasAutoPlayNextEpisode: isVod && p.onToggleAutoPlayNextEpisode !== undefined,
    hasAudioDevice: (p.audioDevices?.length ?? 0) > 0 && p.onSelectAudioDevice !== undefined,
    ...(p.audioDevices !== undefined ? { audioDevices: p.audioDevices } : {}),
    ...(p.activeAudioDevice !== undefined ? { activeAudioDevice: p.activeAudioDevice } : {}),
    hasAudioDelay: p.onAdjustAudioDelay !== undefined,
    ...(p.audioDelayMs !== undefined ? { audioDelayMs: p.audioDelayMs } : {}),
    hasSubtitleDelay: p.onAdjustSubtitleDelay !== undefined,
    ...(p.subtitleDelayMs !== undefined ? { subtitleDelayMs: p.subtitleDelayMs } : {}),
    hasSubtitleStyle: p.hasSubtitleStyle === true,
    hasDualSubtitles: p.hasDualSubtitles === true,
    canPickSubtitleFile: p.canPickSubtitleFile === true,
    canLoadSubtitleUrl: p.canLoadSubtitleUrl === true,
    hasVideoQuality:
      (p.tracks.videoQualities?.length ?? 0) > 0 && p.onSelectVideoQuality !== undefined,
    ...(p.selectedVideoQualityId !== undefined
      ? { selectedVideoQualityId: p.selectedVideoQualityId }
      : {}),
    hasQuality:
      !isVod && (p.qualityVariants?.length ?? 0) > 1 && p.onSelectQualityVariant !== undefined,
    ...(p.qualityVariants !== undefined
      ? { qualityVariants: p.qualityVariants, activeQualityKey: p.activeTarget.itemKey }
      : {}),
    hasVideoDecoder:
      p.androidDecoderMode !== undefined && p.onSelectAndroidDecoderMode !== undefined,
    ...(p.androidDecoderMode !== undefined ? { androidDecoderMode: p.androidDecoderMode } : {}),
    hasChapters: isVod && (p.chapters?.length ?? 0) > 0,
    ...(p.chapters !== undefined ? { chapters: p.chapters } : {}),
    hasSleepTimer: p.onSelectSleepTimer !== undefined,
    ...(p.sleepTimerMinutes !== undefined ? { sleepTimerMinutes: p.sleepTimerMinutes } : {}),
    hasTimeDisplay: p.onCycleTimeDisplayMode !== undefined,
    hasInfo: canOpenInfo,
    hasAlwaysOnTop: p.onToggleAlwaysOnTop !== undefined,
    hasMiniPlayer: p.onMinimizeToMiniPlayer !== undefined,
    hasPip: p.onEnterPip !== undefined,
    hasMultiView: p.onEnterMultiView !== undefined,
    hasPopout: p.onPopoutPlayer !== undefined,
  };
}

/** Collaborators for {@link routeOverlayAndMediaKey}. */
export interface OverlayKeyRouteDeps {
  readonly isTv: boolean;
  readonly isVod: boolean;
  readonly liveTimeShiftSupported?: boolean;
  readonly hasAspect: boolean;
  readonly hasDeinterlace?: boolean;
  readonly hasPitchLock?: boolean;
  readonly hasAudioNormalization?: boolean;
  readonly hasAutoSubtitlesOnSkipBack?: boolean;
  readonly hasAutoPlayNextEpisode?: boolean;
  readonly hasAudioDevice?: boolean;
  readonly audioDevices?: readonly AudioDeviceInfo[];
  readonly activeAudioDevice?: string;
  readonly hasAudioDelay?: boolean;
  readonly audioDelayMs?: number;
  readonly hasSubtitleDelay?: boolean;
  readonly subtitleDelayMs?: number;
  readonly hasSubtitleStyle?: boolean;
  readonly hasDualSubtitles?: boolean;
  readonly canPickSubtitleFile?: boolean;
  readonly canLoadSubtitleUrl?: boolean;
  readonly hasVideoQuality?: boolean;
  readonly selectedVideoQualityId?: string | null;
  readonly hasQuality?: boolean;
  readonly qualityVariants?: readonly LiveVariantOption[];
  readonly activeQualityKey?: string;
  readonly hasVideoDecoder?: boolean;
  readonly androidDecoderMode?: AndroidDecoderMode;
  readonly hasChapters?: boolean;
  readonly chapters?: readonly ChapterInfo[];
  readonly hasSleepTimer?: boolean;
  readonly sleepTimerMinutes?: number;
  readonly hasTimeDisplay?: boolean;
  readonly hasAlwaysOnTop?: boolean;
  readonly hasMiniPlayer?: boolean;
  readonly hasPip?: boolean;
  readonly hasMultiView?: boolean;
  readonly hasPopout?: boolean;
  readonly playbackSpeed: number;
  readonly state: PlayerOverlayLive;
  readonly service: PlaybackService | null;
  readonly scrub: ScrubController;
  readonly digitBuf: ChannelDigitBuffer;
  readonly allowTvSelect: () => boolean;
  readonly showOsd: () => void;
  readonly toggleStats: () => void;
  readonly toggleInfo?: () => void;
  readonly toggleAlwaysOnTop?: () => void;
  readonly toggleTimeDisplayMode?: () => void;
  readonly toggleChannelList?: () => void;
  readonly toggleResizeMode: () => void;
  readonly toggleDeinterlace?: () => void;
  readonly togglePitchLock?: () => void;
  readonly toggleAudioNormalization?: () => void;
  readonly toggleAutoSubtitlesOnSkipBack?: () => void;
  readonly toggleAutoPlayNextEpisode?: () => void;
  readonly onMinimizeToMiniPlayer?: (() => void) | undefined;
  readonly onEnterPip?: (() => void) | undefined;
  readonly onEnterMultiView?: (() => void) | undefined;
  readonly onPopoutPlayer?: (() => void) | undefined;
  readonly onChannelListMove?: (delta: 1 | -1) => void;
  readonly onChannelListSwitchTab?: ((dir: -1 | 1) => void) | undefined;
  readonly onChannelListSelect?: () => void;
  readonly togglePlayPause: () => void;
  readonly openTracks: (preferredColumn?: TrackPickerColumn) => void;
  readonly closeTracks: () => void;
  readonly closeSettings: () => void;
  readonly updateSettingsMenu: (next: SettingsMenuState) => void;
  readonly updatePickerCursor: (cursor: TrackPickerCursor) => void;
  readonly focusTvOsd: (action: TvOsdAction) => void;
  readonly blurTvOsd: () => void;
  readonly focusTvScrubber: () => void;
  readonly blurTvScrubber: () => void;
  readonly activateTvOsd: (action: TvOsdAction) => void;
  readonly selectSpeed: (rate: number) => void;
  readonly selectProgram?: (id: string) => void;
  readonly selectAudio?: (id: string) => void;
  readonly selectSubtitle?: (id: string | null) => void;
  readonly selectSecondarySubtitle?: ((id: string | null) => void) | undefined;
  readonly pickSubtitleFile?: (() => void) | undefined;
  readonly loadSubtitleUrl?: (() => void) | undefined;
  readonly stepSubtitleStyle?: ((field: SubtitleStyleField, delta: -1 | 1) => void) | undefined;
  readonly resetSubtitleStyle?: (() => void) | undefined;
  readonly selectChapter?: ((startMs: number) => void) | undefined;
  readonly selectSleepTimer?: ((minutes: number) => void) | undefined;
  readonly toggleSleepTimerAction?: (() => void) | undefined;
  readonly selectAudioDevice?: ((name: string) => void) | undefined;
  readonly adjustAudioDelay?: ((deltaMs: number, reset?: boolean) => void) | undefined;
  readonly adjustSubtitleDelay?: ((deltaMs: number, reset?: boolean) => void) | undefined;
  readonly selectVideoQuality?: ((id: string | null) => void) | undefined;
  readonly selectQualityVariant?: ((itemKey: string) => void) | undefined;
  readonly selectAndroidDecoderMode?: ((mode: AndroidDecoderMode) => void) | undefined;
  readonly onExit: () => void;
  readonly onJumpPreviousChannel?: (() => void) | undefined;
  readonly keymapOverrides?: KeymapOverrides | undefined;
  readonly openSettings?: (() => void) | undefined;
  readonly seekBy?: ((deltaMs: number) => void) | undefined;
  readonly stepSeekMs?: number | undefined;
  readonly zapBy?: ((delta: 1 | -1) => void) | undefined;
  readonly toggleMute?: (() => void) | undefined;
}

function executeRemappedPlayerAction(
  actionId: RemappableActionId,
  d: OverlayKeyRouteDeps,
): boolean {
  const s = d.state;
  switch (actionId) {
    case 'player.togglePlayPause':
      d.togglePlayPause();
      return true;
    case 'player.seekBack':
      if (d.isVod || d.liveTimeShiftSupported === true) d.seekBy?.(-(d.stepSeekMs ?? STEP_SEEK_MS));
      return true;
    case 'player.seekForward':
      if (d.isVod || d.liveTimeShiftSupported === true) d.seekBy?.(d.stepSeekMs ?? STEP_SEEK_MS);
      return true;
    case 'player.channelUp':
      if (!d.isVod) d.zapBy?.(1);
      return true;
    case 'player.channelDown':
      if (!d.isVod) d.zapBy?.(-1);
      return true;
    case 'player.lastChannel':
      d.digitBuf.cancel();
      d.onJumpPreviousChannel?.();
      return true;
    case 'player.openChannelDrawer':
    case 'player.toggleGuide':
      if (s.channelListOpen && d.toggleChannelList !== undefined) {
        d.toggleChannelList();
      } else if (!d.isVod && d.toggleChannelList !== undefined && s.canOpenChannelList) {
        d.digitBuf.cancel();
        d.toggleChannelList();
      } else {
        d.showOsd();
      }
      return true;
    case 'player.openSettings':
      d.digitBuf.cancel();
      if (s.settingsOpen) d.closeSettings();
      else if (d.openSettings !== undefined) d.openSettings();
      else d.showOsd();
      return true;
    case 'player.cycleAudioTrack': {
      const list = s.tracks.audio;
      if (list.length > 0) {
        const curIdx = list.findIndex((t) => t.id === s.tracks.selectedAudioId);
        const nextTrack = list[(curIdx + 1) % list.length];
        if (nextTrack) {
          if (d.selectAudio !== undefined) d.selectAudio(nextTrack.id);
          else d.service?.selectAudioTrack(nextTrack.id);
        }
      } else {
        d.openTracks('audio');
      }
      return true;
    }
    case 'player.cycleSubtitleTrack': {
      const list = s.tracks.subtitles;
      if (list.length > 0) {
        const curIdx = list.findIndex((t) => t.id === s.tracks.selectedSubtitleId);
        if (curIdx === list.length - 1) {
          if (d.selectSubtitle !== undefined) d.selectSubtitle(null);
          else d.service?.selectSubtitleTrack(null);
        } else {
          const nextTrack = list[curIdx + 1];
          if (nextTrack) {
            if (d.selectSubtitle !== undefined) d.selectSubtitle(nextTrack.id);
            else d.service?.selectSubtitleTrack(nextTrack.id);
          }
        }
      } else {
        d.openTracks('subtitles');
      }
      return true;
    }
    case 'player.toggleMute':
      d.toggleMute?.();
      return true;
    case 'player.openInfo':
      if (d.toggleInfo !== undefined && s.canOpenInfo) d.toggleInfo();
      else {
        d.showOsd();
        d.toggleStats();
      }
      return true;
    default:
      return false;
  }
}

/**
 * Handles extended media shortcuts (`stop`, `info`, `captions`, `audioTrack`, `lastChannel`, `menu`),
 * user-remapped player shortcuts (`#33`), and open sheet / focused OSD / focused scrubber key routing.
 * Returns `true` when handled.
 */
export function routeOverlayAndMediaKey(event: KeyEvent, d: OverlayKeyRouteDeps): boolean {
  const s = d.state;
  const anySheetOpen = s.settingsOpen || s.tracksOpen || s.channelListOpen || s.infoOpen;
  if (
    !anySheetOpen &&
    d.keymapOverrides !== undefined &&
    Object.keys(d.keymapOverrides).length > 0
  ) {
    const evalResult = evaluateRemappedEvent(d.keymapOverrides, 'player', event);
    if (evalResult.status === 'remapped') {
      if (executeRemappedPlayerAction(evalResult.actionId, d)) return true;
    } else if (evalResult.status === 'suppressed') {
      return true;
    }
  }
  if (event.kind === 'press') {
    if (event.key === 'stop') {
      d.scrub.cancel();
      d.digitBuf.cancel();
      d.service?.stop();
      d.onExit();
      return true;
    }
    if (event.key === 'info') {
      if (d.toggleInfo !== undefined && s.canOpenInfo) {
        d.toggleInfo();
      } else {
        d.showOsd();
        d.toggleStats();
      }
      return true;
    }
    if (event.key === 'guide') {
      if (d.toggleChannelList !== undefined && s.canOpenChannelList) {
        d.toggleChannelList();
      }
      return true;
    }
    if (event.key === 'captions' || event.key === 'audioTrack') {
      d.openTracks(event.key === 'captions' ? 'subtitles' : 'audio');
      return true;
    }
    if (event.key === 'colorRed') {
      if (s.tracksOpen && s.pickerCursor.column === 'subtitles') d.closeTracks();
      else if (s.hasTracks) d.openTracks('subtitles');
      else d.showOsd();
      return true;
    }
    if (event.key === 'colorGreen') {
      if (s.tracksOpen && s.pickerCursor.column === 'audio') d.closeTracks();
      else if (s.hasTracks) d.openTracks('audio');
      else d.showOsd();
      return true;
    }
    if (event.key === 'colorYellow') {
      if (d.toggleMute !== undefined) {
        d.toggleMute();
      } else {
        d.showOsd();
        d.toggleStats();
      }
      return true;
    }
    if (event.key === 'colorBlue') {
      d.digitBuf.cancel();
      if (s.settingsOpen) d.closeSettings();
      else if (d.openSettings !== undefined) d.openSettings();
      else d.showOsd();
      return true;
    }
    if (event.key === 'lastChannel') {
      d.digitBuf.cancel();
      d.onJumpPreviousChannel?.();
      return true;
    }
    if (event.key === 'menu') {
      if (s.channelListOpen && d.toggleChannelList !== undefined) {
        d.toggleChannelList();
      } else if (!d.isVod && d.toggleChannelList !== undefined && s.canOpenChannelList) {
        d.digitBuf.cancel();
        d.toggleChannelList();
      } else if (s.settingsOpen) {
        d.closeSettings();
      } else if (s.tracksOpen) {
        d.closeTracks();
      } else if (s.hasTracks) {
        d.openTracks();
      } else {
        d.showOsd();
      }
      return true;
    }
  }

  if (s.settingsOpen) {
    const intent = routeSettingsMenuKey(event, s.settingsMenu, s.tracks, {
      isVod: d.isVod,
      playbackSpeed: d.playbackSpeed,
      hasAspect: d.hasAspect,
      hasDeinterlace: d.hasDeinterlace === true,
      hasPitchLock: d.hasPitchLock === true,
      hasAudioNormalization: d.hasAudioNormalization === true,
      hasAutoSubtitlesOnSkipBack: d.hasAutoSubtitlesOnSkipBack === true,
      hasAutoPlayNextEpisode: d.hasAutoPlayNextEpisode === true,
      hasAudioDevice: d.hasAudioDevice === true,
      ...(d.audioDevices !== undefined ? { audioDevices: d.audioDevices } : {}),
      ...(d.activeAudioDevice !== undefined ? { activeAudioDevice: d.activeAudioDevice } : {}),
      hasAudioDelay: d.hasAudioDelay === true,
      ...(d.audioDelayMs !== undefined ? { audioDelayMs: d.audioDelayMs } : {}),
      hasSubtitleDelay: d.hasSubtitleDelay === true,
      ...(d.subtitleDelayMs !== undefined ? { subtitleDelayMs: d.subtitleDelayMs } : {}),
      hasSubtitleStyle: d.hasSubtitleStyle === true,
      hasDualSubtitles: d.hasDualSubtitles === true,
      canPickSubtitleFile: d.canPickSubtitleFile === true,
      canLoadSubtitleUrl: d.canLoadSubtitleUrl === true,
      hasVideoQuality: d.hasVideoQuality === true,
      ...(d.selectedVideoQualityId !== undefined
        ? { selectedVideoQualityId: d.selectedVideoQualityId }
        : {}),
      hasQuality: d.hasQuality === true,
      ...(d.qualityVariants !== undefined ? { qualityVariants: d.qualityVariants } : {}),
      ...(d.activeQualityKey !== undefined ? { activeQualityKey: d.activeQualityKey } : {}),
      hasVideoDecoder: d.hasVideoDecoder === true,
      ...(d.androidDecoderMode !== undefined ? { androidDecoderMode: d.androidDecoderMode } : {}),
      hasChapters: d.hasChapters === true,
      ...(d.chapters !== undefined ? { chapters: d.chapters } : {}),
      hasSleepTimer: d.hasSleepTimer === true,
      ...(d.sleepTimerMinutes !== undefined ? { sleepTimerMinutes: d.sleepTimerMinutes } : {}),
      hasTimeDisplay: d.hasTimeDisplay === true,
      hasInfo: s.canOpenInfo,
      hasAlwaysOnTop: d.hasAlwaysOnTop === true,
      hasMiniPlayer: d.hasMiniPlayer === true,
      hasPip: d.hasPip === true,
      hasMultiView: d.hasMultiView === true,
      hasPopout: d.hasPopout === true,
    });
    if (intent !== null && event.key === 'select' && !d.allowTvSelect()) return true;
    if (intent?.kind === 'close') d.closeSettings();
    else if (intent?.kind === 'state') d.updateSettingsMenu(intent.state);
    else if (intent?.kind === 'toggleResizeMode') d.toggleResizeMode();
    else if (intent?.kind === 'toggleTimeDisplayMode') d.toggleTimeDisplayMode?.();
    else if (intent?.kind === 'toggleInfo') d.toggleInfo?.();
    else if (intent?.kind === 'toggleAlwaysOnTop') d.toggleAlwaysOnTop?.();
    else if (intent?.kind === 'toggleDeinterlace') d.toggleDeinterlace?.();
    else if (intent?.kind === 'togglePitchLock') d.togglePitchLock?.();
    else if (intent?.kind === 'toggleAudioNormalization') d.toggleAudioNormalization?.();
    else if (intent?.kind === 'toggleAutoSubtitlesOnSkipBack') d.toggleAutoSubtitlesOnSkipBack?.();
    else if (intent?.kind === 'toggleAutoPlayNextEpisode') d.toggleAutoPlayNextEpisode?.();
    else if (intent?.kind === 'minimizeToMiniPlayer') {
      d.closeSettings();
      d.onMinimizeToMiniPlayer?.();
    } else if (intent?.kind === 'enterPip') {
      d.closeSettings();
      d.onEnterPip?.();
    } else if (intent?.kind === 'enterMultiView') {
      d.closeSettings();
      d.onEnterMultiView?.();
    } else if (intent?.kind === 'popoutPlayer') {
      d.closeSettings();
      d.onPopoutPlayer?.();
    } else if (intent?.kind === 'toggleStats') d.toggleStats();
    else if (intent?.kind === 'audio') {
      if (d.selectAudio !== undefined) d.selectAudio(intent.id);
      else d.service?.selectAudioTrack(intent.id);
    } else if (intent?.kind === 'audioDelay') d.adjustAudioDelay?.(intent.deltaMs, intent.reset);
    else if (intent?.kind === 'subtitleDelay')
      d.adjustSubtitleDelay?.(intent.deltaMs, intent.reset);
    else if (intent?.kind === 'audioDevice') d.selectAudioDevice?.(intent.name);
    else if (intent?.kind === 'videoQuality') d.selectVideoQuality?.(intent.id);
    else if (intent?.kind === 'quality') d.selectQualityVariant?.(intent.itemKey);
    else if (intent?.kind === 'videoDecoder') d.selectAndroidDecoderMode?.(intent.mode);
    else if (intent?.kind === 'chapter') d.selectChapter?.(intent.startMs);
    else if (intent?.kind === 'sleepTimer') d.selectSleepTimer?.(intent.minutes);
    else if (intent?.kind === 'toggleSleepTimerAction') d.toggleSleepTimerAction?.();
    else if (intent?.kind === 'subtitle') {
      if (d.selectSubtitle !== undefined) d.selectSubtitle(intent.id);
      else d.service?.selectSubtitleTrack(intent.id);
    } else if (intent?.kind === 'secondarySubtitle') {
      if (d.selectSecondarySubtitle !== undefined) d.selectSecondarySubtitle(intent.id);
      else d.service?.selectSecondarySubtitleTrack(intent.id);
    } else if (intent?.kind === 'pickSubtitleFile') d.pickSubtitleFile?.();
    else if (intent?.kind === 'loadSubtitleUrl') d.loadSubtitleUrl?.();
    else if (intent?.kind === 'stepSubtitleStyle')
      d.stepSubtitleStyle?.(intent.field, intent.delta);
    else if (intent?.kind === 'resetSubtitleStyle') d.resetSubtitleStyle?.();
    else if (intent?.kind === 'speed') d.selectSpeed(intent.rate);
    return true;
  }

  if (s.tracksOpen) {
    const intent = routePickerKey(event, s.pickerCursor, s.tracks, {
      dualSubtitles: d.hasDualSubtitles === true,
      canPickSubtitleFile: d.canPickSubtitleFile === true,
      canLoadSubtitleUrl: d.canLoadSubtitleUrl === true,
    });
    if (intent !== null && event.key === 'select' && !d.allowTvSelect()) return true;
    if (intent?.kind === 'move') d.updatePickerCursor(intent.cursor);
    else if (intent?.kind === 'program') {
      if (d.selectProgram !== undefined) d.selectProgram(intent.id);
      else d.service?.selectProgram?.(intent.id);
    } else if (intent?.kind === 'audio') {
      if (d.selectAudio !== undefined) d.selectAudio(intent.id);
      else d.service?.selectAudioTrack(intent.id);
    } else if (intent?.kind === 'subtitle') {
      if (d.selectSubtitle !== undefined) d.selectSubtitle(intent.id);
      else d.service?.selectSubtitleTrack(intent.id);
    } else if (intent?.kind === 'secondarySubtitle') {
      if (d.selectSecondarySubtitle !== undefined) d.selectSecondarySubtitle(intent.id);
      else d.service?.selectSecondarySubtitleTrack(intent.id);
    } else if (intent?.kind === 'pickSubtitleFile') d.pickSubtitleFile?.();
    else if (intent?.kind === 'loadSubtitleUrl') d.loadSubtitleUrl?.();
    return true;
  }

  if (s.channelListOpen) {
    if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'up' || event.key === 'down')
    ) {
      d.onChannelListMove?.(event.key === 'down' ? 1 : -1);
    } else if (event.kind === 'press' && (event.key === 'left' || event.key === 'right')) {
      d.onChannelListSwitchTab?.(event.key === 'right' ? 1 : -1);
    } else if (event.kind === 'press' && event.key === 'select') {
      if (d.allowTvSelect()) d.onChannelListSelect?.();
    }
    return true;
  }

  if (s.infoOpen) {
    return true;
  }

  if (d.isTv && s.tvScrubberFocused) {
    const intent = routeTvScrubberKey(event);
    if (intent?.kind === 'step') {
      if (d.isVod) d.scrub.step(intent.direction, intent.stepKind);
      else if (d.liveTimeShiftSupported === true) {
        d.seekBy?.(intent.direction * (d.stepSeekMs ?? STEP_SEEK_MS));
      }
    } else if (intent?.kind === 'commitOrToggle') {
      if (!d.allowTvSelect()) return true;
      if (d.scrub.previewPositionMs !== undefined) d.scrub.commit();
      else d.togglePlayPause();
    } else if (intent?.kind === 'togglePlayPause') d.togglePlayPause();
    else if (intent?.kind === 'toOsd') {
      d.scrub.cancel();
      d.focusTvOsd(clampTvOsdAction(s.tvOsdAction, s.availableOsd));
    } else if (intent?.kind === 'blur') {
      d.scrub.cancel();
      d.blurTvScrubber();
    }
    return true;
  }

  if (d.isTv && s.tvOsdFocused) {
    const intent = routeTvOsdKey(event, s.tvOsdAction, s.availableOsd);
    if (intent?.kind === 'blur') {
      if (d.isVod || d.liveTimeShiftSupported === true) d.focusTvScrubber();
      else d.blurTvOsd();
    } else if (intent?.kind === 'focus') d.focusTvOsd(intent.action);
    else if (intent?.kind === 'activate') d.activateTvOsd(intent.action);
    return true;
  }

  return false;
}

/** Collaborators for {@link routeHostKey}. */
export interface HostKeyRouteDeps {
  readonly isVod: boolean;
  readonly liveTimeShiftSupported?: boolean;
  readonly state: Pick<
    PlayerOverlayLive,
    'locked' | 'tracksOpen' | 'settingsOpen' | 'infoOpen' | 'channelListOpen'
  >;
  readonly handleBack: () => void;
  readonly onStop?: (() => void) | undefined;
  readonly toggleFullscreen: () => void;
  readonly toggleResizeMode?: (() => void) | undefined;
  readonly toggleAlwaysOnTop?: (() => void) | undefined;
  readonly togglePlayPause: () => void;
  readonly seekBy: (deltaMs: number) => void;
  readonly stepSeekMs?: number | undefined;
  readonly stepVolumeBy?: ((delta: number) => void) | undefined;
  readonly toggleMute?: (() => void) | undefined;
  readonly openTracks: () => void;
  readonly closeTracks: () => void;
  readonly toggleInfo?: (() => void) | undefined;
  readonly toggleChannelList?: (() => void) | undefined;
  readonly zapBy: (delta: 1 | -1) => void;
  readonly onJumpPreviousChannel?: (() => void) | undefined;
}

/** Routes a forwarded out-of-DOM host key (`#420`) through the same controls as DOM shortcuts. */
export function routeHostKey(key: HostKey, d: HostKeyRouteDeps): void {
  const { state } = d;
  const canUseShortcuts =
    !state.locked &&
    !state.tracksOpen &&
    !state.settingsOpen &&
    !state.infoOpen &&
    !state.channelListOpen;
  switch (key) {
    case 'back':
      d.handleBack();
      return;
    case 'stop':
      d.onStop?.();
      return;
    case 'fullscreen':
      if (!state.locked) d.toggleFullscreen();
      return;
    case 'channel-up':
      if (!state.locked) d.zapBy(1);
      return;
    case 'channel-down':
      if (!state.locked) d.zapBy(-1);
      return;
    case 'play-pause':
      if (canUseShortcuts) d.togglePlayPause();
      return;
    case 'seek-back':
      if (canUseShortcuts && (d.isVod || d.liveTimeShiftSupported === true)) {
        d.seekBy(-(d.stepSeekMs ?? STEP_SEEK_MS));
      }
      return;
    case 'seek-forward':
      if (canUseShortcuts && (d.isVod || d.liveTimeShiftSupported === true)) {
        d.seekBy(d.stepSeekMs ?? STEP_SEEK_MS);
      }
      return;
    case 'seek-coarse-back':
      if (canUseShortcuts && (d.isVod || d.liveTimeShiftSupported === true)) {
        d.seekBy(-COARSE_SEEK_MS);
      }
      return;
    case 'seek-coarse-forward':
      if (canUseShortcuts && (d.isVod || d.liveTimeShiftSupported === true)) {
        d.seekBy(COARSE_SEEK_MS);
      }
      return;
    case 'mute':
      if (canUseShortcuts) d.toggleMute?.();
      return;
    case 'tracks':
      if (!state.locked && !state.settingsOpen && !state.infoOpen && !state.channelListOpen) {
        if (state.tracksOpen) d.closeTracks();
        else d.openTracks();
      }
      return;
    case 'info':
      if (!state.locked) d.toggleInfo?.();
      return;
    case 'channel-list':
      if (!state.locked && !d.isVod) d.toggleChannelList?.();
      return;
    case 'prev-channel':
      if (canUseShortcuts && !d.isVod) d.onJumpPreviousChannel?.();
      return;
    case 'always-on-top':
      if (canUseShortcuts) d.toggleAlwaysOnTop?.();
      return;
    case 'aspect':
      if (canUseShortcuts) d.toggleResizeMode?.();
      return;
    case 'volume-up':
      if (canUseShortcuts) d.stepVolumeBy?.(5);
      return;
    case 'volume-down':
      if (canUseShortcuts) d.stepVolumeBy?.(-5);
      return;
  }
}
