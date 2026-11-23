import type { CatalogKind } from './runs';
import type { SourceCategorySelection } from './sources';

const KINDS: readonly CatalogKind[] = ['live', 'movie', 'series'];

const KNOWN_KEY: Readonly<Record<CatalogKind, 'knownLive' | 'knownMovie' | 'knownSeries'>> = {
  live: 'knownLive',
  movie: 'knownMovie',
  series: 'knownSeries',
};

const PENDING_KEY: Readonly<Record<CatalogKind, 'pendingLive' | 'pendingMovie' | 'pendingSeries'>> =
  {
    live: 'pendingLive',
    movie: 'pendingMovie',
    series: 'pendingSeries',
  };

/** Returns the active allowlist Set for `kind`, or `undefined` when unfiltered. */
export function allowlistForKind(
  selection: SourceCategorySelection | undefined,
  kind: CatalogKind,
): ReadonlySet<string> | undefined {
  const list = selection?.[kind];
  return list === undefined ? undefined : new Set(list);
}

/**
 * Reconciles `SourceCategorySelection` after a catalog scan (`#39`):
 * - First filtered run (`known*` absent): initializes `known*` with all discovered IDs so initially
 *   unselected categories are not immediately flagged as pending.
 * - Subsequent refreshes (`known*` present): appends any newly appearing category IDs that are neither
 *   known nor selected into `pending*` instead of importing them silently, and expands `known*`.
 */
export function reconcileCategorySelection(
  existing: SourceCategorySelection | undefined,
  discovered: Readonly<Record<CatalogKind, readonly string[]>>,
): SourceCategorySelection | undefined {
  if (existing === undefined) return undefined;
  const next: {
    live?: readonly string[];
    movie?: readonly string[];
    series?: readonly string[];
    knownLive?: readonly string[];
    knownMovie?: readonly string[];
    knownSeries?: readonly string[];
    pendingLive?: readonly string[];
    pendingMovie?: readonly string[];
    pendingSeries?: readonly string[];
  } = { ...existing };

  for (const kind of KINDS) {
    const selected = existing[kind];
    if (selected === undefined) continue;
    const knownKey = KNOWN_KEY[kind];
    const pendingKey = PENDING_KEY[kind];
    const seen = [...new Set(discovered[kind])];
    const selectedSet = new Set(selected);
    const prevKnown = existing[knownKey];

    if (prevKnown === undefined) {
      const mergedKnown = new Set<string>(selected);
      for (const id of seen) mergedKnown.add(id);
      next[knownKey] = [...mergedKnown];
      if (existing[pendingKey] !== undefined) {
        const cleaned = existing[pendingKey].filter((id) => !selectedSet.has(id));
        if (cleaned.length > 0) next[pendingKey] = cleaned;
        else delete next[pendingKey];
      }
      continue;
    }

    const knownSet = new Set<string>(prevKnown);
    const pendingSet = new Set<string>(
      (existing[pendingKey] ?? []).filter((id) => !selectedSet.has(id)),
    );
    for (const id of seen) {
      if (!knownSet.has(id) && !selectedSet.has(id)) {
        pendingSet.add(id);
      }
      knownSet.add(id);
    }
    next[knownKey] = [...knownSet];
    if (pendingSet.size > 0) next[pendingKey] = [...pendingSet];
    else delete next[pendingKey];
  }

  return next;
}
