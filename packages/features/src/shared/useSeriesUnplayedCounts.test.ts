import type { CatalogService, SeriesUnplayedSummary } from '@elv/data';
import { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { resolveSeriesBadgeProps, useSeriesUnplayedCounts } from './useSeriesUnplayedCounts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  catalog,
  keys,
  revision = 0,
  onValue,
}: {
  readonly catalog: CatalogService;
  readonly keys: readonly string[];
  readonly revision?: number;
  readonly onValue: (map: ReadonlyMap<string, SeriesUnplayedSummary>) => void;
}) {
  onValue(useSeriesUnplayedCounts(catalog, keys, revision));
  return null;
}

describe('resolveSeriesBadgeProps & useSeriesUnplayedCounts (#409)', () => {
  it('resolves series badge states across summary, progressWatched, and optimistic watchedOverride', () => {
    const fmt = (count: number) => `${count} unwatched`;
    const summary: SeriesUnplayedSummary = {
      seriesKey: 's:1',
      total: 10,
      unplayed: 3,
      watched: false,
    };
    const watchedSummary: SeriesUnplayedSummary = {
      seriesKey: 's:2',
      total: 10,
      unplayed: 0,
      watched: true,
    };

    expect(
      resolveSeriesBadgeProps({
        summary,
        progressWatched: false,
        watchedOverride: true,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({ allWatched: true, unplayedLabel: 'Watched' });

    expect(
      resolveSeriesBadgeProps({
        summary,
        progressWatched: true,
        watchedOverride: false,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({ unplayedCount: 3, unplayedLabel: '3 unwatched' });

    expect(
      resolveSeriesBadgeProps({
        summary: undefined,
        progressWatched: true,
        watchedOverride: false,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({});

    expect(
      resolveSeriesBadgeProps({
        summary,
        progressWatched: false,
        watchedOverride: undefined,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({ unplayedCount: 3, unplayedLabel: '3 unwatched' });

    expect(
      resolveSeriesBadgeProps({
        summary: watchedSummary,
        progressWatched: false,
        watchedOverride: undefined,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({ allWatched: true, unplayedLabel: 'Watched' });

    expect(
      resolveSeriesBadgeProps({
        summary: { seriesKey: 's:3', total: 0, unplayed: 0, watched: false },
        progressWatched: false,
        watchedOverride: undefined,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({});

    expect(
      resolveSeriesBadgeProps({
        summary: undefined,
        progressWatched: true,
        watchedOverride: undefined,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({ allWatched: true, unplayedLabel: 'Watched' });

    expect(
      resolveSeriesBadgeProps({
        summary: undefined,
        progressWatched: false,
        watchedOverride: undefined,
        formatUnplayed: fmt,
        watchedLabel: 'Watched',
      }),
    ).toEqual({});
  });

  it('deduplicates keys, chunks requests to <= 200, handles rejections, and returns empty when unsupported', async () => {
    const listSeriesUnplayedCounts = vi.fn(async (chunk: readonly string[]) =>
      chunk.slice(0, 1).map((seriesKey) => ({ seriesKey, total: 5, unplayed: 2, watched: false })),
    );
    const catalog = { listSeriesUnplayedCounts } as unknown as CatalogService;
    let latest: ReadonlyMap<string, SeriesUnplayedSummary> = new Map();

    const manyKeys = Array.from({ length: 205 }, (_, i) => `x:s1:series:${i}`);
    const root = createRoot();
    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog,
          keys: ['', '  ', ...manyKeys, manyKeys[0] ?? ''],
          onValue: (v) => {
            latest = v;
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listSeriesUnplayedCounts).toHaveBeenCalledTimes(2);
    expect(listSeriesUnplayedCounts.mock.calls[0]?.[0]).toHaveLength(200);
    expect(listSeriesUnplayedCounts.mock.calls[1]?.[0]).toHaveLength(5);
    expect(latest.size).toBe(2);

    // Re-rendering with empty keys clears map
    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog,
          keys: [],
          onValue: (v) => {
            latest = v;
          },
        }),
      );
      await Promise.resolve();
    });
    expect(latest.size).toBe(0);

    // Rejecting catalog method degrades cleanly to empty map
    const failingCatalog = {
      listSeriesUnplayedCounts: vi.fn(async () => {
        throw new Error('db-error');
      }),
    } as unknown as CatalogService;
    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog: failingCatalog,
          keys: ['x:s1:series:1'],
          onValue: (v) => {
            latest = v;
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.size).toBe(0);

    act(() => {
      root.unmount();
    });
  });
});
