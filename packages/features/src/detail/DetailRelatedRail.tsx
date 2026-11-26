import type { ItemRow, SeriesUnplayedSummary, WatchProgressRow } from '@elv/data';
import {
  HorizontalRailScroll,
  PosterCard,
  type PosterCardQuickActions,
  useI18n,
  useTheme,
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
import { type LayoutChangeEvent, type ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatVodMeta, resolveSeriesBadgeProps } from '../shared';
import { detailProgressRatio } from './detail-model';

/** Props of {@link DetailRelatedRail}. */
export interface DetailRelatedRailProps {
  readonly items: readonly ItemRow[];
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly watchedOverrides?: ReadonlyMap<string, boolean>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedIndex: number | null;
  readonly onPressItem: (item: ItemRow) => void;
  readonly onQuickPlay?: (item: ItemRow) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onLayoutY?: (y: number) => void;
}

interface RelatedPosterItemProps {
  readonly item: ItemRow;
  readonly index: number;
  readonly progress: WatchProgressRow | undefined;
  readonly isFavorite: boolean;
  readonly watchedOverride: boolean | undefined;
  readonly unplayedSummary: SeriesUnplayedSummary | undefined;
  readonly cardWidth: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly watchedLabel: string;
  readonly formatQuickPlay: (title: string) => string;
  readonly addToListLabel: string;
  readonly inMyListLabel: string;
  readonly markWatchedLabel: string;
  readonly markUnwatchedLabel: string;
  readonly onPressItem: (item: ItemRow) => void;
  readonly onQuickPlay?: (item: ItemRow) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
}

const RelatedPosterItem = memo(function RelatedPosterItemInner({
  item,
  index,
  progress,
  isFavorite,
  watchedOverride,
  unplayedSummary,
  cardWidth,
  isTv,
  focused,
  watchedLabel,
  formatQuickPlay,
  addToListLabel,
  inMyListLabel,
  markWatchedLabel,
  markUnwatchedLabel,
  onPressItem,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
}: RelatedPosterItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onPressItem(item);
  }, [item, onPressItem]);

  const isSeries = item.kind === 'series';
  const progressWatched = progress?.watched === true;
  const effectiveWatched =
    watchedOverride ?? (progressWatched || (isSeries && unplayedSummary?.watched === true));

  const quickActions = useMemo<PosterCardQuickActions | undefined>(() => {
    if (!onQuickPlay && !onQuickToggleFavorite && !onQuickToggleWatched) return undefined;
    return {
      ...(onQuickPlay !== undefined
        ? {
            onPlay: () => onQuickPlay(item),
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
  const ratio =
    progress && !effectiveWatched && progress.positionMs > 0 && progress.durationMs > 0
      ? detailProgressRatio(progress.positionMs, progress.durationMs)
      : undefined;
  const seriesBadge = isSeries
    ? resolveSeriesBadgeProps({
        summary: unplayedSummary,
        progressWatched,
        watchedOverride,
      })
    : {};
  const badge = !isSeries && effectiveWatched ? watchedLabel : undefined;

  return (
    <PosterCard
      testID={`detail-related-item-${index}`}
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

function DetailRelatedRailInner({
  items,
  progressByKey,
  favoriteKeys,
  watchedOverrides,
  unplayedBySeriesKey,
  cardWidth,
  gap,
  padX,
  isTv,
  focusedIndex,
  onPressItem,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onLayoutY,
}: DetailRelatedRailProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!isTv || focusedIndex === null || focusedIndex < 0) return;
    const x = Math.max(0, focusedIndex * (cardWidth + gap) - padX);
    scrollRef.current?.scrollTo({ x, animated: !theme.reduceMotion });
  }, [cardWidth, focusedIndex, gap, isTv, padX, theme.reduceMotion]);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onLayoutY?.(e.nativeEvent.layout.y);
    },
    [onLayoutY],
  );

  const formatQuickPlay = useCallback(
    (title: string) => i18n.t('card.quickPlay', { title }),
    [i18n],
  );

  if (items.length === 0) return null;

  const watchedLabel = i18n.t('home.watchedBadge');
  const addToListLabel = i18n.t('home.addToList');
  const inMyListLabel = i18n.t('home.inMyList');
  const markWatchedLabel = i18n.t('home.markWatched');
  const markUnwatchedLabel = i18n.t('home.markUnwatched');

  return (
    <View
      testID="detail-related-rail"
      onLayout={onLayoutY ? handleLayout : undefined}
      style={[styles.section, { marginTop: theme.spacing.lg }]}
    >
      <Text
        numberOfLines={1}
        style={[
          theme.typography.h2,
          { color: theme.colors.textPrimary, paddingHorizontal: padX, marginBottom: 4 },
        ]}
      >
        {i18n.t('detail.moreLikeThis')}
      </Text>

      <HorizontalRailScroll
        scrollRef={scrollRef}
        testID="detail-related-rail-strip"
        isTv={isTv}
        showArrows={!isTv}
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
        {items.map((item, index) => (
          <RelatedPosterItem
            key={item.key}
            item={item}
            index={index}
            progress={progressByKey.get(item.key)}
            isFavorite={favoriteKeys?.has(item.key) ?? false}
            watchedOverride={watchedOverrides?.get(item.key)}
            unplayedSummary={unplayedBySeriesKey?.get(item.key)}
            cardWidth={cardWidth}
            isTv={isTv}
            focused={isTv && focusedIndex === index}
            watchedLabel={watchedLabel}
            formatQuickPlay={formatQuickPlay}
            addToListLabel={addToListLabel}
            inMyListLabel={inMyListLabel}
            markWatchedLabel={markWatchedLabel}
            markUnwatchedLabel={markUnwatchedLabel}
            onPressItem={onPressItem}
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
 * Horizontal `2:3` Cinema Quietude *More like this* poster rail (`UI_UX_PHILOSOPHY.md` §3).
 * Memoized with TV focus-ring clearance padding and automatic horizontal scroll tracking.
 */
export const DetailRelatedRail = memo(DetailRelatedRailInner);
DetailRelatedRail.displayName = 'DetailRelatedRail';

const styles = StyleSheet.create({
  section: {
    width: '100%',
  },
  stripContent: {
    alignItems: 'flex-start',
  },
});
