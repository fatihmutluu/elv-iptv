import type {
  CatalogService,
  FavoriteRow,
  ItemRow,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import {
  type ContextMenuAnchor,
  PosterCard,
  type PosterCardQuickActions,
  useContextMenu,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type MutableRefObject,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import {
  batchLoadProgressByKeys,
  type CatalogLayoutMetrics,
  type DetailTarget,
  detailTargetFromItem,
  formatVodMeta,
  resolveSeriesBadgeProps,
} from '../shared';
import { CatalogEmptyState } from './CatalogChrome';
import type { CategoryGridAccess, CategoryGridMeta } from './CategoryGridView';
import { buildCatalogPosterContextMenuItems } from './catalog-context-menu';
import {
  collectWatchedCatalogItems,
  computeProgressRatio,
  filterFavoritesForCatalog,
  type GridFocusPosition,
  itemRowFromFavorite,
} from './catalog-model';

const MY_LIST_LIMIT = 250;
const WATCHED_LIST_LIMIT = 250;
const WATCHED_SCAN_LIMIT = 200;

type CatalogWithListWatched = CatalogService & {
  listWatched?(
    limit?: number,
    profileId?: string,
    opts?: { readonly kind?: 'movie' | 'series'; readonly parentalUnlocked?: boolean },
  ): Promise<WatchProgressRow[]>;
};

/** Props of {@link CatalogQuickFilterGrid}. */
export interface CatalogQuickFilterGridProps {
  readonly kind: 'movie' | 'series';
  readonly filter: 'mylist' | 'watched';
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly layout: CatalogLayoutMetrics;
  readonly safeBottomInset: number;
  readonly railItemsByCategoryId: ReadonlyMap<string, readonly ItemRow[]>;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly focusedGridPos?: GridFocusPosition | null;
  readonly onGridMetaChange?: (meta: CategoryGridMeta) => void;
  readonly gridAccessRef?: MutableRefObject<CategoryGridAccess>;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => unknown;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
}

interface QuickFilterPosterItemProps {
  readonly item: ItemRow;
  readonly index: number;
  readonly progress: WatchProgressRow | undefined;
  readonly isFavorite: boolean;
  readonly watchedOverride: boolean | undefined;
  readonly unplayedSummary: SeriesUnplayedSummary | undefined;
  readonly watchedLabel: string;
  readonly formatUnplayed: (count: number) => string;
  readonly formatQuickPlay: (title: string) => string;
  readonly addToListLabel: string;
  readonly inMyListLabel: string;
  readonly markWatchedLabel: string;
  readonly markUnwatchedLabel: string;
  readonly cardWidth: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
}

const QuickFilterPosterItem = memo(function QuickFilterPosterItemInner({
  item,
  index,
  progress,
  isFavorite,
  watchedOverride,
  unplayedSummary,
  watchedLabel,
  formatUnplayed,
  formatQuickPlay,
  addToListLabel,
  inMyListLabel,
  markWatchedLabel,
  markUnwatchedLabel,
  cardWidth,
  isTv,
  focused,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
}: QuickFilterPosterItemProps): ReactElement {
  const i18n = useI18n();
  const { openContextMenu } = useContextMenu();

  const handlePress = useCallback(() => {
    const target = detailTargetFromItem(item);
    if (target) onOpenDetail(target);
  }, [item, onOpenDetail]);

  const isSeries = item.kind === 'series';
  const progressWatched = progress?.watched === true;
  const effectiveWatched =
    watchedOverride ?? (progressWatched || (isSeries && unplayedSummary?.watched === true));

  const handleContextMenu = useCallback(
    (anchor?: ContextMenuAnchor) => {
      openContextMenu({
        title: item.name,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildCatalogPosterContextMenuItems({
          item,
          isFavorite,
          isWatched: effectiveWatched,
          i18n,
          onOpenDetail,
          ...(onQuickPlay !== undefined ? { onQuickPlay } : {}),
          ...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {}),
          ...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {}),
        }),
      });
    },
    [
      effectiveWatched,
      i18n,
      isFavorite,
      item,
      onOpenDetail,
      onQuickPlay,
      onQuickToggleFavorite,
      onQuickToggleWatched,
      openContextMenu,
    ],
  );

  const quickActions = useMemo<PosterCardQuickActions | undefined>(() => {
    if (!onQuickPlay && !onQuickToggleFavorite && !onQuickToggleWatched) return undefined;
    return {
      ...(onQuickPlay !== undefined
        ? {
            onPlay: () => onQuickPlay(item, ''),
            playLabel: formatQuickPlay(item.name),
          }
        : {}),
      ...(onQuickToggleFavorite !== undefined
        ? {
            isFavorite,
            onToggleFavorite: () => onQuickToggleFavorite(item),
            favoriteLabel: isFavorite ? inMyListLabel : addToListLabel,
          }
        : {}),
      ...(onQuickToggleWatched !== undefined
        ? {
            isWatched: effectiveWatched,
            onToggleWatched: () => onQuickToggleWatched(item, effectiveWatched),
            watchedLabel: effectiveWatched ? markUnwatchedLabel : markWatchedLabel,
          }
        : {}),
    };
  }, [
    addToListLabel,
    effectiveWatched,
    formatQuickPlay,
    inMyListLabel,
    isFavorite,
    item,
    markUnwatchedLabel,
    markWatchedLabel,
    onQuickPlay,
    onQuickToggleFavorite,
    onQuickToggleWatched,
  ]);

  const meta = formatVodMeta(item.year, item.rating);
  const ratio = !effectiveWatched ? computeProgressRatio(progress) : undefined;
  const seriesBadge = isSeries
    ? resolveSeriesBadgeProps({
        summary: unplayedSummary,
        progressWatched,
        watchedOverride,
        formatUnplayed,
        watchedLabel,
      })
    : {};
  const badge = !isSeries && effectiveWatched ? watchedLabel : undefined;

  return (
    <PosterCard
      testID={`catalog-quick-filter-item-${index}`}
      title={item.name}
      {...(meta !== undefined ? { meta } : {})}
      imageUri={item.logo}
      {...(ratio !== undefined ? { progress: ratio } : {})}
      {...(badge !== undefined ? { badge } : {})}
      {...seriesBadge}
      {...(quickActions !== undefined ? { quickActions } : {})}
      width={cardWidth}
      maxDecodePx={320}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
      onContextMenu={handleContextMenu}
    />
  );
});

/**
 * Responsive poster grid rendered when the Movies or Series quick filter tab is set to
 * `My List` (`mylist`) or `Watched` (`watched`), with reactive mutation updates and clean empty states.
 */
export function CatalogQuickFilterGrid({
  kind,
  filter,
  catalog,
  refreshToken,
  userStateVersion,
  layout,
  safeBottomInset,
  railItemsByCategoryId,
  progressByKey,
  unplayedBySeriesKey,
  favoriteKeys,
  watchedOverrides,
  focusedGridPos = null,
  onGridMetaChange,
  gridAccessRef,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
}: CatalogQuickFilterGridProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  const [favoriteRows, setFavoriteRows] = useState<readonly FavoriteRow[]>([]);
  const [favoriteLoaded, setFavoriteLoaded] = useState(false);
  const [optimisticRemovedFavKeys, setOptimisticRemovedFavKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [watchedRows, setWatchedRows] = useState<readonly WatchProgressRow[] | undefined>(
    undefined,
  );
  const [extraItems, setExtraItems] = useState<readonly ItemRow[]>([]);
  const [extraProgress, setExtraProgress] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => new Map(),
  );
  const [watchedLoaded, setWatchedLoaded] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion reload My List on external changes
  useEffect(() => {
    if (filter !== 'mylist') return undefined;
    let cancelled = false;
    setOptimisticRemovedFavKeys(new Set());
    if (!catalog.listFavorites) {
      setFavoriteRows([]);
      setFavoriteLoaded(true);
      return undefined;
    }
    void catalog
      .listFavorites(MY_LIST_LIMIT)
      .then(async (rows) => {
        if (cancelled) return;
        const matched = filterFavoritesForCatalog(rows, kind);
        setFavoriteRows(matched);
        setFavoriteLoaded(true);
        const keys = matched.map((r) => r.itemKey);
        if (keys.length > 0) {
          const prog = await batchLoadProgressByKeys(catalog, keys).catch(
            () => new Map<string, WatchProgressRow>(),
          );
          if (!cancelled) setExtraProgress(prog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFavoriteRows([]);
          setFavoriteLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, filter, kind, refreshToken, userStateVersion]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion reload watched catalog items
  useEffect(() => {
    if (filter !== 'watched') return undefined;
    let cancelled = false;
    const listWatched = (catalog as CatalogWithListWatched).listWatched;
    if (typeof listWatched === 'function') {
      void listWatched
        .call(catalog, WATCHED_LIST_LIMIT, undefined, { kind })
        .then((rows) => {
          if (cancelled) return;
          setWatchedRows(rows);
          const prog = new Map<string, WatchProgressRow>();
          for (const row of rows) {
            const key = kind === 'series' ? (row.seriesKey ?? row.itemKey) : row.itemKey;
            if (!prog.has(key)) prog.set(key, row);
          }
          setExtraProgress(prog);
          setWatchedLoaded(true);
        })
        .catch(() => {
          if (!cancelled) {
            setWatchedRows([]);
            setWatchedLoaded(true);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    setWatchedRows(undefined);
    if (!catalog.allSourcesItems) {
      setExtraItems([]);
      setWatchedLoaded(true);
      return undefined;
    }
    void catalog
      .allSourcesItems(kind, 0, WATCHED_SCAN_LIMIT)
      .then(async (rows) => {
        if (cancelled) return;
        setExtraItems(rows);
        const keys = rows.map((r) => r.key);
        if (keys.length > 0) {
          const prog = await batchLoadProgressByKeys(catalog, keys).catch(
            () => new Map<string, WatchProgressRow>(),
          );
          if (!cancelled) setExtraProgress(prog);
        }
        if (!cancelled) setWatchedLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setExtraItems([]);
          setWatchedLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, filter, kind, refreshToken, userStateVersion]);

  const mergedProgress = useMemo<ReadonlyMap<string, WatchProgressRow>>(() => {
    if (extraProgress.size === 0) return progressByKey;
    const merged = new Map(progressByKey);
    for (const [k, v] of extraProgress) merged.set(k, v);
    return merged;
  }, [extraProgress, progressByKey]);

  const restoreRemovedFavKey = useCallback((itemKey: string) => {
    setOptimisticRemovedFavKeys((prev) => {
      if (!prev.has(itemKey)) return prev;
      const next = new Set(prev);
      next.delete(itemKey);
      return next;
    });
  }, []);

  const handleToggleFavorite = useCallback(
    (item: ItemRow) => {
      if (filter === 'mylist') {
        setOptimisticRemovedFavKeys((prev) => {
          const next = new Set(prev);
          next.add(item.key);
          return next;
        });
      }
      try {
        const result = onQuickToggleFavorite?.(item);
        if (
          filter === 'mylist' &&
          result !== undefined &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        ) {
          void Promise.resolve(result)
            .then((ok) => {
              if (ok === false) restoreRemovedFavKey(item.key);
            })
            .catch(() => {
              restoreRemovedFavKey(item.key);
            });
        }
      } catch {
        if (filter === 'mylist') restoreRemovedFavKey(item.key);
      }
    },
    [filter, onQuickToggleFavorite, restoreRemovedFavKey],
  );

  const items = useMemo<readonly ItemRow[]>(() => {
    if (filter === 'mylist') {
      return favoriteRows
        .filter((row) => !optimisticRemovedFavKeys.has(row.itemKey))
        .map((row) => itemRowFromFavorite(row, kind));
    }
    return collectWatchedCatalogItems({
      kind,
      railItemsByCategoryId,
      ...(watchedRows !== undefined ? { watchedRows } : {}),
      extraItems,
      progressByKey: mergedProgress,
      watchedOverrides,
      ...(unplayedBySeriesKey !== undefined ? { unplayedBySeriesKey } : {}),
    });
  }, [
    extraItems,
    favoriteRows,
    filter,
    kind,
    mergedProgress,
    optimisticRemovedFavKeys,
    railItemsByCategoryId,
    unplayedBySeriesKey,
    watchedOverrides,
    watchedRows,
  ]);

  if (gridAccessRef !== undefined) {
    gridAccessRef.current = {
      itemCount: items.length,
      getItem: (idx: number) => items[idx],
    };
  }

  useEffect(() => {
    onGridMetaChange?.({ itemCount: items.length });
  }, [items.length, onGridMetaChange]);

  useEffect(() => {
    if (!layout.isTv || focusedGridPos === null) return;
    const targetY = Math.max(0, focusedGridPos.row * layout.gridRowHeight - theme.spacing.md);
    scrollRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
  }, [focusedGridPos, layout.gridRowHeight, layout.isTv, theme.reduceMotion, theme.spacing.md]);

  const focusedIndex =
    layout.isTv && focusedGridPos !== null
      ? focusedGridPos.row * layout.gridColumns + focusedGridPos.col
      : -1;

  const formatUnplayed = useCallback(
    (count: number) => i18n.t('card.unplayedCount', { count }),
    [i18n],
  );
  const formatQuickPlay = useCallback(
    (title: string) => i18n.t('card.quickPlay', { title }),
    [i18n],
  );

  const isSettled = filter === 'mylist' ? favoriteLoaded : watchedLoaded;
  if (isSettled && items.length === 0) {
    return (
      <CatalogEmptyState
        testID={filter === 'mylist' ? 'catalog-empty-mylist' : 'catalog-empty-watched'}
        title={i18n.t(
          filter === 'mylist' ? 'catalog.emptyMyListTitle' : 'catalog.emptyWatchedTitle',
        )}
        description={i18n.t(
          filter === 'mylist' ? 'catalog.emptyMyListBody' : 'catalog.emptyWatchedBody',
        )}
        layout={layout}
      />
    );
  }

  const watchedLabel = i18n.t('home.watchedBadge');
  const addToListLabel = i18n.t('home.addToList');
  const inMyListLabel = i18n.t('home.inMyList');
  const markWatchedLabel = i18n.t('home.markWatched');
  const markUnwatchedLabel = i18n.t('home.markUnwatched');

  return (
    <ScrollView
      ref={scrollRef}
      testID={`catalog-quick-filter-grid-${filter}`}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[
        styles.gridContent,
        {
          paddingHorizontal: layout.padX,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.xl + safeBottomInset + (layout.isPortrait ? 20 : 12),
          gap: layout.gridGap,
        },
      ]}
    >
      {items.map((item, index) => (
        <QuickFilterPosterItem
          key={item.key}
          item={item}
          index={index}
          progress={mergedProgress.get(item.key)}
          isFavorite={filter === 'mylist' ? true : favoriteKeys.has(item.key)}
          watchedOverride={watchedOverrides.get(item.key)}
          unplayedSummary={unplayedBySeriesKey?.get(item.key)}
          watchedLabel={watchedLabel}
          formatUnplayed={formatUnplayed}
          formatQuickPlay={formatQuickPlay}
          addToListLabel={addToListLabel}
          inMyListLabel={inMyListLabel}
          markWatchedLabel={markWatchedLabel}
          markUnwatchedLabel={markUnwatchedLabel}
          cardWidth={layout.gridCardWidth}
          isTv={layout.isTv}
          focused={index === focusedIndex}
          onOpenDetail={onOpenDetail}
          {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
          {...(onQuickToggleFavorite !== undefined
            ? { onQuickToggleFavorite: handleToggleFavorite }
            : {})}
          {...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {})}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  gridContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
});
