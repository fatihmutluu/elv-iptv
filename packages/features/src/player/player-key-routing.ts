import type { KeyEvent } from '@elv/focus-core';
import type {
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  PlaybackTimers,
} from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import type { MutableRefObject } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { HostKey } from '../ports/video-host';
import type { ChannelDigitBuffer } from './channel-digit-entry';
import type { PlayerOverlayLive } from './player-overlay-model';
import { COARSE_SEEK_MS, type ScrubController, STEP_SEEK_MS } from './scrub-controller';
import { routeSettingsMenuKey, type SettingsMenuState } from './settings-menu-nav';
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
  initialOsdHidden?: boolean | undefined;
  autoHideOsdMs?: number | undefined;
  initialVolume?: number | undefined;
  autoSubtitlesOnSkipBack?: boolean | undefined;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  onExitRef: MutableRefObject<() => void>;
  zapByRef: MutableRefObject<(delta: 1 | -1, repeat?: boolean) => void>;
  onSeekCommit?: (positionMs: number) => void;
  onPlayNextEpisode?: () => void;
  onJumpPreviousChannel?: () => void;
  onJumpToChannel?: (channelNumber: number) => void;
  onToggleFullscreen?: (() => void) | undefined;
  onToggleMute?: (() => void) | undefined;
  onSetVolume?: ((volume: number) => void) | undefined;
  onPersistVolume?: ((volume: number) => void) | undefined;
  onToggleAutoSubtitlesOnSkipBack?: (() => void) | undefined;
  onToggleAutoPlayNextEpisode?: (() => void) | undefined;
  onChannelListMove?: ((delta: 1 | -1) => void) | undefined;
  onChannelListSelect?: (() => void) | undefined;
  onSetOrientationLocked?: ((locked: boolean) => void) | undefined;
  onSetDeinterlace?: ((enabled: boolean) => void) | undefined;
}

/** Collaborators for {@link routeOverlayAndMediaKey}. */
export interface OverlayKeyRouteDeps {
  readonly isTv: boolean;
  readonly isVod: boolean;
  readonly hasAspect: boolean;
  readonly hasDeinterlace?: boolean;
  readonly hasAutoSubtitlesOnSkipBack?: boolean;
  readonly hasAutoPlayNextEpisode?: boolean;
  readonly playbackSpeed: number;
  readonly state: PlayerOverlayLive;
  readonly service: PlaybackService | null;
  readonly scrub: ScrubController;
  readonly digitBuf: ChannelDigitBuffer;
  readonly allowTvSelect: () => boolean;
  readonly showOsd: () => void;
  readonly toggleStats: () => void;
  readonly toggleInfo?: () => void;
  readonly toggleChannelList?: () => void;
  readonly toggleResizeMode: () => void;
  readonly toggleDeinterlace?: () => void;
  readonly toggleAutoSubtitlesOnSkipBack?: () => void;
  readonly toggleAutoPlayNextEpisode?: () => void;
  readonly onChannelListMove?: (delta: 1 | -1) => void;
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
  readonly selectSubtitle?: (id: string | null) => void;
  readonly onExit: () => void;
  readonly onJumpPreviousChannel?: (() => void) | undefined;
}

/**
 * Handles extended media shortcuts (`stop`, `info`, `captions`, `audioTrack`, `lastChannel`, `menu`)
 * and open sheet / focused OSD / focused scrubber key routing. Returns `true` when handled.
 */
export function routeOverlayAndMediaKey(event: KeyEvent, d: OverlayKeyRouteDeps): boolean {
  const s = d.state;
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
    if (event.key === 'lastChannel') {
      d.digitBuf.cancel();
      d.onJumpPreviousChannel?.();
      return true;
    }
    if (event.key === 'menu') {
      if (s.settingsOpen) d.closeSettings();
      else if (s.tracksOpen) d.closeTracks();
      else d.openTracks();
      return true;
    }
  }

  if (s.settingsOpen) {
    const intent = routeSettingsMenuKey(event, s.settingsMenu, s.tracks, {
      isVod: d.isVod,
      playbackSpeed: d.playbackSpeed,
      hasAspect: d.hasAspect,
      hasDeinterlace: d.hasDeinterlace === true,
      hasAutoSubtitlesOnSkipBack: d.hasAutoSubtitlesOnSkipBack === true,
      hasAutoPlayNextEpisode: d.hasAutoPlayNextEpisode === true,
    });
    if (intent !== null && event.key === 'select' && !d.allowTvSelect()) return true;
    if (intent?.kind === 'close') d.closeSettings();
    else if (intent?.kind === 'state') d.updateSettingsMenu(intent.state);
    else if (intent?.kind === 'toggleResizeMode') d.toggleResizeMode();
    else if (intent?.kind === 'toggleDeinterlace') d.toggleDeinterlace?.();
    else if (intent?.kind === 'toggleAutoSubtitlesOnSkipBack') d.toggleAutoSubtitlesOnSkipBack?.();
    else if (intent?.kind === 'toggleAutoPlayNextEpisode') d.toggleAutoPlayNextEpisode?.();
    else if (intent?.kind === 'toggleStats') d.toggleStats();
    else if (intent?.kind === 'audio') d.service?.selectAudioTrack(intent.id);
    else if (intent?.kind === 'subtitle') {
      if (d.selectSubtitle !== undefined) d.selectSubtitle(intent.id);
      else d.service?.selectSubtitleTrack(intent.id);
    } else if (intent?.kind === 'speed') d.selectSpeed(intent.rate);
    return true;
  }

  if (s.tracksOpen) {
    const intent = routePickerKey(event, s.pickerCursor, s.tracks);
    if (intent !== null && event.key === 'select' && !d.allowTvSelect()) return true;
    if (intent?.kind === 'move') d.updatePickerCursor(intent.cursor);
    else if (intent?.kind === 'audio') d.service?.selectAudioTrack(intent.id);
    else if (intent?.kind === 'subtitle') {
      if (d.selectSubtitle !== undefined) d.selectSubtitle(intent.id);
      else d.service?.selectSubtitleTrack(intent.id);
    }
    return true;
  }

  if (s.channelListOpen) {
    if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'up' || event.key === 'down')
    ) {
      d.onChannelListMove?.(event.key === 'down' ? 1 : -1);
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
    if (intent?.kind === 'step') d.scrub.step(intent.direction, intent.stepKind);
    else if (intent?.kind === 'commitOrToggle') {
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
      if (d.isVod) d.focusTvScrubber();
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
  readonly state: Pick<
    PlayerOverlayLive,
    'locked' | 'tracksOpen' | 'settingsOpen' | 'infoOpen' | 'channelListOpen'
  >;
  readonly handleBack: () => void;
  readonly toggleFullscreen: () => void;
  readonly togglePlayPause: () => void;
  readonly seekBy: (deltaMs: number) => void;
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
      if (canUseShortcuts && d.isVod) d.seekBy(-STEP_SEEK_MS);
      return;
    case 'seek-forward':
      if (canUseShortcuts && d.isVod) d.seekBy(STEP_SEEK_MS);
      return;
    case 'seek-coarse-back':
      if (canUseShortcuts && d.isVod) d.seekBy(-COARSE_SEEK_MS);
      return;
    case 'seek-coarse-forward':
      if (canUseShortcuts && d.isVod) d.seekBy(COARSE_SEEK_MS);
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
  }
}
