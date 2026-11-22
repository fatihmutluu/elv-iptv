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
import type { ChannelDigitBuffer } from './channel-digit-entry';
import type { PlayerOverlayLive } from './player-overlay-model';
import type { ScrubController } from './scrub-controller';
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
  hasNextEpisode?: boolean;
  hasPreviousChannel?: boolean;
  initialOsdHidden?: boolean | undefined;
  autoHideOsdMs?: number | undefined;
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
  onSetOrientationLocked?: ((locked: boolean) => void) | undefined;
}

/** Collaborators for {@link routeOverlayAndMediaKey}. */
export interface OverlayKeyRouteDeps {
  readonly isTv: boolean;
  readonly isVod: boolean;
  readonly hasAspect: boolean;
  readonly playbackSpeed: number;
  readonly state: PlayerOverlayLive;
  readonly service: PlaybackService | null;
  readonly scrub: ScrubController;
  readonly digitBuf: ChannelDigitBuffer;
  readonly allowTvSelect: () => boolean;
  readonly showOsd: () => void;
  readonly toggleStats: () => void;
  readonly toggleResizeMode: () => void;
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
      d.showOsd();
      d.toggleStats();
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
    });
    if (intent !== null && event.key === 'select' && !d.allowTvSelect()) return true;
    if (intent?.kind === 'close') d.closeSettings();
    else if (intent?.kind === 'state') d.updateSettingsMenu(intent.state);
    else if (intent?.kind === 'toggleResizeMode') d.toggleResizeMode();
    else if (intent?.kind === 'toggleStats') d.toggleStats();
    else if (intent?.kind === 'audio') d.service?.selectAudioTrack(intent.id);
    else if (intent?.kind === 'subtitle') d.service?.selectSubtitleTrack(intent.id);
    else if (intent?.kind === 'speed') d.selectSpeed(intent.rate);
    return true;
  }

  if (s.tracksOpen) {
    const intent = routePickerKey(event, s.pickerCursor, s.tracks);
    if (intent !== null && event.key === 'select' && !d.allowTvSelect()) return true;
    if (intent?.kind === 'move') d.updatePickerCursor(intent.cursor);
    else if (intent?.kind === 'audio') d.service?.selectAudioTrack(intent.id);
    else if (intent?.kind === 'subtitle') d.service?.selectSubtitleTrack(intent.id);
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
