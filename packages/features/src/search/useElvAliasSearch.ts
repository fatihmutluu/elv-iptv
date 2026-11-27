import type { CatalogService, ItemRow, SearchScope } from '@elv/data';
import { useEffect, useRef, useState } from 'react';
import { SEARCH_DEBOUNCE_MS, sanitizeSearchQuery } from './search-model';

const ALIAS_SEARCH_LIMIT = 40;
const EMPTY_ROWS: readonly ItemRow[] = [];

/** Options for {@link useElvAliasSearch}. */
export interface UseElvAliasSearchOptions {
  readonly catalog: CatalogService;
  readonly query: string;
  readonly scope: SearchScope;
  readonly enabled: boolean;
  readonly refreshToken: number;
  /** Keys already returned by `catalog.search` for the active query so they are not re-hydrated. */
  readonly existingKeys?: ReadonlySet<string>;
}

/** Hydrated alias-matched movie and series rows returned by {@link useElvAliasSearch} (`#511`). */
export interface ElvAliasSearchState {
  readonly movies: readonly ItemRow[];
  readonly series: readonly ItemRow[];
  readonly searching: boolean;
}

/**
 * Queries `catalog.searchElvItemKeysByAlias` in parallel with `useCatalogSearch` when ELV Mode
 * metadata enrichment is enabled (`query.trim().length >= 2`), hydrating any unmatched `itemKey`
 * via `catalog.itemDetail` so IMDb original/English/localized aliases surface in Search (`#511`).
 */
export function useElvAliasSearch({
  catalog,
  query,
  scope,
  enabled,
  refreshToken,
  existingKeys,
}: UseElvAliasSearchOptions): ElvAliasSearchState {
  const sanitizedQuery = sanitizeSearchQuery(query);
  const aliasKind: 'movie' | 'series' | undefined =
    scope === 'movie' ? 'movie' : scope === 'series' ? 'series' : undefined;
  const active =
    enabled &&
    sanitizedQuery.length >= 2 &&
    catalog.searchElvItemKeysByAlias !== undefined &&
    catalog.itemDetail !== undefined;

  const [state, setState] = useState<ElvAliasSearchState>({
    movies: EMPTY_ROWS,
    series: EMPTY_ROWS,
    searching: false,
  });

  const existingKeysRef = useRef<ReadonlySet<string> | undefined>(existingKeys);
  existingKeysRef.current = existingKeys;
  const lastQueryRef = useRef<string>(sanitizedQuery);
  const genRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken re-runs alias lookup on catalog sync
  useEffect(() => {
    const gen = ++genRef.current;
    const queryChanged = lastQueryRef.current !== sanitizedQuery;
    lastQueryRef.current = sanitizedQuery;

    if (!active) {
      setState((prev) =>
        prev.movies.length === 0 && prev.series.length === 0 && !prev.searching
          ? prev
          : { movies: EMPTY_ROWS, series: EMPTY_ROWS, searching: false },
      );
      return undefined;
    }

    const searchByAlias = catalog.searchElvItemKeysByAlias;
    const itemDetail = catalog.itemDetail;
    if (searchByAlias === undefined || itemDetail === undefined) return undefined;

    setState((prev) => ({
      movies: queryChanged ? EMPTY_ROWS : prev.movies,
      series: queryChanged ? EMPTY_ROWS : prev.series,
      searching: true,
    }));

    const timer = setTimeout(() => {
      void (async () => {
        if (gen !== genRef.current) return;
        try {
          const matchedKeys = await searchByAlias(sanitizedQuery, {
            ...(aliasKind !== undefined ? { kind: aliasKind } : {}),
            limit: ALIAS_SEARCH_LIMIT,
          });
          if (gen !== genRef.current) return;

          const skip = existingKeysRef.current;
          const seen = new Set<string>();
          const toHydrate: string[] = [];
          for (const key of matchedKeys) {
            if (key === '' || seen.has(key) || skip?.has(key)) continue;
            seen.add(key);
            toHydrate.push(key);
          }

          if (toHydrate.length === 0) {
            setState({ movies: EMPTY_ROWS, series: EMPTY_ROWS, searching: false });
            return;
          }

          const hydrated = await Promise.all(
            toHydrate.map((key) => itemDetail(key).catch(() => null)),
          );
          if (gen !== genRef.current) return;

          const movies: ItemRow[] = [];
          const series: ItemRow[] = [];
          for (const row of hydrated) {
            if (row === null) continue;
            if (row.kind === 'movie') movies.push(row);
            else if (row.kind === 'series') series.push(row);
          }
          setState({ movies, series, searching: false });
        } catch {
          if (gen !== genRef.current) return;
          setState({ movies: EMPTY_ROWS, series: EMPTY_ROWS, searching: false });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      genRef.current += 1;
    };
  }, [active, aliasKind, catalog, refreshToken, sanitizedQuery]);

  return active ? state : { movies: EMPTY_ROWS, series: EMPTY_ROWS, searching: false };
}
