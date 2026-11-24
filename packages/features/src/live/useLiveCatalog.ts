import {
  type AlphabetBucket,
  type CatalogService,
  type CategoryRow,
  type CustomGroupRecord,
  customGroupCategoryId,
  type ItemRow,
  type ItemSortOrder,
  type NowNextEntry,
  type SourceRow,
} from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import {
  buildSharedDisplayCategories,
  createPagedListSource,
  type DisplayCategory,
  type PagedListSource,
  useCatalogUiCache,
} from '../shared';
import {
  buildLiveHubPlayTarget,
  LIVE_ALPHABET_RAIL_MIN_ITEMS,
  LIVE_MAX_PAGES,
  LIVE_PAGE_SIZE,
  type LiveMode,
  toLiveEntry,
} from './live-model';
import { useLiveChannelHistory } from './useLiveChannelHistory';
import { useLiveFavorites } from './useLiveFavorites';
import { useLiveNowNext } from './useLiveNowNext';
import { type LiveNumberFeedback, useLiveNumberJump } from './useLiveNumberJump';

export type { LiveNumberFeedback } from './useLiveNumberJump';

const EMPTY_BUCKETS: readonly AlphabetBucket[] = [];

/** Options accepted by {@link useLiveCatalog}. */
export interface UseLiveCatalogOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken?: number;
  readonly userStateVersion?: number;
  readonly mode?: LiveMode;
  readonly selectedCategoryId: string | null;
  readonly activeChannelKey: string | null;
  readonly previousChannelKey: string | null;
  readonly sortBy?: ItemSortOrder;
  readonly onSelectCategoryId?: (categoryId: string | null) => void;
  readonly onChannelHistoryChange?: (next: {
    readonly activeChannelKey: string | null;
    readonly previousChannelKey: string | null;
  }) => void;
  /** Injectable epoch clock in milliseconds (defaults to `() => Date.now()`). */
  readonly now?: () => number;
  /** When true, collapse same-category 4K/FHD/HD/SD live channel duplicates (`#218`). */
  readonly collapseVariants?: boolean;
}

/** Live catalog, favorites, O(1) paged channel source, Now/Next TTL cache, channel history, and 0–9 jump state. */
export interface LiveCatalogState {
  readonly categories: readonly DisplayCategory[];
  readonly activeCategory: DisplayCategory | null;
  readonly loadingCategories: boolean;
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly channelCount: number;
  readonly sourceVersion: number;
  readonly sortBy: ItemSortOrder;
  readonly alphabetBuckets: readonly AlphabetBucket[];
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoriteChannels: readonly ItemRow[];
  readonly favoriteSource: PagedListSource<ItemRow>;
  readonly favoritesVersion: number;
  readonly toggleFavorite: (channel: ItemRow) => Promise<void>;
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly nowNextVersion: number;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly activeChannel: ItemRow | null;
  readonly activeChannelIndex: number;
  readonly previousChannel: ItemRow | null;
  readonly tuneChannel: (channel: ItemRow, index?: number) => void;
  readonly tunePreviousChannel: () => ItemRow | null;
  readonly numberBuffer: string;
  readonly numberFeedback: LiveNumberFeedback | null;
  readonly pressDigit: (digit: string) => void;
  readonly clearNumber: () => void;
  readonly submitNumberJump: () => Promise<ItemRow | null>;
  readonly buildPlayTarget: (
    channel: ItemRow,
    index?: number,
    scope?: 'category' | 'favorites',
  ) => PlayTarget;
}

const defaultNow = (): number => Date.now();

function pickActiveCategory(
  categories: readonly DisplayCategory[],
  selectedCategoryId: string | null,
): DisplayCategory | null {
  return (
    (selectedCategoryId !== null
      ? categories.find((c) => c.row.id === selectedCategoryId)
      : undefined) ??
    categories[0] ??
    null
  );
}

/**
 * Manages Cinema Quietude Live TV Hub state: multi-source live categories, O(1) LRU-paged
 * `PagedListSource<ItemRow>` hydrated synchronously from `CatalogUiCache` (`#445`), alphabetical
 * sort & `#`/`A–Z` buckets (`#407`), bounded Now/Next TTL cache (`#250`), active/previous channel
 * history (`#43`), and `0–9` channel number jump (`#44`/`#54`).
 */
export function useLiveCatalog(options: UseLiveCatalogOptions): LiveCatalogState {
  const { catalog, sources, refreshToken = 0, userStateVersion = 0, mode = 'channels' } = options;
  const { selectedCategoryId, activeChannelKey, previousChannelKey, now = defaultNow } = options;
  const sortBy: ItemSortOrder = options.sortBy ?? 'default';
  const collapseVariants = options.collapseVariants === true;

  const itemQueryOpts = useMemo(
    () =>
      sortBy === 'alpha' || collapseVariants
        ? {
            ...(sortBy === 'alpha' ? { sortBy: 'alpha' as const } : {}),
            ...(collapseVariants ? { collapseVariants: true } : {}),
          }
        : undefined,
    [collapseVariants, sortBy],
  );
  const variantCatOpts = useMemo(
    () => (collapseVariants ? { collapseVariants: true } : undefined),
    [collapseVariants],
  );

  const uiCache = useCatalogUiCache();
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;
  const initialLive = sources.length > 0 && !collapseVariants ? (uiCache?.getLive() ?? null) : null;
  const initialCats = initialLive?.hasLoadedCategories ? initialLive.categories : [];
  const initialActiveCat = pickActiveCategory(initialCats, selectedCategoryId);
  const initialSlice =
    initialActiveCat && sortBy === 'default' && !collapseVariants
      ? uiCache?.getLiveFirstChannels(initialActiveCat.row.id)
      : undefined;

  const buildChannelSource = useCallback(
    (catId: string, count: number, seeded?: readonly ItemRow[]) =>
      createPagedListSource<ItemRow>({
        count,
        pageSize: LIVE_PAGE_SIZE,
        maxPages: LIVE_MAX_PAGES,
        ...(seeded !== undefined ? { initialPage0: seeded } : {}),
        loadPage: async (offset, limit) => {
          const rows = await catalog.items(catId, offset, limit, itemQueryOpts);
          if (offset === 0 && rows.length > 0 && !collapseVariants && sortBy === 'default')
            uiCacheRef.current?.setLiveFirstChannels(catId, rows);
          return rows;
        },
      }),
    [catalog, collapseVariants, itemQueryOpts, sortBy],
  );

  const initialSourceMetaRef = useRef<{
    source: PagedListSource<ItemRow> | null;
    catId: string | null;
    count: number;
    refreshToken: number;
    collapseVariants: boolean;
    sortBy: ItemSortOrder;
    catalog: CatalogService;
  } | null>(null);
  if (initialSourceMetaRef.current === null) {
    const src =
      initialActiveCat && initialActiveCat.row.itemCount > 0 && initialSlice !== undefined
        ? buildChannelSource(initialActiveCat.row.id, initialActiveCat.row.itemCount, initialSlice)
        : null;
    initialSourceMetaRef.current = {
      source: src,
      catId: initialActiveCat?.row.id ?? null,
      count: initialActiveCat?.row.itemCount ?? 0,
      refreshToken,
      collapseVariants,
      sortBy,
      catalog,
    };
  }

  const [categories, setCategories] = useState<readonly DisplayCategory[]>(() => initialCats);
  const [loadingCategories, setLoadingCategories] = useState(
    () => sources.length > 0 && !(initialLive?.hasLoadedCategories ?? false),
  );
  const [channelSource, setChannelSource] = useState<PagedListSource<ItemRow> | null>(
    () => initialSourceMetaRef.current?.source ?? null,
  );
  const [sourceVersion, setSourceVersion] = useState(0);
  const [alphabetBuckets, setAlphabetBuckets] = useState<readonly AlphabetBucket[]>(EMPTY_BUCKETS);

  const bucketsCacheRef = useRef<Map<string, readonly AlphabetBucket[]>>(new Map());
  const alphabetGenRef = useRef(0);

  const activeCategory = useMemo(
    () => pickActiveCategory(categories, selectedCategoryId),
    [categories, selectedCategoryId],
  );

  const nowRef = useRef(now);
  nowRef.current = now;
  const onSelectCatRef = useRef(options.onSelectCategoryId);
  onSelectCatRef.current = options.onSelectCategoryId;

  const hasCatsRef = useRef(initialLive?.hasLoadedCategories ?? false);
  const activeSourceRef = useRef<PagedListSource<ItemRow> | null>(
    initialSourceMetaRef.current?.source ?? null,
  );
  const activeSourceKeyRef = useRef({
    catId: initialSourceMetaRef.current?.catId ?? null,
    count: initialSourceMetaRef.current?.count ?? 0,
    refreshToken,
    collapseVariants,
    sortBy,
    catalog,
  });

  useEffect(() => {
    return () => {
      activeSourceRef.current?.dispose();
      activeSourceRef.current = null;
    };
  }, []);

  const nowNext = useLiveNowNext({ catalog, refreshToken, nowRef });
  const { hydrateNowNext } = nowNext;
  const favorites = useLiveFavorites({ catalog, sources, refreshToken, userStateVersion });
  const { favoriteChannels } = favorites;
  const chHistory = useLiveChannelHistory({
    catalog,
    channelSource,
    sourceVersion,
    activeChannelKey,
    previousChannelKey,
    hydrateNowNext,
    ...(options.onChannelHistoryChange !== undefined
      ? { onChannelHistoryChange: options.onChannelHistoryChange }
      : {}),
  });
  const { history, historyRef, resetHistory, tuneChannel, tunePreviousChannel } = chHistory;

  const activeSourceIdRef = useRef<string | undefined>(undefined);
  const catSourceId = activeCategory?.row.sourceId;
  const fallbackSourceId = history.active?.sourceId ?? sources[0]?.id;
  activeSourceIdRef.current =
    catSourceId !== undefined && catSourceId.length > 0 ? catSourceId : fallbackSourceId;

  useEffect(() => {
    if (mode !== 'favorites' || favoriteChannels.length === 0) return;
    hydrateNowNext(favoriteChannels.map((c) => c.key));
  }, [favoriteChannels, hydrateNowNext, mode]);

  // Load A–Z alphabet prefix buckets when sortBy === 'alpha' and total >= 40 (#407).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken refreshes cached live alphabet buckets
  useEffect(() => {
    const gen = ++alphabetGenRef.current;
    const catId = activeCategory?.row.id ?? null;
    const sourceId = activeCategory?.row.sourceId;
    const count = activeCategory?.row.itemCount ?? 0;

    if (
      sortBy !== 'alpha' ||
      catId === null ||
      count < LIVE_ALPHABET_RAIL_MIN_ITEMS ||
      !catalog.alphabetIndex
    ) {
      setAlphabetBuckets(EMPTY_BUCKETS);
      return;
    }

    const cacheKey = `${catId}|${collapseVariants ? 'cv' : 'raw'}`;
    const cached = bucketsCacheRef.current.get(cacheKey);
    if (cached !== undefined) {
      setAlphabetBuckets(cached);
    } else {
      setAlphabetBuckets(EMPTY_BUCKETS);
    }

    void catalog
      .alphabetIndex({
        ...(sourceId !== undefined && sourceId !== '' ? { sourceId } : {}),
        kind: 'live',
        categoryId: catId,
        ...(collapseVariants ? { collapseVariants: true } : {}),
      })
      .then((rows) => {
        if (gen !== alphabetGenRef.current) return;
        const resolved = rows ?? EMPTY_BUCKETS;
        bucketsCacheRef.current.set(cacheKey, resolved);
        setAlphabetBuckets(resolved);
      })
      .catch(() => {
        if (gen !== alphabetGenRef.current) return;
        if (!bucketsCacheRef.current.has(cacheKey)) {
          setAlphabetBuckets(EMPTY_BUCKETS);
        }
      });

    return () => {
      alphabetGenRef.current += 1;
    };
  }, [
    activeCategory?.row.id,
    activeCategory?.row.itemCount,
    activeCategory?.row.sourceId,
    catalog,
    collapseVariants,
    refreshToken,
    sortBy,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken reloads live categories
  useEffect(() => {
    let alive = true;
    if (sources.length === 0) {
      hasCatsRef.current = false;
      resetHistory();
      setCategories([]);
      setLoadingCategories(false);
      return undefined;
    }
    if (!hasCatsRef.current) setLoadingCategories(true);
    void Promise.all([
      Promise.all(
        sources.map(
          async (s) =>
            [
              s.id,
              await catalog
                .categories(s.id, 'live', variantCatOpts)
                .catch(() => [] as CategoryRow[]),
            ] as const,
        ),
      ),
      catalog.listCustomGroups
        ? catalog.listCustomGroups().catch(() => [] as CustomGroupRecord[])
        : Promise.resolve([] as CustomGroupRecord[]),
    ])
      .then(([entries, customGroups]) => {
        if (!alive) return;
        const providerCats = buildSharedDisplayCategories(sources, new Map(entries));
        const customCats: DisplayCategory[] = customGroups
          .filter((g) => !g.isHidden)
          .map((g) => ({
            row: {
              id: customGroupCategoryId(g.id),
              sourceId: '',
              kind: 'live' as const,
              name: g.name,
              position: g.sortOrder,
              itemCount: g.itemCount,
            },
            label: g.name,
          }));
        const nextCats = [...customCats, ...providerCats];
        hasCatsRef.current = true;
        if (!collapseVariants) uiCacheRef.current?.setLiveCategories(nextCats);
        setCategories(nextCats);
      })
      .finally(() => {
        if (alive) setLoadingCategories(false);
      });
    return () => {
      alive = false;
    };
  }, [catalog, collapseVariants, refreshToken, resetHistory, sources, variantCatOpts]);

  useEffect(() => {
    if (
      !loadingCategories &&
      selectedCategoryId &&
      activeCategory &&
      activeCategory.row.id !== selectedCategoryId
    ) {
      onSelectCatRef.current?.(activeCategory.row.id);
    }
  }, [activeCategory, loadingCategories, selectedCategoryId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken recreates O(1) paged channel source
  useEffect(() => {
    if (!activeCategory || activeCategory.row.itemCount <= 0) {
      activeSourceRef.current?.dispose();
      activeSourceRef.current = null;
      activeSourceKeyRef.current = {
        catId: null,
        count: 0,
        refreshToken,
        collapseVariants,
        sortBy,
        catalog,
      };
      setChannelSource(null);
      return undefined;
    }
    let alive = true;
    const { id: categoryId, itemCount: count } = activeCategory.row;
    const prevKey = activeSourceKeyRef.current;
    const reuseExisting =
      activeSourceRef.current !== null &&
      prevKey.catId === categoryId &&
      prevKey.count === count &&
      prevKey.refreshToken === refreshToken &&
      prevKey.collapseVariants === collapseVariants &&
      prevKey.sortBy === sortBy &&
      prevKey.catalog === catalog;

    let unsub: (() => void) | undefined;
    const tokenBumped =
      prevKey.refreshToken !== refreshToken ||
      prevKey.collapseVariants !== collapseVariants ||
      prevKey.sortBy !== sortBy;
    const activateSource = (next: PagedListSource<ItemRow>, bumpVersion: boolean) => {
      if (activeSourceRef.current !== next) activeSourceRef.current?.dispose();
      activeSourceRef.current = next;
      activeSourceKeyRef.current = {
        catId: categoryId,
        count,
        refreshToken,
        collapseVariants,
        sortBy,
        catalog,
      };
      unsub = next.onChange(() => {
        if (alive) setSourceVersion((v) => v + 1);
      });
      setChannelSource(next);
      if (bumpVersion) setSourceVersion((v) => v + 1);
      next.prefetch(0, Math.min(count, LIVE_PAGE_SIZE));
    };

    if (reuseExisting && activeSourceRef.current) {
      activateSource(activeSourceRef.current, false);
    } else if (tokenBumped && activeSourceRef.current !== null) {
      // On refreshToken, collapseVariants, or sortBy toggle, keep previous source visible until fresh page 0 lands.
      void catalog
        .items(categoryId, 0, Math.min(LIVE_PAGE_SIZE, count), itemQueryOpts)
        .then((rows) => {
          if (!alive) return;
          if (rows.length > 0 && !collapseVariants && sortBy === 'default')
            uiCacheRef.current?.setLiveFirstChannels(categoryId, rows);
          activateSource(buildChannelSource(categoryId, count, rows), true);
        })
        .catch(() => {
          if (alive) activateSource(buildChannelSource(categoryId, count, undefined), false);
        });
    } else {
      const seeded =
        tokenBumped || collapseVariants || sortBy !== 'default'
          ? undefined
          : uiCacheRef.current?.getLiveFirstChannels(categoryId);
      activateSource(buildChannelSource(categoryId, count, seeded), false);
    }

    return () => {
      alive = false;
      unsub?.();
    };
  }, [
    activeCategory?.row.id,
    activeCategory?.row.itemCount,
    buildChannelSource,
    catalog,
    collapseVariants,
    itemQueryOpts,
    refreshToken,
    sortBy,
  ]);

  const numJump = useLiveNumberJump({ catalog, activeSourceIdRef, onResolved: tuneChannel });

  const buildPlayTarget = useCallback(
    (
      channel: ItemRow,
      index?: number,
      scope: 'category' | 'favorites' = 'category',
    ): PlayTarget => {
      const useFavorites = scope === 'favorites' && favoriteChannels.length > 0;
      const categoryId = useFavorites
        ? 'favorites'
        : (activeCategory?.row.id ?? `${channel.sourceId}|live|all`);
      const base = buildLiveHubPlayTarget({
        item: channel,
        categoryId,
        categoryCount: useFavorites
          ? favoriteChannels.length
          : Math.max(1, activeCategory?.row.itemCount ?? 1),
        currentIndex: index ?? historyRef.current.activeIndex,
        loadPage: useFavorites
          ? async (offset, limit) => favoriteChannels.slice(offset, offset + limit)
          : (offset, limit) => catalog.items(categoryId, offset, limit, itemQueryOpts),
      });
      const prev = historyRef.current.previous;
      return prev !== null && prev.key !== channel.key
        ? {
            ...base,
            previousChannel: toLiveEntry(prev),
            previousChannelIndex: historyRef.current.previousIndex,
          }
        : base;
    },
    [
      activeCategory?.row.id,
      activeCategory?.row.itemCount,
      catalog,
      favoriteChannels,
      historyRef,
      itemQueryOpts,
    ],
  );

  const channelCount = activeCategory?.row.itemCount ?? 0;

  return useMemo<LiveCatalogState>(
    () => ({
      categories,
      activeCategory,
      loadingCategories,
      channelSource,
      channelCount,
      sourceVersion,
      sortBy,
      alphabetBuckets,
      ...favorites,
      nowNextByKey: nowNext.byKey,
      nowNextVersion: nowNext.version,
      hydrateNowNext,
      activeChannel: history.active,
      activeChannelIndex: history.activeIndex,
      previousChannel: history.previous,
      tuneChannel,
      tunePreviousChannel,
      ...numJump,
      buildPlayTarget,
    }),
    [
      activeCategory,
      alphabetBuckets,
      buildPlayTarget,
      categories,
      channelCount,
      channelSource,
      favorites,
      history,
      hydrateNowNext,
      loadingCategories,
      nowNext.byKey,
      nowNext.version,
      numJump,
      sortBy,
      sourceVersion,
      tuneChannel,
      tunePreviousChannel,
    ],
  );
}
