import type { ClockAnchor } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import type { PlayableEntry } from '../ports/play-target';
import {
  computeLiveTimeShiftTargetMs,
  readLiveTimeShiftSnapshot,
  sameLiveTimeShiftSnapshot,
  shouldShowLiveJumpToLive,
  targetIdentityKey,
} from './live-timeshift-model';
import { routeHostKey, routeOverlayAndMediaKey } from './player-key-routing';
import type { PlayerOverlayLive } from './player-overlay-model';
import { availableTvOsdActions } from './tv-osd-nav';
import { resolveVodStartPositionMs } from './useWatchProgressSync';

describe('live-timeshift-model & catch-up player helpers', () => {
  it('derives bounded live time-shift snapshots for live edge, behind live, paused, and unsupported anchors', () => {
    const unsupported = readLiveTimeShiftSnapshot(undefined, 10_000, false);
    expect(unsupported.supported).toBe(false);
    expect(unsupported.showJumpToLive).toBe(false);

    const anchorBehind: ClockAnchor = {
      positionMs: 100_000,
      atMs: 5_000,
      rate: 1,
      liveSeekableStartMs: 0,
      liveEdgeMs: 234_000,
      timeShiftSupported: true,
    };
    const snap = readLiveTimeShiftSnapshot(anchorBehind, 5_000, false);
    expect(snap.supported).toBe(true);
    expect(snap.isBehindLive).toBe(true);
    expect(snap.offsetText).toBe('-02:14');
    expect(snap.showJumpToLive).toBe(true);
    expect(snap.fillPercent).toBeGreaterThan(40);
    expect(snap.fillPercent).toBeLessThan(45);
    expect(sameLiveTimeShiftSnapshot(snap, { ...snap })).toBe(true);

    const anchorAtEdge: ClockAnchor = {
      positionMs: 233_500,
      atMs: 5_000,
      rate: 1,
      liveSeekableStartMs: 0,
      liveEdgeMs: 234_000,
      timeShiftSupported: true,
    };
    const atEdge = readLiveTimeShiftSnapshot(anchorAtEdge, 5_000, false);
    expect(atEdge.supported).toBe(true);
    expect(atEdge.isBehindLive).toBe(false);
    expect(atEdge.showJumpToLive).toBe(false);

    // Paused at live edge still surfaces Jump to live
    const paused = readLiveTimeShiftSnapshot(anchorAtEdge, 5_000, true);
    expect(paused.isPaused).toBe(true);
    expect(paused.showJumpToLive).toBe(true);
    expect(sameLiveTimeShiftSnapshot(atEdge, paused)).toBe(false);
  });

  it('maps scrubber ratios inside [liveSeekableStartMs, liveEdgeMs] and checks jump-to-live visibility', () => {
    const anchor: ClockAnchor = {
      positionMs: 150_000,
      atMs: 1_000,
      rate: 1,
      liveSeekableStartMs: 100_000,
      liveEdgeMs: 300_000,
      timeShiftSupported: true,
    };
    expect(computeLiveTimeShiftTargetMs(anchor, 1_000, 0)).toBe(100_000);
    expect(computeLiveTimeShiftTargetMs(anchor, 1_000, 0.5)).toBe(200_000);
    expect(computeLiveTimeShiftTargetMs(anchor, 1_000, 1.5)).toBe(300_000);
    expect(computeLiveTimeShiftTargetMs(anchor, 1_000, Number.NaN)).toBeUndefined();
    expect(computeLiveTimeShiftTargetMs(undefined, 1_000, 0.5)).toBeUndefined();

    expect(shouldShowLiveJumpToLive(anchor, 1_000, false)).toBe(true);
    expect(
      shouldShowLiveJumpToLive(
        {
          positionMs: 292_000,
          atMs: 1_000,
          rate: 1,
          liveSeekableStartMs: 100_000,
          liveEdgeMs: 300_000,
          timeShiftSupported: true,
        },
        1_000,
        false,
      ),
    ).toBe(false);
    // Keeping button visible while jumpingToLive on a seekable stream at live edge
    expect(
      shouldShowLiveJumpToLive(
        {
          positionMs: 300_000,
          atMs: 1_000,
          rate: 1,
          liveSeekableStartMs: 100_000,
          liveEdgeMs: 300_000,
          timeShiftSupported: true,
        },
        1_000,
        false,
        { jumpingToLive: true },
      ),
    ).toBe(true);
    // Non-seekable stream NEVER shows Jump to live even when paused or jumpingToLive
    expect(
      shouldShowLiveJumpToLive(
        {
          positionMs: 10_000,
          atMs: 1_000,
          rate: 0,
          liveEdgeMs: 60_000,
          timeShiftSupported: false,
        },
        1_000,
        true,
        { jumpingToLive: true },
      ),
    ).toBe(false);
    // Legacy MPEG-TS lag fallback: healthy 10s readahead is hidden; > 15s lag or paused with >15s edge shows
    expect(
      shouldShowLiveJumpToLive(
        { positionMs: 20_000, atMs: 1_000, rate: 1, liveEdgeMs: 30_000, isLiveTs: true },
        1_000,
        false,
      ),
    ).toBe(false);
    expect(
      shouldShowLiveJumpToLive(
        { positionMs: 10_000, atMs: 1_000, rate: 1, liveEdgeMs: 30_000, isLiveTs: true },
        1_000,
        false,
      ),
    ).toBe(true);
    expect(
      shouldShowLiveJumpToLive(
        { positionMs: 5_000, atMs: 1_000, rate: 0, liveEdgeMs: 15_000, isLiveTs: true },
        1_000,
        true,
      ),
    ).toBe(false);
    expect(
      shouldShowLiveJumpToLive(
        { positionMs: 25_000, atMs: 1_000, rate: 0, liveEdgeMs: 30_000, isLiveTs: true },
        1_000,
        true,
      ),
    ).toBe(true);
  });

  it('distinguishes catch-up and live identities on the same channel and skips VOD watch_progress lookup for catch-up', () => {
    const liveEntry: PlayableEntry = {
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      title: 'Channel 1',
      kind: 'live',
    };
    const catchupEntry: PlayableEntry = {
      ...liveEntry,
      kind: 'vod',
      title: 'Past Show',
      catchup: {
        startMs: 1_000,
        stopMs: 2_000,
        programmeTitle: 'Past Show',
        liveTarget: liveEntry,
      },
    };
    expect(targetIdentityKey(catchupEntry)).not.toBe(targetIdentityKey(liveEntry));

    const getProgress = vi.fn(async () => ({
      profileId: 'default',
      sourceId: 's1',
      itemKey: 'x:s1:live:1',
      kind: 'live' as const,
      title: 'Past Show',
      subtitle: null,
      logo: null,
      seriesKey: null,
      season: null,
      episode: null,
      positionMs: 50_000,
      durationMs: 100_000,
      watched: false,
      updatedAt: 1,
    }));
    expect(resolveVodStartPositionMs(catchupEntry, { getProgress })).toBeUndefined();
    expect(getProgress).not.toHaveBeenCalled();
  });

  it('exposes TV OSD actions for backToLive, jumpToLive, and live time-shift seek controls', () => {
    const catchupActions = availableTvOsdActions({
      isVod: true,
      hasService: true,
      hasSubtitles: false,
      hasAudio: false,
      showRetry: false,
      hasBackToLive: true,
    });
    expect(catchupActions).toContain('backToLive');
    expect(catchupActions).toContain('seekBack');
    expect(catchupActions).toContain('seekForward');

    const liveTsActions = availableTvOsdActions({
      isVod: false,
      hasService: true,
      hasSubtitles: false,
      hasAudio: false,
      showRetry: false,
      liveTimeShiftSupported: true,
      hasJumpToLive: true,
    });
    expect(liveTsActions).toContain('seekBack');
    expect(liveTsActions).toContain('playPause');
    expect(liveTsActions).toContain('seekForward');
    expect(liveTsActions).toContain('jumpToLive');
  });

  it('surfaces raw MPEG-TS lag > 15s in readLiveTimeShiftSnapshot and routes live time-shift keys (#8, #19)', () => {
    const rawTsLag = readLiveTimeShiftSnapshot(
      { positionMs: 10_000, atMs: 1_000, rate: 1, liveEdgeMs: 30_000, isLiveTs: true },
      1_000,
      false,
    );
    expect(rawTsLag.supported).toBe(false);
    expect(rawTsLag.showJumpToLive).toBe(true);

    // routeHostKey allows seek-back/seek-forward/coarse seek on live when liveTimeShiftSupported is true
    const seekBy = vi.fn();
    const baseState = {
      locked: false,
      settingsOpen: false,
      settingsMenu: { view: 'root' as const, index: 0 },
      windowModeOpen: false,
      channelListOpen: false,
    };
    const hostDeps = {
      isVod: false,
      liveTimeShiftSupported: true,
      state: baseState,
      handleBack: vi.fn(),
      toggleFullscreen: vi.fn(),
      togglePlayPause: vi.fn(),
      seekBy,
      stepSeekMs: 10_000,
      openSubtitles: vi.fn(),
      closeSettings: vi.fn(),
      zapBy: vi.fn(),
    };
    routeHostKey('seek-back', hostDeps);
    routeHostKey('seek-forward', hostDeps);
    routeHostKey('seek-coarse-back', hostDeps);
    routeHostKey('seek-coarse-forward', hostDeps);
    expect(seekBy).toHaveBeenNthCalledWith(1, -10_000);
    expect(seekBy).toHaveBeenNthCalledWith(2, 10_000);
    expect(seekBy).toHaveBeenNthCalledWith(3, -30_000);
    expect(seekBy).toHaveBeenNthCalledWith(4, 30_000);

    // routeOverlayAndMediaKey focuses TV scrubber on Up from OSD and seeks live window on Left/Right
    const focusTvScrubber = vi.fn();
    const liveSeek = vi.fn();
    const overlayState: PlayerOverlayLive = {
      settingsOpen: false,
      settingsMenu: { view: 'root', index: 0 },
      windowModeOpen: false,
      channelListOpen: false,
      canOpenChannelList: false,
      locked: false,
      osdTier: 'controls',
      osdHidden: false,
      tvOsdFocused: true,
      tvScrubberFocused: false,
      tvOsdAction: 'playPause',
      availableOsd: ['back', 'seekBack', 'playPause', 'seekForward'],
      tracks: { audio: [], subtitles: [], selectedAudioId: null, selectedSubtitleId: null },
      hasTracks: false,
      hasService: true,
      isVod: false,
      playbackSpeed: 1,
    };
    const commonDeps = {
      isTv: true,
      isVod: false,
      liveTimeShiftSupported: true,
      hasAspect: true,
      playbackSpeed: 1,
      state: overlayState,
      service: null,
      scrub: {
        previewPositionMs: undefined,
        step: vi.fn(),
        commit: vi.fn(),
        cancel: vi.fn(),
      },
      digitBuf: { push: vi.fn(), cancel: vi.fn(), commit: vi.fn() } as never,
      allowTvSelect: () => true,
      showOsd: vi.fn(),
      toggleStats: vi.fn(),
      toggleResizeMode: vi.fn(),
      togglePlayPause: vi.fn(),
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      updateSettingsMenu: vi.fn(),
      focusTvOsd: vi.fn(),
      blurTvOsd: vi.fn(),
      focusTvScrubber,
      blurTvScrubber: vi.fn(),
      activateTvOsd: vi.fn(),
      selectSpeed: vi.fn(),
      onExit: vi.fn(),
      seekBy: liveSeek,
      stepSeekMs: 10_000,
    };
    routeOverlayAndMediaKey({ key: 'up', kind: 'press', time: 1 }, commonDeps);
    expect(focusTvScrubber).toHaveBeenCalledTimes(1);

    routeOverlayAndMediaKey(
      { key: 'left', kind: 'press', time: 2 },
      {
        ...commonDeps,
        state: { ...overlayState, tvOsdFocused: false, tvScrubberFocused: true },
      },
    );
    expect(liveSeek).toHaveBeenCalledWith(-10_000);
  });
});
