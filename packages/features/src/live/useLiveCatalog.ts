import type { CatalogService, CategoryRow, ItemRow, NowNextEntry, SourceRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import {
  buildSharedDisplayCategories,
  createPagedListSource,
  type DisplayCategory,
  type PagedListSource,
} from '../shared';
import {
  buildLiveHubPlayTarget,
  LIVE_MAX_PAGES,
  LIVE_PAGE_SIZE,
  type LiveMode,
  recordChannelTune,
  toLiveEntry,
} from './live-model';
import { useLiveFavorites } from './useLiveFavorites';
import { useLiveNowNext } from './useLiveNowNext';
import { type LiveNumberFeedback, useLiveNumberJump } from './useLiveNumberJump';

export type { LiveNumberFeedback } from './useLiveNumberJump';

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
  readonly onSelectCategoryId?: (categoryId: string | null) => void;
  readonly onChannelHistoryChange?: (next: {
    readonly activeChannelKey: string | null;
    readonly previousChannelKey: string | null;
  }) => void;
  /** Injectable epoch clock in milliseconds (defaults to `() => Date.now()`). */
  readonly now?: () => number;
}

/** Live catalog, favorites, O(1) paged channel source, Now/Next TTL cache, channel history, and 0–9 jump state. */
export interface LiveCatalogState {
  readonly categories: readonly DisplayCategory[];
  readonly activeCategory: DisplayCategory | null;
  readonly loadingCategories: boolean;
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly channelCount: number;
  readonly sourceVersion: number;
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

interface ChannelHistory {
  readonly active: ItemRow | null;
  readonly activeIndex: number;
  readonly previous: ItemRow | null;
  readonly previousIndex: number;
}

const EMPTY_HISTORY: ChannelHistory = {
  active: null,
  activeIndex: 0,
  previous: null,
  previousIndex: 0,
};
const defaultNow = (): number => Date.now();

function findChannelByKey(
  source: PagedListSource<ItemRow>,
  key: string,
): { item: ItemRow; index: number } | null {
  const limit = Math.min(source.count(), LIVE_PAGE_SIZE);
  for (let i = 0; i < limit; i++) {
    const candidate = source.get(i);
    if (candidate?.key === key) return { item: candidate, index: i };
  }
  return null;
}

function findInitialChannel(
  source: PagedListSource<ItemRow>,
  preferredKey: string | null,
): { item: ItemRow; index: number } | null {
  if (preferredKey !== null) {
    const matched = findChannelByKey(source, preferredKey);
    if (matched) return matched;
  }
  const first = source.get(0);
  return first ? { item: first, index: 0 } : null;
}

/**
 * Manages Cinema Quietude Live TV Hub state: multi-source live categories, O(1) LRU-paged
 * `PagedListSource<ItemRow>`, bounded Now/Next TTL cache (`#250`), active/previous channel history
 * (`#43`), and `0–9` channel number jump with auto-tune timeout (`#44`/`#54`).
 */
export function useLiveCatalog(options: UseLiveCatalogOptions): LiveCatalogState {
  const { catalog, sources, refreshToken = 0, userStateVersion = 0, mode = 'channels' } = options;
  const { selectedCategoryId, activeChannelKey, previousChannelKey, now = defaultNow } = options;

  const [categories, setCategories] = useState<readonly DisplayCategory[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [channelSource, setChannelSource] = useState<PagedListSource<ItemRow> | null>(null);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [history, setHistory] = useState<ChannelHistory>(EMPTY_HISTORY);

  const activeCategory = useMemo(
    () =>
      (selectedCategoryId !== null
        ? categories.find((c) => c.row.id === selectedCategoryId)
        : undefined) ??
      categories[0] ??
      null,
    [categories, selectedCategoryId],
  );

  const nowRef = useRef(now);
  nowRef.current = now;
  const activeSourceIdRef = useRef<string | undefined>(undefined);
  activeSourceIdRef.current =
    activeCategory?.row.sourceId ?? history.active?.sourceId ?? sources[0]?.id;

  const latest = {
    onSelectCategoryId: options.onSelectCategoryId,
    onChannelHistoryChange: options.onChannelHistoryChange,
    history,
  };
  const latestRef = useRef(latest);
  latestRef.current = latest;

  const aliveRef = useRef(true);
  const prevHydrateGenRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const nowNext = useLiveNowNext({ catalog, refreshToken, nowRef });
  const { hydrateNowNext } = nowNext;
  const favorites = useLiveFavorites({ catalog, sources, refreshToken, userStateVersion });
  const { favoriteChannels } = favorites;

  useEffect(() => {
    if (mode !== 'favorites' || favoriteChannels.length === 0) return;
    hydrateNowNext(favoriteChannels.map((c) => c.key));
  }, [favoriteChannels, hydrateNowNext, mode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken reloads live categories
  useEffect(() => {
    let alive = true;
    if (sources.length === 0) {
      prevHydrateGenRef.current += 1;
      latestRef.current.history = EMPTY_HISTORY;
      setHistory(EMPTY_HISTORY);
      setCategories([]);
      setLoadingCategories(false);
      return undefined;
    }
    setLoadingCategories(true);
    void Promise.all(
      sources.map(
        async (s) =>
          [s.id, await catalog.categories(s.id, 'live').catch(() => [] as CategoryRow[])] as const,
      ),
    )
      .then((entries) => {
        if (alive) setCategories(buildSharedDisplayCategories(sources, new Map(entries)));
      })
      .finally(() => {
        if (alive) setLoadingCategories(false);
      });
    return () => {
      alive = false;
    };
  }, [catalog, refreshToken, sources]);

  useEffect(() => {
    if (
      !loadingCategories &&
      selectedCategoryId &&
      activeCategory &&
      activeCategory.row.id !== selectedCategoryId
    ) {
      latestRef.current.onSelectCategoryId?.(activeCategory.row.id);
    }
  }, [activeCategory, loadingCategories, selectedCategoryId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken recreates O(1) paged channel source
  useEffect(() => {
    if (!activeCategory || activeCategory.row.itemCount <= 0) {
      setChannelSource(null);
      return undefined;
    }
    let alive = true;
    const { id: categoryId, itemCount: count } = activeCategory.row;
    const source = createPagedListSource<ItemRow>({
      count,
      pageSize: LIVE_PAGE_SIZE,
      maxPages: LIVE_MAX_PAGES,
      loadPage: (offset, limit) => catalog.items(categoryId, offset, limit),
    });
    const unsub = source.onChange(() => {
      if (alive) setSourceVersion((v) => v + 1);
    });
    setChannelSource(source);
    source.prefetch(0, Math.min(count, LIVE_PAGE_SIZE));
    return () => {
      alive = false;
      unsub();
      source.dispose();
    };
  }, [activeCategory?.row.id, activeCategory?.row.itemCount, catalog, refreshToken]);

  // Hydrate active and previous channels from session memory when page 0 loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion notifies when page 0 arrives
  useEffect(() => {
    if (!channelSource) return;
    const cur = latestRef.current.history;
    if (cur.active === null) {
      const hit = findInitialChannel(channelSource, activeChannelKey);
      if (hit) {
        const nextHistory: ChannelHistory = { ...cur, active: hit.item, activeIndex: hit.index };
        latestRef.current.history = nextHistory;
        setHistory(nextHistory);
        hydrateNowNext([hit.item.key]);
        latestRef.current.onChannelHistoryChange?.({
          activeChannelKey: hit.item.key,
          previousChannelKey,
        });
      }
    }
    const afterActive = latestRef.current.history;
    if (!previousChannelKey || afterActive.previous?.key === previousChannelKey) return;
    const prevHit = findChannelByKey(channelSource, previousChannelKey);
    if (prevHit) {
      const nextHistory: ChannelHistory = {
        ...afterActive,
        previous: prevHit.item,
        previousIndex: prevHit.index,
      };
      latestRef.current.history = nextHistory;
      setHistory(nextHistory);
      return;
    }
    if (!catalog.itemDetail) return;
    const gen = ++prevHydrateGenRef.current;
    void catalog
      .itemDetail(previousChannelKey)
      .then((detail) => {
        if (!aliveRef.current || prevHydrateGenRef.current !== gen || !detail) return;
        const latestHist = latestRef.current.history;
        if (latestHist.previous?.key === detail.key) return;
        const nextHistory: ChannelHistory = { ...latestHist, previous: detail, previousIndex: 0 };
        latestRef.current.history = nextHistory;
        setHistory(nextHistory);
      })
      .catch(() => undefined);
  }, [activeChannelKey, catalog, channelSource, hydrateNowNext, previousChannelKey, sourceVersion]);

  const tuneChannel = useCallback(
    (channel: ItemRow, index?: number) => {
      prevHydrateGenRef.current += 1;
      const cur = latestRef.current.history;
      const keyHistory = recordChannelTune(
        {
          activeChannelKey: cur.active?.key ?? null,
          previousChannelKey: cur.previous?.key ?? null,
        },
        channel.key,
      );
      const changed = cur.active !== null && cur.active.key !== channel.key;
      const nextHistory: ChannelHistory = {
        active: channel,
        activeIndex: index ?? cur.activeIndex,
        previous: changed ? cur.active : cur.previous,
        previousIndex: changed ? cur.activeIndex : cur.previousIndex,
      };
      latestRef.current.history = nextHistory;
      setHistory(nextHistory);
      hydrateNowNext([channel.key]);
      latestRef.current.onChannelHistoryChange?.(keyHistory);
    },
    [hydrateNowNext],
  );

  const tunePreviousChannel = useCallback((): ItemRow | null => {
    const cur = latestRef.current.history;
    if (!cur.previous) return null;
    tuneChannel(cur.previous, cur.previousIndex);
    return cur.previous;
  }, [tuneChannel]);

  const numJump = useLiveNumberJump({
    catalog,
    activeSourceIdRef,
    onResolved: tuneChannel,
  });

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
        currentIndex: index ?? latestRef.current.history.activeIndex,
        loadPage: useFavorites
          ? async (offset, limit) => favoriteChannels.slice(offset, offset + limit)
          : (offset, limit) => catalog.items(categoryId, offset, limit),
      });
      const prev = latestRef.current.history.previous;
      return prev !== null && prev.key !== channel.key
        ? {
            ...base,
            previousChannel: toLiveEntry(prev),
            previousChannelIndex: latestRef.current.history.previousIndex,
          }
        : base;
    },
    [activeCategory?.row.id, activeCategory?.row.itemCount, catalog, favoriteChannels],
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
      sourceVersion,
      tuneChannel,
      tunePreviousChannel,
    ],
  );
}
