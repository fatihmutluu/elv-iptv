import type { KeyEvent } from '@elv/focus-core';
import type { MutableRefObject } from 'react';
import type { PlayerControlsParams } from './player-key-routing';
import type { PlayerOverlayLive } from './player-overlay-model';
import type { DesktopShortcutGuard } from './useDesktopPlayerShortcuts';

/** Inputs for {@link buildDesktopShortcutGuard}. */
export interface BuildDesktopShortcutGuardParams {
  readonly cbRef: MutableRefObject<PlayerControlsParams>;
  readonly externalOverlayOpenRef: MutableRefObject<boolean>;
  readonly overlayLiveRef: MutableRefObject<PlayerOverlayLive>;
  readonly openTracks: () => void;
  readonly closeTracks: () => void;
  readonly toggleInfo: () => void;
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
    return !s.locked && !s.tracksOpen && !s.settingsOpen && !s.infoOpen && !s.channelListOpen;
  };

  return {
    isSuspended: () => externalOverlayOpenRef.current,
    canJumpPreviousChannel: () =>
      cbRef.current.activeTarget.kind === 'live' &&
      cbRef.current.hasPreviousChannel === true &&
      canUseShortcuts(),
    onJumpPreviousChannel: () => cbRef.current.onJumpPreviousChannel?.(),
    canToggleTracks: () => {
      const s = overlayLiveRef.current;
      return (
        !s.locked &&
        !s.settingsOpen &&
        !s.infoOpen &&
        !s.channelListOpen &&
        (s.tracksOpen || s.hasTracks)
      );
    },
    onToggleTracks: () => (overlayLiveRef.current.tracksOpen ? p.closeTracks() : p.openTracks()),
    canToggleInfo: () => {
      const s = overlayLiveRef.current;
      return (
        !s.locked &&
        !s.tracksOpen &&
        !s.settingsOpen &&
        !s.channelListOpen &&
        (s.infoOpen || s.canOpenInfo)
      );
    },
    onToggleInfo: p.toggleInfo,
    canToggleStats: () => !overlayLiveRef.current.locked,
    onToggleStats: p.toggleStats,
    canToggleChannelList: () => {
      const s = overlayLiveRef.current;
      return (
        !s.locked &&
        !s.tracksOpen &&
        !s.settingsOpen &&
        !s.infoOpen &&
        (s.channelListOpen || s.canOpenChannelList)
      );
    },
    onToggleChannelList: p.toggleChannelList,
    canToggleMute: () => canUseShortcuts() && cbRef.current.onToggleMute !== undefined,
    onToggleMute: p.toggleMute,
    canToggleFullscreen: () =>
      !overlayLiveRef.current.locked && cbRef.current.onToggleFullscreen !== undefined,
    onToggleFullscreen: p.toggleFullscreen,
    canToggleAlwaysOnTop: () =>
      canUseShortcuts() && cbRef.current.onToggleAlwaysOnTop !== undefined,
    onToggleAlwaysOnTop: () => cbRef.current.onToggleAlwaysOnTop?.(),
    isVod: () => cbRef.current.activeTarget.kind === 'vod',
    liveTimeShiftSupported: () =>
      cbRef.current.activeTarget.kind === 'live' && cbRef.current.liveTimeShiftSupported === true,
    canUseShortcuts,
    stepSeekMs: p.getStepSeekMs,
    onSeekBy: p.seekBy,
    onSeekToRatio: p.seekToRatio,
    onSeekToEnd: p.seekToEnd,
    ...(cbRef.current.onPrevChapter !== undefined
      ? { onPrevChapter: () => cbRef.current.onPrevChapter?.() }
      : {}),
    ...(cbRef.current.onNextChapter !== undefined
      ? { onNextChapter: () => cbRef.current.onNextChapter?.() }
      : {}),
    onTogglePlayPause: p.togglePlayPause,
    onKeyEvent: p.handleKeyEvent,
  };
}
