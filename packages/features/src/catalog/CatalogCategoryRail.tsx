import type { ItemRow, RatingValue, SeriesUnplayedSummary, WatchProgressRow } from '@elv/data';
import {
  type ContextMenuAnchor,
  HorizontalRailScroll,
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
import { type ComponentRef, memo, type ReactElement, useCallback, useEffect, useRef } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  type ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  type DetailTarget,
  type DisplayCategory,
  detailTargetFromItem,
  formatVodMeta,
  hasManagedDownload,
  resolveSeriesBadgeProps,
  useDownloads,
} from '../shared';
import { useItemRowPosterHoverPreview } from '../shared/PosterHoverPreviewContext';
import { buildCatalogPosterContextMenuItems } from './catalog-context-menu';
import { computeProgressRatio } from './catalog-model';

/** Props of {@link CatalogCategoryRail}. */
export interface CatalogCategoryRailProps {
  readonly category: DisplayCategory;
  readonly catIndex: number;
  readonly items: readonly ItemRow[];
  readonly loading: boolean;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly watchedOverrides?: ReadonlyMap<string, boolean>;
  readonly ratingByKey?: ReadonlyMap<string, RatingValue>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focusedIndex: number | null;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onQuickToggleRating?: (item: ItemRow, next: RatingValue) => void;
  readonly onDismissRecommendation?: (item: ItemRow) => void;
  readonly onSeeAll: (categoryId: string) => void;
  readonly onLayoutY?: (catIndex: number, y: number) => void;
}

const SKELETON_SLOTS = [0, 1, 2, 3, 4, 5] as const;

interface CatalogPosterCardItemProps {
  readonly item: ItemRow;
  readonly categoryId: string;
  readonly progress: WatchProgressRow | undefined;
  readonly isFavorite: boolean;
  readonly watchedOverride: boolean | undefined;
  readonly currentRating: RatingValue | null;
  readonly unplayedSummary: SeriesUnplayedSummary | undefined;
  readonly watchedLabel: string;
  readonly cardWidth: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly testID: string;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onQuickToggleRating?: (item: ItemRow, next: RatingValue) => void;
  readonly onDismissRecommendation?: (item: ItemRow) => void;
}

const CatalogPosterCardItem = memo(function CatalogPosterCardItemInner({
  item,
  categoryId,
  progress,
  isFavorite,
  watchedOverride,
  currentRating,
  unplayedSummary,
  watchedLabel,
  cardWidth,
  isTv,
  focused,
  testID,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
}: CatalogPosterCardItemProps): ReactElement {
  const handlePress = useCallback(() => {
    const target = detailTargetFromItem(item, categoryId);
    if (target) onOpenDetail(target);
  }, [categoryId, item, onOpenDetail]);
  const i18n = useI18n();
  const { openContextMenu } = useContextMenu();
  const downloads = useDownloads();

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
      testID={testID}
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

function CatalogCategoryRailInner({
  category,
  catIndex,
  items,
  loading,
  progressByKey,
  favoriteKeys,
  watchedOverrides,
  ratingByKey,
  unplayedBySeriesKey,
  cardWidth,
  gap,
  padX,
  isTv,
  isTouch,
  focusedIndex,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
  onSeeAll,
  onLayoutY,
}: CatalogCategoryRailProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!isTv || focusedIndex === null || focusedIndex < 0 || focusedIndex >= items.length) return;
    const x = Math.max(0, focusedIndex * (cardWidth + gap) - padX);
    scrollRef.current?.scrollTo({ x, animated: !theme.reduceMotion });
  }, [cardWidth, focusedIndex, gap, isTv, items.length, padX, theme.reduceMotion]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLayoutY?.(catIndex, event.nativeEvent.layout.y);
    },
    [catIndex, onLayoutY],
  );

  const handleSeeAll = useCallback(() => {
    onSeeAll(category.row.id);
  }, [category.row.id, onSeeAll]);

  if (!loading && items.length === 0) return null;

  const cursor = webCursorPointer();
  const linkTransition = webTransition(theme, 'color, opacity, background-color, transform');
  const watchedLabel = i18n.t('home.watchedBadge');
  const seeAllLabel = i18n.t('catalog.seeAll');
  const countLabel = i18n.t('catalog.itemsCount', { count: category.row.itemCount });
  const seeAllFocused = isTv && focusedIndex === items.length;
  const posterHeight = Math.round(cardWidth * 1.5);

  return (
    <View
      testID={`catalog-rail-${catIndex}`}
      onLayout={onLayoutY ? handleLayout : undefined}
      style={styles.section}
    >
      <View style={[styles.header, { paddingHorizontal: padX }]}>
        <View style={styles.titleGroup}>
          <Text
            numberOfLines={1}
            style={[theme.typography.h2, styles.title, { color: theme.colors.textPrimary }]}
          >
            {category.label}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textMuted },
            ]}
          >
            {countLabel}
          </Text>
        </View>

        <Pressable
          testID={`catalog-rail-see-all-${catIndex}`}
          accessibilityRole="button"
          accessibilityLabel={`${seeAllLabel} ${category.label}`}
          focusable={!isTv}
          onPress={handleSeeAll}
          style={({ pressed }) => [
            styles.seeAllButton,
            isTouch ? styles.touchTarget : null,
            {
              borderRadius: theme.radius.button,
              backgroundColor: seeAllFocused ? theme.colors.focusFill : 'transparent',
              borderWidth: seeAllFocused ? theme.focus.ringWidth : 0,
              borderColor: seeAllFocused ? theme.colors.focusRingColor : 'transparent',
              opacity: pressed ? 0.72 : 1,
              transform: [{ scale: seeAllFocused ? theme.focus.buttonScale : 1 }],
            },
            cursor,
            linkTransition,
          ]}
        >
          <Text
            style={[
              theme.typography.caption,
              { color: seeAllFocused ? theme.colors.textPrimary : theme.colors.textSecondary },
            ]}
          >
            {seeAllLabel}
          </Text>
          <Icon
            name="chevronRight"
            size={14}
            color={seeAllFocused ? theme.colors.textPrimary : theme.colors.textSecondary}
          />
        </Pressable>
      </View>

      <HorizontalRailScroll
        scrollRef={scrollRef}
        testID={`catalog-rail-${catIndex}-strip`}
        isTv={isTv}
        contentContainerStyle={[
          styles.stripContent,
          {
            paddingHorizontal: padX,
            paddingTop: isTv ? 18 : 8,
            paddingBottom: isTv ? 20 : 12,
            gap,
          },
        ]}
      >
        {loading
          ? SKELETON_SLOTS.map((slot) => (
              <View key={slot} style={{ width: cardWidth }}>
                <SkeletonBox
                  width={cardWidth}
                  height={posterHeight}
                  borderRadius={theme.radius.card}
                />
                <SkeletonBox
                  width="78%"
                  height={12}
                  borderRadius={theme.radius.button}
                  style={styles.skeletonLabel}
                />
              </View>
            ))
          : items.map((item, itemIdx) => (
              <CatalogPosterCardItem
                key={item.key}
                item={item}
                categoryId={category.row.id}
                progress={progressByKey.get(item.key)}
                isFavorite={favoriteKeys?.has(item.key) ?? false}
                watchedOverride={watchedOverrides?.get(item.key)}
                currentRating={ratingByKey?.get(item.key) ?? null}
                unplayedSummary={unplayedBySeriesKey?.get(item.key)}
                watchedLabel={watchedLabel}
                cardWidth={cardWidth}
                isTv={isTv}
                focused={isTv && focusedIndex === itemIdx}
                testID={`catalog-rail-${catIndex}-item-${itemIdx}`}
                onOpenDetail={onOpenDetail}
                {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
                {...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {})}
                {...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {})}
                {...(onQuickToggleRating !== undefined ? { onQuickToggleRating } : {})}
                {...(onDismissRecommendation !== undefined ? { onDismissRecommendation } : {})}
              />
            ))}
      </HorizontalRailScroll>
    </View>
  );
}

/**
 * Memoized Cinema Quietude horizontal `2:3` poster peek rail for Movies & Series Discovery Mode
 * with decode-capped posters, zero-CLS skeletons, `See all ›` drill-down, and non-clipping TV focus.
 */
export const CatalogCategoryRail = memo(CatalogCategoryRailInner);
CatalogCategoryRail.displayName = 'CatalogCategoryRail';

const styles = StyleSheet.create({
  section: { marginTop: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 4,
  },
  titleGroup: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    flexShrink: 1,
  },
  title: { flexShrink: 1 },
  seeAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  touchTarget: { minHeight: 40, minWidth: 40, justifyContent: 'center' },
  stripContent: { alignItems: 'flex-start' },
  skeletonLabel: { marginTop: 8 },
});
