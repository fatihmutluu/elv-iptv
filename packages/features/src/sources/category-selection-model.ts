import type { BrowseKind, DiscoveredCategory, SourceCategorySelection } from '@elv/data';

/** Builds a stable composite key for a discovered category across kinds. */
export function discoveredCategoryKey(kind: BrowseKind, id: string): string {
  return `${kind}:${id}`;
}

/** Counts total pending new categories across live, movie, and series kinds (`#39`). */
export function countPendingCategories(selection: SourceCategorySelection | undefined): number {
  if (selection === undefined) return 0;
  return (
    (selection.pendingLive?.length ?? 0) +
    (selection.pendingMovie?.length ?? 0) +
    (selection.pendingSeries?.length ?? 0)
  );
}

/** Merges any `pending*` category IDs into the active allowlists and clears pending queues (`#39`). */
export function mergePendingCategories(
  selection: SourceCategorySelection,
): SourceCategorySelection {
  const merge = (
    selected: readonly string[] | undefined,
    pending: readonly string[] | undefined,
  ): readonly string[] | undefined => {
    if (pending === undefined || pending.length === 0) return selected;
    return [...new Set([...(selected ?? []), ...pending])];
  };
  const next: {
    live?: readonly string[];
    movie?: readonly string[];
    series?: readonly string[];
    knownLive?: readonly string[];
    knownMovie?: readonly string[];
    knownSeries?: readonly string[];
  } = {
    ...(selection.knownLive !== undefined ? { knownLive: selection.knownLive } : {}),
    ...(selection.knownMovie !== undefined ? { knownMovie: selection.knownMovie } : {}),
    ...(selection.knownSeries !== undefined ? { knownSeries: selection.knownSeries } : {}),
  };
  const live = merge(selection.live, selection.pendingLive);
  const movie = merge(selection.movie, selection.pendingMovie);
  const series = merge(selection.series, selection.pendingSeries);
  if (live !== undefined) next.live = live;
  if (movie !== undefined) next.movie = movie;
  if (series !== undefined) next.series = series;
  return next;
}

/** Dismisses pending new categories while preserving existing allowlists and known sets (`#39`). */
export function clearPendingCategories(
  selection: SourceCategorySelection,
): SourceCategorySelection {
  return {
    ...(selection.live !== undefined ? { live: selection.live } : {}),
    ...(selection.movie !== undefined ? { movie: selection.movie } : {}),
    ...(selection.series !== undefined ? { series: selection.series } : {}),
    ...(selection.knownLive !== undefined ? { knownLive: selection.knownLive } : {}),
    ...(selection.knownMovie !== undefined ? { knownMovie: selection.knownMovie } : {}),
    ...(selection.knownSeries !== undefined ? { knownSeries: selection.knownSeries } : {}),
  };
}

/** Converts discovered categories + user-selected composite keys into a `SourceCategorySelection`. */
export function buildCategorySelection(
  categories: readonly DiscoveredCategory[],
  selectedKeys: ReadonlySet<string>,
): SourceCategorySelection {
  const byKind: Record<BrowseKind, string[]> = { live: [], movie: [], series: [] };
  const knownByKind: Record<BrowseKind, string[]> = { live: [], movie: [], series: [] };
  const hasKind: Record<BrowseKind, boolean> = { live: false, movie: false, series: false };

  for (const cat of categories) {
    hasKind[cat.kind] = true;
    knownByKind[cat.kind].push(cat.id);
    if (selectedKeys.has(discoveredCategoryKey(cat.kind, cat.id))) {
      byKind[cat.kind].push(cat.id);
    }
  }

  return {
    ...(hasKind.live ? { live: byKind.live, knownLive: knownByKind.live } : {}),
    ...(hasKind.movie ? { movie: byKind.movie, knownMovie: knownByKind.movie } : {}),
    ...(hasKind.series ? { series: byKind.series, knownSeries: knownByKind.series } : {}),
  };
}

/** Computes the initial selected composite keys for a source's discovered categories. */
export function initialSelectedCategoryKeys(
  categories: readonly DiscoveredCategory[],
  existing: SourceCategorySelection | undefined,
): Set<string> {
  const selected = new Set<string>();
  const existingByKind: Record<BrowseKind, ReadonlySet<string> | undefined> = {
    live: existing?.live ? new Set(existing.live) : undefined,
    movie: existing?.movie ? new Set(existing.movie) : undefined,
    series: existing?.series ? new Set(existing.series) : undefined,
  };
  for (const cat of categories) {
    const allow = existingByKind[cat.kind];
    if (allow === undefined || allow.has(cat.id)) {
      selected.add(discoveredCategoryKey(cat.kind, cat.id));
    }
  }
  return selected;
}
