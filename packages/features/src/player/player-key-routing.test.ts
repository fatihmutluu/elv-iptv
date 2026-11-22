import type { KeyEvent } from '@elv/focus-core';
import type { MediaTracks } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  type HostKeyRouteDeps,
  type OverlayKeyRouteDeps,
  routeHostKey,
  routeOverlayAndMediaKey,
} from './player-key-routing';
import type { PlayerOverlayLive } from './player-overlay-model';

const EMPTY_TRACKS: MediaTracks = {
  audio: [],
  subtitles: [],
  selectedAudioId: null,
  selectedSubtitleId: null,
};

function makeHostDeps(overrides: Partial<HostKeyRouteDeps> = {}): HostKeyRouteDeps {
  return {
    isVod: true,
    state: {
      locked: false,
      tracksOpen: false,
      settingsOpen: false,
      infoOpen: false,
      channelListOpen: false,
    },
    handleBack: vi.fn(),
    toggleFullscreen: vi.fn(),
    toggleResizeMode: vi.fn(),
    togglePlayPause: vi.fn(),
    seekBy: vi.fn(),
    stepVolumeBy: vi.fn(),
    toggleMute: vi.fn(),
    openTracks: vi.fn(),
    closeTracks: vi.fn(),
    zapBy: vi.fn(),
    ...overrides,
  };
}

describe('routeHostKey Wave P5 shortcuts (#415)', () => {
  it('routes aspect, volume-up, and volume-down when shortcuts are allowed', () => {
    const deps = makeHostDeps();
    routeHostKey('aspect', deps);
    routeHostKey('volume-up', deps);
    routeHostKey('volume-down', deps);

    expect(deps.toggleResizeMode).toHaveBeenCalledTimes(1);
    expect(deps.stepVolumeBy).toHaveBeenNthCalledWith(1, 5);
    expect(deps.stepVolumeBy).toHaveBeenNthCalledWith(2, -5);
  });

  it('ignores aspect and volume host keys when locked or a sheet is open', () => {
    const lockedDeps = makeHostDeps({
      state: {
        locked: true,
        tracksOpen: false,
        settingsOpen: false,
        infoOpen: false,
        channelListOpen: false,
      },
    });
    routeHostKey('aspect', lockedDeps);
    routeHostKey('volume-up', lockedDeps);
    routeHostKey('volume-down', lockedDeps);
    expect(lockedDeps.toggleResizeMode).not.toHaveBeenCalled();
    expect(lockedDeps.stepVolumeBy).not.toHaveBeenCalled();

    const sheetDeps = makeHostDeps({
      state: {
        locked: false,
        tracksOpen: false,
        settingsOpen: true,
        infoOpen: false,
        channelListOpen: false,
      },
    });
    routeHostKey('aspect', sheetDeps);
    routeHostKey('volume-up', sheetDeps);
    routeHostKey('volume-down', sheetDeps);
    expect(sheetDeps.toggleResizeMode).not.toHaveBeenCalled();
    expect(sheetDeps.stepVolumeBy).not.toHaveBeenCalled();
  });
});

describe('routeOverlayAndMediaKey videoDecoder submenu (#411)', () => {
  it('routes select inside videoDecoder settings view to selectAndroidDecoderMode', () => {
    const selectAndroidDecoderMode = vi.fn();
    const state: PlayerOverlayLive = {
      tracksOpen: false,
      pickerCursor: { column: 'audio', index: 0 },
      settingsOpen: true,
      settingsMenu: { view: 'videoDecoder', index: 2 },
      infoOpen: false,
      channelListOpen: false,
      canOpenInfo: true,
      canOpenChannelList: false,
      locked: false,
      osdTier: 'controls',
      osdHidden: false,
      tvOsdFocused: false,
      tvScrubberFocused: false,
      tvOsdAction: 'settings',
      availableOsd: ['settings'],
      tracks: EMPTY_TRACKS,
      hasTracks: false,
      hasService: true,
      isVod: false,
      playbackSpeed: 1,
    };
    const deps: OverlayKeyRouteDeps = {
      isTv: true,
      isVod: false,
      hasAspect: true,
      hasVideoDecoder: true,
      androidDecoderMode: 'auto',
      playbackSpeed: 1,
      state,
      service: null,
      scrub: {
        previewPositionMs: undefined,
        step: vi.fn(),
        commit: vi.fn(),
        cancel: vi.fn(),
      },
      digitBuf: { push: vi.fn(), cancel: vi.fn(), value: '' },
      allowTvSelect: () => true,
      showOsd: vi.fn(),
      toggleStats: vi.fn(),
      toggleResizeMode: vi.fn(),
      togglePlayPause: vi.fn(),
      openTracks: vi.fn(),
      closeTracks: vi.fn(),
      closeSettings: vi.fn(),
      updateSettingsMenu: vi.fn(),
      updatePickerCursor: vi.fn(),
      focusTvOsd: vi.fn(),
      blurTvOsd: vi.fn(),
      focusTvScrubber: vi.fn(),
      blurTvScrubber: vi.fn(),
      activateTvOsd: vi.fn(),
      selectSpeed: vi.fn(),
      selectAndroidDecoderMode,
      onExit: vi.fn(),
    };

    const event: KeyEvent = { key: 'select', kind: 'press', time: 100 };
    expect(routeOverlayAndMediaKey(event, deps)).toBe(true);
    expect(selectAndroidDecoderMode).toHaveBeenCalledWith('software');
  });
});
