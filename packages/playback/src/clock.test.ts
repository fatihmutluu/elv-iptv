import { describe, expect, it } from 'vitest';
import { isAtLiveEdge, LIVE_EDGE_TOLERANCE_MS, positionAt } from './clock';

describe('positionAt', () => {
  it('advances by elapsed time times rate', () => {
    expect(positionAt({ positionMs: 1000, atMs: 500, rate: 1 }, 1500)).toBe(2000);
    expect(positionAt({ positionMs: 1000, atMs: 500, rate: 2 }, 1500)).toBe(3000);
  });

  it('holds still at rate 0', () => {
    expect(positionAt({ positionMs: 1000, atMs: 500, rate: 0 }, 9000)).toBe(1000);
  });

  it('clamps to the duration when known', () => {
    expect(positionAt({ positionMs: 1000, atMs: 0, rate: 1, durationMs: 1800 }, 5000)).toBe(1800);
  });

  it('never returns a negative position', () => {
    expect(positionAt({ positionMs: 100, atMs: 0, rate: -1 }, 5000)).toBe(0);
    expect(positionAt({ positionMs: 100, atMs: 1000, rate: 1 }, 0)).toBe(0);
  });
});

describe('isAtLiveEdge', () => {
  it('exports the 5-second default tolerance', () => {
    expect(LIVE_EDGE_TOLERANCE_MS).toBe(5_000);
  });

  it('returns false when anchor is undefined', () => {
    expect(isAtLiveEdge(undefined, 1000)).toBe(false);
  });

  it('returns true when anchor has no bounded liveEdgeMs', () => {
    expect(isAtLiveEdge({ positionMs: 12_000, atMs: 1000, rate: 1 }, 2000)).toBe(true);
  });

  it('keeps streams within the 5-second grace window at the live edge and flips at 5001 ms', () => {
    expect(
      isAtLiveEdge({ positionMs: 60_000, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000),
    ).toBe(true);
    expect(
      isAtLiveEdge({ positionMs: 58_000, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000),
    ).toBe(true);
    expect(
      isAtLiveEdge({ positionMs: 55_001, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000),
    ).toBe(true);
    expect(
      isAtLiveEdge({ positionMs: 55_000, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000),
    ).toBe(true);
    expect(
      isAtLiveEdge({ positionMs: 54_999, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000),
    ).toBe(false);
  });

  it('extrapolates position via positionAt and treats ahead-of-edge as at live edge', () => {
    expect(
      isAtLiveEdge({ positionMs: 52_000, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 4000),
    ).toBe(true);
    expect(
      isAtLiveEdge({ positionMs: 61_000, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000),
    ).toBe(true);
  });

  it('clamps negative tolerance to 0 and rejects non-finite liveEdgeMs', () => {
    expect(
      isAtLiveEdge({ positionMs: 59_999, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000, -500),
    ).toBe(false);
    expect(
      isAtLiveEdge({ positionMs: 60_000, atMs: 1000, rate: 1, liveEdgeMs: 60_000 }, 1000, -500),
    ).toBe(true);
    expect(
      isAtLiveEdge({ positionMs: 60_000, atMs: 1000, rate: 1, liveEdgeMs: Number.NaN }, 1000),
    ).toBe(false);
    expect(
      isAtLiveEdge(
        { positionMs: 60_000, atMs: 1000, rate: 1, liveEdgeMs: Number.POSITIVE_INFINITY },
        1000,
      ),
    ).toBe(false);
  });
});
