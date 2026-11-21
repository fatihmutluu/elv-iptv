import type { ItemRow, WatchProgressRow } from '@elv/data';
import { HorizontalRailScroll, PosterCard, useI18n, useTheme } from '@elv/ui-kit';
import { type ComponentRef, memo, type ReactElement, useCallback, useEffect, useRef } from 'react';
import { type LayoutChangeEvent, type ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatVodMeta } from '../shared';
import { detailProgressRatio } from './detail-model';

/** Props of {@link DetailRelatedRail}. */
export interface DetailRelatedRailProps {
  readonly items: readonly ItemRow[];
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedIndex: number | null;
  readonly onPressItem: (item: ItemRow) => void;
  readonly onLayoutY?: (y: number) => void;
}

interface RelatedPosterItemProps {
  readonly item: ItemRow;
  readonly index: number;
  readonly progress: WatchProgressRow | undefined;
  readonly cardWidth: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly watchedLabel: string;
  readonly onPressItem: (item: ItemRow) => void;
}

const RelatedPosterItem = memo(function RelatedPosterItemInner({
  item,
  index,
  progress,
  cardWidth,
  isTv,
  focused,
  watchedLabel,
  onPressItem,
}: RelatedPosterItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onPressItem(item);
  }, [item, onPressItem]);

  const meta = formatVodMeta(item.year, item.rating);
  const ratio =
    progress && !progress.watched && progress.positionMs > 0 && progress.durationMs > 0
      ? detailProgressRatio(progress.positionMs, progress.durationMs)
      : undefined;
  const badge = progress?.watched ? watchedLabel : undefined;

  return (
    <PosterCard
      testID={`detail-related-item-${index}`}
      title={item.name}
      {...(meta !== undefined ? { meta } : {})}
      imageUri={item.logo}
      {...(ratio !== undefined ? { progress: ratio } : {})}
      {...(badge !== undefined ? { badge } : {})}
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
  cardWidth,
  gap,
  padX,
  isTv,
  focusedIndex,
  onPressItem,
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

  if (items.length === 0) return null;

  const watchedLabel = i18n.t('home.watchedBadge');

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
            cardWidth={cardWidth}
            isTv={isTv}
            focused={isTv && focusedIndex === index}
            watchedLabel={watchedLabel}
            onPressItem={onPressItem}
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
