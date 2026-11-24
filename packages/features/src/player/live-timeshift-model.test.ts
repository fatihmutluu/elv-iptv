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
          positionMs: 299_500,
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
    // Legacy MPEG-TS lag fallback still works when timeShiftSupported is absent
    expect(
      shouldShowLiveJumpToLive(
        { positionMs: 10_000, atMs: 1_000, rate: 1, liveEdgeMs: 20_000, isLiveTs: true },
        1_000,
        false,
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
      hasTracks: false,
      showRetry: false,
      hasBackToLive: true,
    });
    expect(catchupActions).toContain('backToLive');
    expect(catchupActions).toContain('seekBack');
    expect(catchupActions).toContain('seekForward');

    const liveTsActions = availableTvOsdActions({
      isVod: false,
      hasService: true,
      hasTracks: false,
      showRetry: false,
      liveTimeShiftSupported: true,
      hasJumpToLive: true,
    });
    expect(liveTsActions).toContain('seekBack');
    expect(liveTsActions).toContain('playPause');
    expect(liveTsActions).toContain('seekForward');
    expect(liveTsActions).toContain('jumpToLive');
  });
});
