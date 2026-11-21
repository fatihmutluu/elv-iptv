import type { CatalogService, SearchResults, SearchScope, WatchProgressRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { batchLoadProgressByKeys, useCatalogUiCache } from '../shared';
import {
  addRecentSearch,
  countScopeResults,
  EMPTY_SEARCH_RESULTS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_RESULT_LIMIT,
  sanitizeSearchQuery,
} from './search-model';

const EMPTY_PROGRESS_MAP: ReadonlyMap<string, WatchProgressRow> = new Map();

/** Options accepted by {@link useCatalogSearch}. */
export interface UseCatalogSearchOptions {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly initialQuery?: string;
  readonly onQueryChange?: (next: string) => void;
  readonly initialScope?: SearchScope;
  readonly onScopeChange?: (next: SearchScope) => void;
  readonly initialRecent?: readonly string[];
  readonly onRecentChange?: (next: readonly string[]) => void;
}

/** Referentially stable search state and actions returned by {@link useCatalogSearch}. */
export interface CatalogSearchState {
  readonly query: string;
  readonly setQuery: (next: string) => void;
  readonly scope: SearchScope;
  readonly setScope: (next: SearchScope) => void;
  readonly results: SearchResults;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly searching: boolean;
  readonly hasSearched: boolean;
  readonly recentSearches: readonly string[];
  readonly commitRecent: (rawQuery: string) => void;
  readonly clearSearch: () => void;
  readonly selectRecent: (term: string) => void;
  readonly clearRecent: () => void;
}

/**
 * Debounced (`150ms`) catalog search hook with monotonic generation cancellation, single-query
 * instant scope filtering, `CatalogUiCache` synchronous warm return hydration (`#445`), isolated
 * VOD watch-progress hydration, and recent-search history.
 */
export function useCatalogSearch({
  catalog,
  refreshToken,
  userStateVersion = 0,
  initialQuery = '',
  onQueryChange,
  initialScope = 'all',
  onScopeChange,
  initialRecent,
  onRecentChange,
}: UseCatalogSearchOptions): CatalogSearchState {
  const uiCache = useCatalogUiCache();
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;

  const initialSanitized = sanitizeSearchQuery(initialQuery);
  const initialCached =
    initialSanitized !== '' ? (uiCache?.getSearch(initialSanitized, initialScope) ?? null) : null;

  const [query, setQueryState] = useState(initialQuery);
  const [scope, setScopeState] = useState<SearchScope>(initialScope);
  const [results, setResults] = useState<SearchResults>(
    () => initialCached?.results ?? EMPTY_SEARCH_RESULTS,
  );
  const [progressByKey, setProgressByKey] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => initialCached?.progressByKey ?? EMPTY_PROGRESS_MAP,
  );
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(() => initialCached !== null);

  const [localRecent, setLocalRecent] = useState<readonly string[]>(() => initialRecent ?? []);
  const recentSearches =
    onRecentChange !== undefined && initialRecent !== undefined ? initialRecent : localRecent;

  const recentRef = useRef<readonly string[]>(recentSearches);
  recentRef.current = recentSearches;
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  const onScopeChangeRef = useRef(onScopeChange);
  onScopeChangeRef.current = onScopeChange;
  const onRecentChangeRef = useRef(onRecentChange);
  onRecentChangeRef.current = onRecentChange;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const progressRef = useRef(progressByKey);
  progressRef.current = progressByKey;

  const prevInitialQueryRef = useRef(initialQuery);
  useEffect(() => {
    if (prevInitialQueryRef.current !== initialQuery) {
      prevInitialQueryRef.current = initialQuery;
      setQueryState(initialQuery);
    }
  }, [initialQuery]);

  const prevInitialScopeRef = useRef(initialScope);
  useEffect(() => {
    if (prevInitialScopeRef.current !== initialScope) {
      prevInitialScopeRef.current = initialScope;
      setScopeState(initialScope);
    }
  }, [initialScope]);

  const generationRef = useRef(0);
  const progressGenRef = useRef(0);
  const searchingRef = useRef(false);
  const resultsRef = useRef<SearchResults>(results);
  resultsRef.current = results;
  const hasSearchedRef = useRef(hasSearched);
  hasSearchedRef.current = hasSearched;
  const prevUserStateVersionRef = useRef(userStateVersion);
  const lastRefreshTokenRef = useRef(refreshToken);

  const sanitizedQuery = sanitizeSearchQuery(query);
  const sanitizedQueryRef = useRef(sanitizedQuery);
  sanitizedQueryRef.current = sanitizedQuery;

  const persistSearchCache = useCallback(
    (
      q: string,
      nextScope: SearchScope,
      nextResults: SearchResults,
      nextProgress: ReadonlyMap<string, WatchProgressRow>,
    ) => {
      const cache = uiCacheRef.current;
      if (!cache || q === '') return;
      cache.setSearch({
        query: q,
        scope: nextScope,
        catalogRevision: cache.getRevision(),
        results: nextResults,
        progressByKey: nextProgress,
      });
    },
    [],
  );

  const setQuery = useCallback((next: string) => {
    prevInitialQueryRef.current = next;
    setQueryState(next);
    onQueryChangeRef.current?.(next);
  }, []);

  const setScope = useCallback(
    (next: SearchScope) => {
      prevInitialScopeRef.current = next;
      scopeRef.current = next;
      setScopeState(next);
      onScopeChangeRef.current?.(next);
      if (hasSearchedRef.current && sanitizedQueryRef.current !== '') {
        persistSearchCache(
          sanitizedQueryRef.current,
          next,
          resultsRef.current,
          progressRef.current,
        );
      }
    },
    [persistSearchCache],
  );

  const commitRecent = useCallback((rawQuery: string) => {
    const clean = sanitizeSearchQuery(rawQuery);
    if (clean === '') return;
    const next = addRecentSearch(recentRef.current, clean);
    recentRef.current = next;
    setLocalRecent(next);
    onRecentChangeRef.current?.(next);
  }, []);

  const clearRecent = useCallback(() => {
    recentRef.current = [];
    setLocalRecent([]);
    onRecentChangeRef.current?.([]);
  }, []);

  const clearSearch = useCallback(() => {
    generationRef.current += 1;
    progressGenRef.current += 1;
    searchingRef.current = false;
    prevInitialQueryRef.current = '';
    setQueryState('');
    onQueryChangeRef.current?.('');
    setResults(EMPTY_SEARCH_RESULTS);
    setProgressByKey(EMPTY_PROGRESS_MAP);
    setSearching(false);
    setHasSearched(false);
    uiCacheRef.current?.clearSearch();
  }, []);

  const selectRecent = useCallback(
    (term: string) => {
      setQuery(term);
    },
    [setQuery],
  );

  useEffect(() => {
    const gen = ++generationRef.current;
    progressGenRef.current += 1;

    if (sanitizedQuery === '') {
      searchingRef.current = false;
      setResults(EMPTY_SEARCH_RESULTS);
      setProgressByKey(EMPTY_PROGRESS_MAP);
      setSearching(false);
      setHasSearched(false);
      uiCacheRef.current?.clearSearch();
      return;
    }

    const tokenChanged = lastRefreshTokenRef.current !== refreshToken;
    lastRefreshTokenRef.current = refreshToken;

    const cachedHit = !tokenChanged
      ? (uiCacheRef.current?.getSearch(sanitizedQuery, scopeRef.current) ?? null)
      : null;
    if (cachedHit !== null) {
      searchingRef.current = false;
      setResults(cachedHit.results);
      setProgressByKey(cachedHit.progressByKey);
      setHasSearched(true);
      setSearching(false);
      const vodKeys = [...cachedHit.results.movies, ...cachedHit.results.series].map(
        (item) => item.key,
      );
      if (vodKeys.length > 0) {
        const pGen = ++progressGenRef.current;
        void batchLoadProgressByKeys(catalog, vodKeys)
          .then((progressMap) => {
            if (gen !== generationRef.current || pGen !== progressGenRef.current) return;
            setProgressByKey(progressMap);
            persistSearchCache(sanitizedQuery, scopeRef.current, cachedHit.results, progressMap);
          })
          .catch(() => undefined);
      }
      return;
    }

    searchingRef.current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        if (gen !== generationRef.current) return;
        try {
          const fetched = catalog.search
            ? await catalog.search(sanitizedQuery, { scope: 'all', limit: SEARCH_RESULT_LIMIT })
            : EMPTY_SEARCH_RESULTS;
          if (gen !== generationRef.current) return;

          searchingRef.current = false;
          setResults(fetched);
          setHasSearched(true);
          setSearching(false);
          persistSearchCache(sanitizedQuery, scopeRef.current, fetched, EMPTY_PROGRESS_MAP);

          if (countScopeResults(fetched, 'all') > 0) {
            commitRecent(sanitizedQuery);
          }

          const vodKeys = [...fetched.movies, ...fetched.series].map((item) => item.key);
          const pGen = ++progressGenRef.current;
          if (vodKeys.length === 0) {
            setProgressByKey(EMPTY_PROGRESS_MAP);
            return;
          }
          const progressMap = await batchLoadProgressByKeys(catalog, vodKeys);
          if (gen !== generationRef.current || pGen !== progressGenRef.current) return;
          setProgressByKey(progressMap);
          persistSearchCache(sanitizedQuery, scopeRef.current, fetched, progressMap);
        } catch {
          if (gen !== generationRef.current) return;
          searchingRef.current = false;
          setResults(EMPTY_SEARCH_RESULTS);
          setProgressByKey(EMPTY_PROGRESS_MAP);
          setHasSearched(true);
          setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      generationRef.current += 1;
      progressGenRef.current += 1;
      searchingRef.current = false;
    };
  }, [catalog, commitRecent, persistSearchCache, refreshToken, sanitizedQuery]);

  // Refresh VOD watch progress with its own monotonic generation when user state changes.
  useEffect(() => {
    if (prevUserStateVersionRef.current === userStateVersion) return;
    prevUserStateVersionRef.current = userStateVersion;
    if (searchingRef.current) return;

    const current = resultsRef.current;
    const vodKeys = [...current.movies, ...current.series].map((item) => item.key);
    if (vodKeys.length === 0) return;

    const sGen = generationRef.current;
    const pGen = ++progressGenRef.current;
    void (async () => {
      try {
        const progressMap = await batchLoadProgressByKeys(catalog, vodKeys);
        if (sGen !== generationRef.current || pGen !== progressGenRef.current) return;
        setProgressByKey(progressMap);
        persistSearchCache(sanitizedQueryRef.current, scopeRef.current, current, progressMap);
      } catch {
        // Keep existing progress snapshot on transient read errors.
      }
    })();
  }, [catalog, persistSearchCache, userStateVersion]);

  return useMemo(
    () => ({
      query,
      setQuery,
      scope,
      setScope,
      results,
      progressByKey,
      searching,
      hasSearched,
      recentSearches,
      commitRecent,
      clearSearch,
      selectRecent,
      clearRecent,
    }),
    [
      clearRecent,
      clearSearch,
      commitRecent,
      hasSearched,
      progressByKey,
      query,
      recentSearches,
      results,
      scope,
      searching,
      selectRecent,
      setQuery,
      setScope,
    ],
  );
}
