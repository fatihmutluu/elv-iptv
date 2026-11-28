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
      settingsOpen: false,
      settingsMenu: { view: 'root', index: 0 },
      windowModeOpen: false,
      channelListOpen: false,
    },
    handleBack: vi.fn(),
    toggleFullscreen: vi.fn(),
    toggleResizeMode: vi.fn(),
    togglePlayPause: vi.fn(),
    seekBy: vi.fn(),
    stepVolumeBy: vi.fn(),
    toggleMute: vi.fn(),
    openSubtitles: vi.fn(),
    closeSettings: vi.fn(),
    toggleStats: vi.fn(),
    zapBy: vi.fn(),
    ...overrides,
  };
}

describe('routeHostKey Wave P5 & Wave R4 shortcuts (#415)', () => {
  it('routes aspect, volume-up, volume-down, tracks, and info when shortcuts are allowed', () => {
    const deps = makeHostDeps();
    routeHostKey('aspect', deps);
    routeHostKey('volume-up', deps);
    routeHostKey('volume-down', deps);
    routeHostKey('tracks', deps);
    routeHostKey('info', deps);

    expect(deps.toggleResizeMode).toHaveBeenCalledTimes(1);
    expect(deps.stepVolumeBy).toHaveBeenNthCalledWith(1, 5);
    expect(deps.stepVolumeBy).toHaveBeenNthCalledWith(2, -5);
    expect(deps.openSubtitles).toHaveBeenCalledTimes(1);
    expect(deps.toggleStats).toHaveBeenCalledTimes(1);
  });

  it('toggles subtitles sheet closed when host key tracks fires on subtitle view', () => {
    const deps = makeHostDeps({
      state: {
        locked: false,
        settingsOpen: true,
        settingsMenu: { view: 'subtitles', index: 0 },
        windowModeOpen: false,
        channelListOpen: false,
      },
    });
    routeHostKey('tracks', deps);
    expect(deps.closeSettings).toHaveBeenCalledTimes(1);
  });

  it('ignores aspect and volume host keys when locked or a sheet/popover is open', () => {
    const lockedDeps = makeHostDeps({
      state: {
        locked: true,
        settingsOpen: false,
        settingsMenu: { view: 'root', index: 0 },
        windowModeOpen: false,
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
        settingsOpen: false,
        settingsMenu: { view: 'root', index: 0 },
        windowModeOpen: true,
        channelListOpen: false,
      },
    });
    routeHostKey('aspect', sheetDeps);
    routeHostKey('volume-up', sheetDeps);
    routeHostKey('volume-down', sheetDeps);
    expect(sheetDeps.toggleResizeMode).not.toHaveBeenCalled();
    expect(sheetDeps.stepVolumeBy).not.toHaveBeenCalled();
  });

  it('routes stop host key unconditionally even when locked or a sheet is open (#412)', () => {
    const onStop = vi.fn();
    const lockedSheetDeps = makeHostDeps({
      state: {
        locked: true,
        settingsOpen: true,
        settingsMenu: { view: 'root', index: 0 },
        windowModeOpen: false,
        channelListOpen: false,
      },
      onStop,
    });
    routeHostKey('stop', lockedSheetDeps);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('routeOverlayAndMediaKey submenus & Wave R4 controls', () => {
  it('routes select inside videoDecoder settings view to selectAndroidDecoderMode', () => {
    const selectAndroidDecoderMode = vi.fn();
    const state: PlayerOverlayLive = {
      settingsOpen: true,
      settingsMenu: { view: 'videoDecoder', index: 2 },
      windowModeOpen: false,
      channelListOpen: false,
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
      closeSettings: vi.fn(),
      updateSettingsMenu: vi.fn(),
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

  it('aligns default menu, colorRed/colorGreen (subtitles/audio in Settings), colorBlue, colorYellow, and info', () => {
    const order: string[] = [];
    const cancel = vi.fn(() => {
      order.push('cancel');
    });
    const toggleChannelList = vi.fn(() => {
      order.push('toggleChannelList');
    });
    const openSettings = vi.fn();
    const toggleMute = vi.fn();
    const toggleStats = vi.fn();
    const state: PlayerOverlayLive = {
      settingsOpen: false,
      settingsMenu: { view: 'root', index: 0 },
      windowModeOpen: false,
      channelListOpen: false,
      canOpenChannelList: true,
      locked: false,
      osdTier: 'controls',
      osdHidden: false,
      tvOsdFocused: false,
      tvScrubberFocused: false,
      tvOsdAction: 'settings',
      availableOsd: ['settings'],
      tracks: EMPTY_TRACKS,
      hasTracks: true,
      hasService: true,
      isVod: false,
      playbackSpeed: 1,
    };
    const deps: OverlayKeyRouteDeps = {
      isTv: true,
      isVod: false,
      hasAspect: true,
      playbackSpeed: 1,
      state,
      service: null,
      scrub: {
        previewPositionMs: undefined,
        step: vi.fn(),
        commit: vi.fn(),
        cancel: vi.fn(),
      },
      digitBuf: { push: vi.fn(), cancel, value: '12' },
      allowTvSelect: () => true,
      showOsd: vi.fn(),
      toggleStats,
      toggleResizeMode: vi.fn(),
      togglePlayPause: vi.fn(),
      openSettings,
      closeSettings: vi.fn(),
      toggleChannelList,
      toggleMute,
      updateSettingsMenu: vi.fn(),
      focusTvOsd: vi.fn(),
      blurTvOsd: vi.fn(),
      focusTvScrubber: vi.fn(),
      blurTvScrubber: vi.fn(),
      activateTvOsd: vi.fn(),
      selectSpeed: vi.fn(),
      onExit: vi.fn(),
    };

    expect(routeOverlayAndMediaKey({ key: 'menu', kind: 'press', time: 200 }, deps)).toBe(true);
    expect(order).toEqual(['cancel', 'toggleChannelList']);

    expect(routeOverlayAndMediaKey({ key: 'colorRed', kind: 'press', time: 205 }, deps)).toBe(true);
    expect(openSettings).toHaveBeenLastCalledWith('subtitles');

    expect(routeOverlayAndMediaKey({ key: 'colorGreen', kind: 'press', time: 206 }, deps)).toBe(
      true,
    );
    expect(openSettings).toHaveBeenLastCalledWith('audio');

    expect(routeOverlayAndMediaKey({ key: 'colorBlue', kind: 'press', time: 210 }, deps)).toBe(
      true,
    );
    expect(openSettings).toHaveBeenCalledTimes(3);

    expect(routeOverlayAndMediaKey({ key: 'colorYellow', kind: 'press', time: 220 }, deps)).toBe(
      true,
    );
    expect(toggleMute).toHaveBeenCalledTimes(1);

    expect(routeOverlayAndMediaKey({ key: 'info', kind: 'press', time: 230 }, deps)).toBe(true);
    expect(toggleStats).toHaveBeenCalledTimes(1);
  });
});
