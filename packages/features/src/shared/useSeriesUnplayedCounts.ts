import type { CatalogService, SeriesUnplayedSummary } from '@elv/data';
import { useEffect, useMemo, useState } from 'react';

const EMPTY_UNPLAYED_MAP: ReadonlyMap<string, SeriesUnplayedSummary> = new Map();
const MAX_BATCH_KEYS = 200;

/** Resolved badge props for a series {@link PosterCard}. */
export interface SeriesBadgeProps {
  readonly unplayedCount?: number;
  readonly allWatched?: boolean;
  readonly unplayedLabel?: string;
}

/**
 * Resolves `unplayedCount`, `allWatched`, and localized `unplayedLabel` for a series card (`#409`).
 * Honors explicit optimistic `watchedOverride` ahead of persisted progress/unplayed counts.
 */
export function resolveSeriesBadgeProps(options: {
  readonly summary: SeriesUnplayedSummary | undefined;
  readonly progressWatched: boolean;
  readonly watchedOverride: boolean | undefined;
  readonly formatUnplayed: (count: number) => string;
  readonly watchedLabel: string;
}): SeriesBadgeProps {
  const { summary, progressWatched, watchedOverride, formatUnplayed, watchedLabel } = options;
  if (watchedOverride === true) {
    return { allWatched: true, unplayedLabel: watchedLabel };
  }
  if (watchedOverride === false) {
    if (summary && summary.unplayed > 0) {
      return { unplayedCount: summary.unplayed, unplayedLabel: formatUnplayed(summary.unplayed) };
    }
    return {};
  }
  if (summary !== undefined) {
    if (summary.unplayed > 0 && !progressWatched) {
      return { unplayedCount: summary.unplayed, unplayedLabel: formatUnplayed(summary.unplayed) };
    }
    if (summary.watched || progressWatched) {
      return { allWatched: true, unplayedLabel: watchedLabel };
    }
    return {};
  }
  if (progressWatched) {
    return { allWatched: true, unplayedLabel: watchedLabel };
  }
  return {};
}

/**
 * Batched loader for series unplayed episode summaries (`#409`).
 * Deduplicates keys, chunks requests to <= 200 keys, cancels stale reads on unmount/change,
 * and returns an empty map when `catalog.listSeriesUnplayedCounts` is not provided.
 */
export function useSeriesUnplayedCounts(
  catalog: CatalogService,
  seriesKeys: readonly string[],
  revision = 0,
): ReadonlyMap<string, SeriesUnplayedSummary> {
  const uniqueKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const key of seriesKeys) {
      if (key.trim() === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    out.sort();
    return out;
  }, [seriesKeys]);

  const signature = useMemo(() => uniqueKeys.join('\u0000'), [uniqueKeys]);
  const [byKey, setByKey] =
    useState<ReadonlyMap<string, SeriesUnplayedSummary>>(EMPTY_UNPLAYED_MAP);

  // biome-ignore lint/correctness/useExhaustiveDependencies: signature uniquely identifies uniqueKeys; revision triggers refresh
  useEffect(() => {
    if (uniqueKeys.length === 0 || !catalog.listSeriesUnplayedCounts) {
      setByKey(EMPTY_UNPLAYED_MAP);
      return undefined;
    }

    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueKeys.length; i += MAX_BATCH_KEYS) {
      chunks.push(uniqueKeys.slice(i, i + MAX_BATCH_KEYS));
    }

    void Promise.all(
      chunks.map(
        (chunk) =>
          catalog.listSeriesUnplayedCounts?.(chunk).catch(() => [] as SeriesUnplayedSummary[]) ??
          Promise.resolve([] as SeriesUnplayedSummary[]),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, SeriesUnplayedSummary>();
      for (const list of results) {
        for (const entry of list) {
          next.set(entry.seriesKey, entry);
        }
      }
      setByKey(next);
    });

    return () => {
      cancelled = true;
    };
  }, [catalog, signature, revision]);

  return byKey;
}
