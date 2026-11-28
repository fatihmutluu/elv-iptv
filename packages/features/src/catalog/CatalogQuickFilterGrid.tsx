import type {
  CatalogService,
  FavoriteRow,
  ItemRow,
  RatingValue,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { type ContextMenuAnchor, PosterCard, useContextMenu, useI18n, useTheme } from '@elv/ui-kit';
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
  hasManagedDownload,
  resolveSeriesBadgeProps,
  useDownloads,
} from '../shared';
import { useItemRowPosterHoverPreview } from '../shared/PosterHoverPreviewContext';
import { CatalogEmptyState } from './CatalogChrome';
import type { CategoryGridAccess, CategoryGridMeta } from './CategoryGridView';
import { buildCatalogPosterContextMenuItems } from './catalog-context-menu';
import {
  computeProgressRatio,
  filterFavoritesForCatalog,
  type GridFocusPosition,
  itemRowFromFavorite,
} from './catalog-model';
import { useElvPicksData } from './useElvPicksData';

const MY_LIST_LIMIT = 250;

/** Props of {@link CatalogQuickFilterGrid}. */
export interface CatalogQuickFilterGridProps {
  readonly kind: 'movie' | 'series';
  readonly filter: 'mylist' | 'elvPicks';
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly elvPreferences?: ElvModePreferences;
  readonly layout: CatalogLayoutMetrics;
  readonly safeBottomInset: number;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly ratingByKey?: ReadonlyMap<string, RatingValue>;
  readonly dismissedKeys?: ReadonlySet<string>;
  readonly focusedGridPos?: GridFocusPosition | null;
  readonly onGridMetaChange?: (meta: CategoryGridMeta) => void;
  readonly gridAccessRef?: MutableRefObject<CategoryGridAccess>;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => unknown;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => unknown;
  readonly onQuickToggleRating?: (item: ItemRow, next: RatingValue) => unknown;
  readonly onDismissRecommendation?: (item: ItemRow) => unknown;
}

interface QuickFilterPosterItemProps {
  readonly item: ItemRow;
  readonly index: number;
  readonly reasonBadge?: string;
  readonly progress: WatchProgressRow | undefined;
  readonly isFavorite: boolean;
  readonly watchedOverride: boolean | undefined;
  readonly currentRating: RatingValue | null;
  readonly unplayedSummary: SeriesUnplayedSummary | undefined;
  readonly watchedLabel: string;
  readonly cardWidth: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly showContextDismiss: boolean;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => unknown;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => unknown;
  readonly onQuickToggleRating?: (item: ItemRow, next: RatingValue) => unknown;
  readonly onDismissRecommendation?: (item: ItemRow) => unknown;
}

const QuickFilterPosterItem = memo(function QuickFilterPosterItemInner({
  item,
  index,
  reasonBadge,
  progress,
  isFavorite,
  watchedOverride,
  currentRating,
  unplayedSummary,
  watchedLabel,
  cardWidth,
  isTv,
  focused,
  showContextDismiss,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
}: QuickFilterPosterItemProps): ReactElement {
  const i18n = useI18n();
  const { openContextMenu } = useContextMenu();
  const downloads = useDownloads();

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
      const canDownloadMovie = downloads.supported && item.kind === 'movie';
      openContextMenu({
        title: item.name,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildCatalogPosterContextMenuItems({
          item,
          isFavorite,
          isWatched: effectiveWatched,
          currentRating,
          isDownloaded: canDownloadMovie && hasManagedDownload(downloads.byItemKey.get(item.key)),
          i18n,
          onOpenDetail,
          ...(onQuickPlay !== undefined ? { onQuickPlay } : {}),
          ...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {}),
          ...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {}),
          ...(onQuickToggleRating !== undefined ? { onQuickToggleRating } : {}),
          ...(showContextDismiss && onDismissRecommendation !== undefined
            ? { onDismissRecommendation }
            : {}),
          ...(canDownloadMovie
            ? {
                onDownload: (it: ItemRow) => {
                  void downloads.enqueue({
                    sourceId: it.sourceId,
                    itemKey: it.key,
                    kind: 'movie',
                    title: it.name,
                    poster: it.logo ?? null,
                  });
                },
                onDeleteDownload: (it: ItemRow) => {
                  void downloads.remove(it.key);
                },
              }
            : {}),
        }),
      });
    },
    [
      currentRating,
      downloads,
      effectiveWatched,
      i18n,
      isFavorite,
      item,
      onDismissRecommendation,
      onOpenDetail,
      onQuickPlay,
      onQuickToggleFavorite,
      onQuickToggleRating,
      onQuickToggleWatched,
      openContextMenu,
      showContextDismiss,
    ],
  );

  const handleHoverPlay = useCallback(() => {
    if (onQuickPlay) onQuickPlay(item, '');
    else handlePress();
  }, [handlePress, item, onQuickPlay]);

  const hoverHandlers = useItemRowPosterHoverPreview({
    item,
    cardWidth,
    isFavorite,
    watched: effectiveWatched,
    userRating: currentRating,
    allowDismissRecommendation: showContextDismiss,
    onPlay: handleHoverPlay,
    onOpenDetail: handlePress,
    ...(onQuickToggleFavorite !== undefined ? { onToggleFavorite: onQuickToggleFavorite } : {}),
    ...(onQuickToggleWatched !== undefined ? { onToggleWatched: onQuickToggleWatched } : {}),
    ...(onQuickToggleRating !== undefined ? { onToggleRating: onQuickToggleRating } : {}),
    ...(showContextDismiss && onDismissRecommendation !== undefined
      ? { onDismissRecommendation }
      : {}),
  });

  const meta = formatVodMeta(item.year, item.rating);
  const ratio = !effectiveWatched ? computeProgressRatio(progress) : undefined;
  const seriesBadge = isSeries
    ? resolveSeriesBadgeProps({
        summary: unplayedSummary,
        progressWatched,
        watchedOverride,
      })
    : {};
  const badge = reasonBadge ?? (!isSeries && effectiveWatched ? watchedLabel : undefined);

  return (
    <PosterCard
      testID={`catalog-quick-filter-item-${index}`}
      title={item.name}
      {...(meta !== undefined ? { meta } : {})}
      imageUri={item.logo}
      {...(ratio !== undefined ? { progress: ratio } : {})}
      {...(badge !== undefined ? { badge } : {})}
      {...seriesBadge}
      {...hoverHandlers}
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
 * `My List` (`mylist`) or opt-in `ELV Picks` (`elvPicks`), with reactive mutation updates and
 * clean empty states (`#508`).
 */
export function CatalogQuickFilterGrid({
  kind,
  filter,
  catalog,
  refreshToken,
  userStateVersion,
  elvPreferences,
  layout,
  safeBottomInset,
  progressByKey,
  unplayedBySeriesKey,
  favoriteKeys,
  watchedOverrides,
  ratingByKey,
  dismissedKeys,
  focusedGridPos = null,
  onGridMetaChange,
  gridAccessRef,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
}: CatalogQuickFilterGridProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const mountedRef = useRef(true);
  const elvPrefs = elvPreferences ?? DEFAULT_ELV_MODE_PREFERENCES;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [favoriteRows, setFavoriteRows] = useState<readonly FavoriteRow[]>([]);
  const [favoriteLoaded, setFavoriteLoaded] = useState(false);
  const [picksRefreshTick, setPicksRefreshTick] = useState(0);
  const [optimisticRemovedFavKeys, setOptimisticRemovedFavKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [extraProgress, setExtraProgress] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => new Map(),
  );

  const elvPicksData = useElvPicksData({
    enabled: filter === 'elvPicks',
    kind,
    catalog,
    refreshToken,
    userStateVersion,
    localRefreshTick: picksRefreshTick,
    elvPrefs,
    ...(dismissedKeys !== undefined ? { dismissedKeys } : {}),
    i18n,
  });

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

  const mergedProgress = useMemo<ReadonlyMap<string, WatchProgressRow>>(() => {
    const sourceProgress = filter === 'elvPicks' ? elvPicksData.progressByKey : extraProgress;
    if (sourceProgress.size === 0) return progressByKey;
    const merged = new Map(progressByKey);
    for (const [k, v] of sourceProgress) merged.set(k, v);
    return merged;
  }, [elvPicksData.progressByKey, extraProgress, filter, progressByKey]);

  const restoreRemovedFavKey = useCallback((itemKey: string) => {
    setOptimisticRemovedFavKeys((prev) => {
      if (!prev.has(itemKey)) return prev;
      const next = new Set(prev);
      next.delete(itemKey);
      return next;
    });
  }, []);

  const bumpPicksIfActive = useCallback(() => {
    if (mountedRef.current && filter === 'elvPicks') setPicksRefreshTick((t) => t + 1);
  }, [filter]);

  const handleToggleFavorite = useCallback(
    (item: ItemRow): Promise<boolean> => {
      if (filter === 'mylist') {
        setOptimisticRemovedFavKeys((prev) => {
          const next = new Set(prev);
          next.add(item.key);
          return next;
        });
      }
      try {
        const result = onQuickToggleFavorite?.(item);
        if (result !== undefined && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            (ok) => {
              if (mountedRef.current) {
                if (filter === 'mylist' && ok === false) restoreRemovedFavKey(item.key);
                if (filter === 'elvPicks' && ok !== false) bumpPicksIfActive();
              }
              return ok !== false;
            },
            () => {
              if (mountedRef.current && filter === 'mylist') restoreRemovedFavKey(item.key);
              return false;
            },
          );
        }
        bumpPicksIfActive();
        return Promise.resolve(true);
      } catch {
        if (filter === 'mylist') restoreRemovedFavKey(item.key);
        return Promise.resolve(false);
      }
    },
    [bumpPicksIfActive, filter, onQuickToggleFavorite, restoreRemovedFavKey],
  );

  const handleToggleWatched = useCallback(
    (item: ItemRow, currentWatched: boolean): Promise<boolean> => {
      try {
        const result = onQuickToggleWatched?.(item, currentWatched);
        if (result !== undefined && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            (ok) => {
              if (mountedRef.current && ok !== false) bumpPicksIfActive();
              return ok !== false;
            },
            () => false,
          );
        }
        bumpPicksIfActive();
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
    [bumpPicksIfActive, onQuickToggleWatched],
  );

  const handleToggleRating = useCallback(
    (item: ItemRow, next: RatingValue): Promise<boolean> => {
      try {
        const result = onQuickToggleRating?.(item, next);
        if (result !== undefined && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            (ok) => {
              if (mountedRef.current && ok !== false) bumpPicksIfActive();
              return ok !== false;
            },
            () => false,
          );
        }
        bumpPicksIfActive();
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
    [bumpPicksIfActive, onQuickToggleRating],
  );

  const handleDismissRecommendation = useCallback(
    (item: ItemRow): Promise<boolean> => {
      try {
        const result = onDismissRecommendation?.(item);
        if (result !== undefined && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            (ok) => {
              if (mountedRef.current && ok !== false) bumpPicksIfActive();
              return ok !== false;
            },
            () => false,
          );
        }
        bumpPicksIfActive();
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
    [bumpPicksIfActive, onDismissRecommendation],
  );

  const reasonByKey = useMemo<ReadonlyMap<string, string>>(() => {
    if (filter !== 'elvPicks' || elvPicksData.picks.length === 0) return new Map();
    const map = new Map<string, string>();
    for (const pick of elvPicksData.picks) map.set(pick.item.key, pick.reasonLabel);
    return map;
  }, [elvPicksData.picks, filter]);

  const items = useMemo<readonly ItemRow[]>(() => {
    if (filter === 'mylist') {
      return favoriteRows
        .filter((row) => !optimisticRemovedFavKeys.has(row.itemKey))
        .map((row) => itemRowFromFavorite(row, kind));
    }
    return elvPicksData.picks.map((pick) => pick.item);
  }, [elvPicksData.picks, favoriteRows, filter, kind, optimisticRemovedFavKeys]);

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

  const isSettled = filter === 'mylist' ? favoriteLoaded : elvPicksData.loaded;
  if (isSettled && items.length === 0) {
    return (
      <CatalogEmptyState
        testID={filter === 'mylist' ? 'catalog-empty-mylist' : 'catalog-empty-elv-picks'}
        title={i18n.t(
          filter === 'mylist' ? 'catalog.emptyMyListTitle' : 'catalog.elvPicks.emptyTitle',
        )}
        description={i18n.t(
          filter === 'mylist' ? 'catalog.emptyMyListBody' : 'catalog.elvPicks.emptyBody',
        )}
        layout={layout}
      />
    );
  }

  const watchedLabel = i18n.t('home.watchedBadge');

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
      {items.map((item, index) => {
        const reasonBadge = reasonByKey.get(item.key);
        return (
          <QuickFilterPosterItem
            key={item.key}
            item={item}
            index={index}
            {...(reasonBadge !== undefined ? { reasonBadge } : {})}
            progress={mergedProgress.get(item.key)}
            isFavorite={filter === 'mylist' ? true : favoriteKeys.has(item.key)}
            watchedOverride={watchedOverrides.get(item.key)}
            currentRating={ratingByKey?.get(item.key) ?? null}
            unplayedSummary={unplayedBySeriesKey?.get(item.key)}
            watchedLabel={watchedLabel}
            cardWidth={layout.gridCardWidth}
            isTv={layout.isTv}
            focused={index === focusedIndex}
            showContextDismiss={filter === 'elvPicks'}
            onOpenDetail={onOpenDetail}
            {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
            {...(onQuickToggleFavorite !== undefined
              ? { onQuickToggleFavorite: handleToggleFavorite }
              : {})}
            {...(onQuickToggleWatched !== undefined
              ? { onQuickToggleWatched: handleToggleWatched }
              : {})}
            {...(onQuickToggleRating !== undefined
              ? { onQuickToggleRating: handleToggleRating }
              : {})}
            {...(filter === 'elvPicks' && onDismissRecommendation !== undefined
              ? { onDismissRecommendation: handleDismissRecommendation }
              : {})}
          />
        );
      })}
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
