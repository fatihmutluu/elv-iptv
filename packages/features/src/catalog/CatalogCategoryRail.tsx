import type { ItemRow, SeriesUnplayedSummary, WatchProgressRow } from '@elv/data';
import {
  HorizontalRailScroll,
  Icon,
  PosterCard,
  type PosterCardQuickActions,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
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
  resolveSeriesBadgeProps,
} from '../shared';
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
  readonly testID: string;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
}

const CatalogPosterCardItem = memo(function CatalogPosterCardItemInner({
  item,
  categoryId,
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
  testID,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
}: CatalogPosterCardItemProps): ReactElement {
  const handlePress = useCallback(() => {
    const target = detailTargetFromItem(item, categoryId);
    if (target) onOpenDetail(target);
  }, [categoryId, item, onOpenDetail]);

  const isSeries = item.kind === 'series';
  const progressWatched = progress?.watched === true;
  const effectiveWatched =
    watchedOverride ?? (progressWatched || (isSeries && unplayedSummary?.watched === true));

  const quickActions = useMemo<PosterCardQuickActions | undefined>(() => {
    if (!onQuickPlay && !onQuickToggleFavorite && !onQuickToggleWatched) return undefined;
    return {
      ...(onQuickPlay !== undefined
        ? {
            onPlay: () => onQuickPlay(item, categoryId),
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
    categoryId,
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
      testID={testID}
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

  const formatUnplayed = useCallback(
    (count: number) => i18n.t('card.unplayedCount', { count }),
    [i18n],
  );
  const formatQuickPlay = useCallback(
    (title: string) => i18n.t('card.quickPlay', { title }),
    [i18n],
  );

  if (!loading && items.length === 0) return null;

  const cursor = webCursorPointer();
  const linkTransition = webTransition(theme, 'color, opacity, background-color, transform');
  const watchedLabel = i18n.t('home.watchedBadge');
  const addToListLabel = i18n.t('home.addToList');
  const inMyListLabel = i18n.t('home.inMyList');
  const markWatchedLabel = i18n.t('home.markWatched');
  const markUnwatchedLabel = i18n.t('home.markUnwatched');
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
                unplayedSummary={unplayedBySeriesKey?.get(item.key)}
                watchedLabel={watchedLabel}
                formatUnplayed={formatUnplayed}
                formatQuickPlay={formatQuickPlay}
                addToListLabel={addToListLabel}
                inMyListLabel={inMyListLabel}
                markWatchedLabel={markWatchedLabel}
                markUnwatchedLabel={markUnwatchedLabel}
                cardWidth={cardWidth}
                isTv={isTv}
                focused={isTv && focusedIndex === itemIdx}
                testID={`catalog-rail-${catIndex}-item-${itemIdx}`}
                onOpenDetail={onOpenDetail}
                {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
                {...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {})}
                {...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {})}
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
