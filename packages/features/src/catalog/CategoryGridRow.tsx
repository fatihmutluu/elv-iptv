import type {
  ItemRow,
  ItemSortOrder,
  RatingValue,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import {
  type ContextMenuAnchor,
  Icon,
  PosterCard,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useContextMenu,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  type CatalogLayoutMetrics,
  type DetailTarget,
  detailTargetFromItem,
  formatVodMeta,
  hasManagedDownload,
  resolveSeriesBadgeProps,
  useDownloads,
} from '../shared';
import { useItemRowPosterHoverPreview } from '../shared/PosterHoverPreviewContext';
import { buildCatalogPosterContextMenuItems } from './catalog-context-menu';
import { computeProgressRatio } from './catalog-model';

interface GridPosterSlotProps {
  readonly item: ItemRow | undefined;
  readonly itemIndex: number;
  readonly categoryId: string;
  readonly progress: WatchProgressRow | undefined;
  readonly isFavorite: boolean;
  readonly watchedOverride: boolean | undefined;
  readonly currentRating: RatingValue | null;
  readonly unplayedSummary: SeriesUnplayedSummary | undefined;
  readonly watchedLabel: string;
  readonly cardWidth: number;
  readonly posterHeight: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onQuickToggleRating?: (item: ItemRow, next: RatingValue) => void;
  readonly onDismissRecommendation?: (item: ItemRow) => void;
}

const GridPosterSlot = memo(function GridPosterSlotInner({
  item,
  itemIndex,
  categoryId,
  progress,
  isFavorite,
  watchedOverride,
  currentRating,
  unplayedSummary,
  watchedLabel,
  cardWidth,
  posterHeight,
  isTv,
  focused,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
}: GridPosterSlotProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const { openContextMenu } = useContextMenu();
  const handlePress = useCallback(() => {
    if (!item) return;
    const target = detailTargetFromItem(item, categoryId);
    if (target) onOpenDetail(target);
  }, [categoryId, item, onOpenDetail]);

  const downloads = useDownloads();
  const isSeries = item?.kind === 'series';
  const progressWatched = progress?.watched === true;
  const effectiveWatched =
    watchedOverride ?? (progressWatched || (isSeries && unplayedSummary?.watched === true));

  const handleContextMenu = useCallback(
    (anchor?: ContextMenuAnchor) => {
      if (!item) return;
      const canDownloadMovie = downloads.supported && item.kind === 'movie';
      openContextMenu({
        title: item.name,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildCatalogPosterContextMenuItems({
          item,
          categoryId,
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
          ...(onDismissRecommendation !== undefined ? { onDismissRecommendation } : {}),
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
      categoryId,
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
    ],
  );

  const handleHoverPlay = useCallback(() => {
    if (!item) return;
    if (onQuickPlay) onQuickPlay(item, categoryId);
    else handlePress();
  }, [categoryId, handlePress, item, onQuickPlay]);

  const hoverHandlers = useItemRowPosterHoverPreview({
    item,
    categoryId,
    cardWidth,
    isFavorite,
    watched: effectiveWatched,
    userRating: currentRating,
    onPlay: handleHoverPlay,
    onOpenDetail: handlePress,
    ...(onQuickToggleFavorite !== undefined ? { onToggleFavorite: onQuickToggleFavorite } : {}),
    ...(onQuickToggleWatched !== undefined ? { onToggleWatched: onQuickToggleWatched } : {}),
    ...(onQuickToggleRating !== undefined ? { onToggleRating: onQuickToggleRating } : {}),
    ...(onDismissRecommendation !== undefined ? { onDismissRecommendation } : {}),
  });

  if (!item) {
    return (
      <View testID={`catalog-grid-skeleton-${itemIndex}`} style={{ width: cardWidth }}>
        <SkeletonBox width={cardWidth} height={posterHeight} borderRadius={theme.radius.card} />
        <SkeletonBox
          width="74%"
          height={12}
          borderRadius={theme.radius.button}
          style={styles.skeletonLabel}
        />
      </View>
    );
  }

  const meta = formatVodMeta(item.year, item.rating);
  const ratio = !effectiveWatched ? computeProgressRatio(progress) : undefined;
  const seriesBadge = isSeries
    ? resolveSeriesBadgeProps({
        summary: unplayedSummary,
        progressWatched,
        watchedOverride,
      })
    : {};
  const versionBadge =
    !isSeries && (item.versionCount ?? 0) > 1
      ? i18n.t('detail.versionCount', { count: item.versionCount ?? 0 })
      : undefined;
  const badge = !isSeries && effectiveWatched ? watchedLabel : versionBadge;

  return (
    <PosterCard
      testID={`catalog-grid-item-${itemIndex}`}
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

/** Props of {@link GridRowView}. */
export interface GridRowViewProps {
  readonly rowIndex: number;
  readonly items: readonly (ItemRow | undefined)[];
  readonly columns: number;
  readonly categoryId: string;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly watchedOverrides?: ReadonlyMap<string, boolean>;
  readonly ratingByKey?: ReadonlyMap<string, RatingValue>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly watchedLabel: string;
  readonly layout: CatalogLayoutMetrics;
  readonly focusedCol: number | null;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onQuickToggleRating?: (item: ItemRow, next: RatingValue) => void;
  readonly onDismissRecommendation?: (item: ItemRow) => void;
}

/**
 * Memoized fixed-height poster row for {@link CategoryGridView}, rendering exact-dimension
 * `SkeletonBox` placeholders for unloaded slots and decode-capped `PosterCard` items once loaded.
 */
export const GridRowView = memo(function GridRowViewInner({
  rowIndex,
  items,
  columns,
  categoryId,
  progressByKey,
  favoriteKeys,
  watchedOverrides,
  ratingByKey,
  unplayedBySeriesKey,
  watchedLabel,
  layout,
  focusedCol,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
}: GridRowViewProps): ReactElement {
  const posterHeight = Math.round(layout.gridCardWidth * 1.5);

  return (
    <View
      testID={`catalog-grid-row-${rowIndex}`}
      style={[
        styles.row,
        {
          height: layout.gridRowHeight,
          paddingHorizontal: layout.padX,
          paddingTop: layout.isTv ? 10 : 4,
          gap: layout.gridGap,
        },
      ]}
    >
      {items.map((item, colIdx) => {
        const itemIndex = rowIndex * columns + colIdx;
        return (
          <GridPosterSlot
            key={item ? item.key : `slot-${itemIndex}`}
            item={item}
            itemIndex={itemIndex}
            categoryId={categoryId}
            progress={item ? progressByKey.get(item.key) : undefined}
            isFavorite={item ? (favoriteKeys?.has(item.key) ?? false) : false}
            watchedOverride={item ? watchedOverrides?.get(item.key) : undefined}
            currentRating={item ? (ratingByKey?.get(item.key) ?? null) : null}
            unplayedSummary={item ? unplayedBySeriesKey?.get(item.key) : undefined}
            watchedLabel={watchedLabel}
            cardWidth={layout.gridCardWidth}
            posterHeight={posterHeight}
            isTv={layout.isTv}
            focused={layout.isTv && focusedCol === colIdx}
            onOpenDetail={onOpenDetail}
            {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
            {...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {})}
            {...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {})}
            {...(onQuickToggleRating !== undefined ? { onQuickToggleRating } : {})}
            {...(onDismissRecommendation !== undefined ? { onDismissRecommendation } : {})}
          />
        );
      })}
    </View>
  );
});

/** Props of {@link GridHeaderBar}. */
export interface GridHeaderBarProps {
  readonly backLabel: string;
  readonly categoryLabel: string;
  readonly countLabel: string;
  readonly layout: CatalogLayoutMetrics;
  readonly backFocused: boolean;
  readonly sortFocused?: boolean;
  readonly onBack: () => void;
  readonly sortBy?: ItemSortOrder;
  readonly onToggleSort?: () => void;
}

/** Header bar above {@link CategoryGridView} with `Back to Movies`/`Back to Series`, title, and count. */
export function GridHeaderBar({
  backLabel,
  categoryLabel,
  countLabel,
  layout,
  backFocused,
  sortFocused = false,
  onBack,
  sortBy = 'default',
  onToggleSort,
}: GridHeaderBarProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, opacity, transform');
  const isAlpha = sortBy === 'alpha';
  const sortLabel = i18n.t('catalog.sortAlpha');
  const sortA11yLabel = isAlpha
    ? i18n.t('catalog.sortDefaultLabel')
    : i18n.t('catalog.sortAlphaLabel');

  return (
    <View style={[styles.header, { paddingHorizontal: layout.padX }]}>
      <Pressable
        testID="catalog-grid-back"
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        focusable={!layout.isTv}
        onPress={onBack}
        style={({ pressed }) => [
          styles.backButton,
          layout.isTouch ? styles.touchTarget : null,
          {
            borderRadius: theme.radius.button,
            backgroundColor: backFocused ? theme.colors.focusFill : theme.colors.chipBg,
            borderWidth: backFocused ? theme.focus.ringWidth : 1,
            borderColor: backFocused ? theme.colors.focusRingColor : theme.colors.chipBorder,
            opacity: pressed ? 0.8 : 1,
            transform: [{ scale: backFocused ? theme.focus.buttonScale : 1 }],
          },
          cursor,
          transition,
        ]}
      >
        <Icon name="back" size={16} color={theme.colors.textPrimary} />
        <Text
          style={[theme.typography.caption, { color: theme.colors.textPrimary, fontWeight: '600' }]}
        >
          {backLabel}
        </Text>
      </Pressable>

      <View style={styles.headerMeta}>
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.categoryName, { color: theme.colors.textPrimary }]}
        >
          {categoryLabel}
        </Text>
        <Text
          numberOfLines={1}
          style={[theme.typography.caption, TABULAR_NUMS_STYLE, { color: theme.colors.textMuted }]}
        >
          {countLabel}
        </Text>
        {onToggleSort ? (
          <Pressable
            testID="catalog-grid-sort"
            accessibilityRole="button"
            accessibilityLabel={sortA11yLabel}
            accessibilityState={{ selected: isAlpha }}
            focusable={!layout.isTv}
            onPress={onToggleSort}
            style={({ pressed }) => [
              styles.sortButton,
              layout.isTouch ? styles.touchTarget : null,
              {
                borderRadius: theme.radius.button,
                backgroundColor: sortFocused
                  ? theme.colors.focusFill
                  : isAlpha
                    ? theme.colors.accentTint
                    : theme.colors.chipBg,
                borderWidth: sortFocused ? theme.focus.ringWidth : 1,
                borderColor: sortFocused
                  ? theme.colors.focusRingColor
                  : isAlpha
                    ? theme.colors.accent
                    : theme.colors.chipBorder,
                opacity: pressed ? 0.8 : 1,
                transform: [{ scale: sortFocused ? theme.focus.buttonScale : 1 }],
              },
              cursor,
              transition,
            ]}
          >
            <Text
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                {
                  color:
                    sortFocused || isAlpha ? theme.colors.textPrimary : theme.colors.textSecondary,
                  fontWeight: '600',
                },
              ]}
            >
              {sortLabel}
            </Text>
            {sortFocused ? (
              <View
                pointerEvents="none"
                testID="catalog-grid-sort-focus-ring"
                style={[
                  styles.sortFocusRing,
                  {
                    borderRadius: theme.radius.button,
                    borderWidth: theme.focus.ringWidth,
                    borderColor: theme.colors.focusRingColor,
                  },
                ]}
              />
            ) : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
    marginBottom: 12,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  touchTarget: { minHeight: 40, minWidth: 40 },
  sortButton: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  sortFocusRing: {
    position: 'absolute',
    top: -3,
    bottom: -3,
    left: -3,
    right: -3,
  },
  headerMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  categoryName: { flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  skeletonLabel: { marginTop: 8 },
});
