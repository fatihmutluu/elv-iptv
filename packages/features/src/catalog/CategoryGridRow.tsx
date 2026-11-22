import type { ItemRow, ItemSortOrder, WatchProgressRow } from '@elv/data';
import {
  Icon,
  PosterCard,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
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
} from '../shared';
import { computeProgressRatio } from './catalog-model';

interface GridPosterSlotProps {
  readonly item: ItemRow | undefined;
  readonly itemIndex: number;
  readonly categoryId: string;
  readonly progress: WatchProgressRow | undefined;
  readonly watchedLabel: string;
  readonly cardWidth: number;
  readonly posterHeight: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onOpenDetail: (target: DetailTarget) => void;
}

const GridPosterSlot = memo(function GridPosterSlotInner({
  item,
  itemIndex,
  categoryId,
  progress,
  watchedLabel,
  cardWidth,
  posterHeight,
  isTv,
  focused,
  onOpenDetail,
}: GridPosterSlotProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => {
    if (!item) return;
    const target = detailTargetFromItem(item, categoryId);
    if (target) onOpenDetail(target);
  }, [categoryId, item, onOpenDetail]);

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
  const ratio = computeProgressRatio(progress);
  const badge = progress?.watched ? watchedLabel : undefined;

  return (
    <PosterCard
      testID={`catalog-grid-item-${itemIndex}`}
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

/** Props of {@link GridRowView}. */
export interface GridRowViewProps {
  readonly rowIndex: number;
  readonly items: readonly (ItemRow | undefined)[];
  readonly columns: number;
  readonly categoryId: string;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly watchedLabel: string;
  readonly layout: CatalogLayoutMetrics;
  readonly focusedCol: number | null;
  readonly onOpenDetail: (target: DetailTarget) => void;
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
  watchedLabel,
  layout,
  focusedCol,
  onOpenDetail,
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
            watchedLabel={watchedLabel}
            cardWidth={layout.gridCardWidth}
            posterHeight={posterHeight}
            isTv={layout.isTv}
            focused={layout.isTv && focusedCol === colIdx}
            onOpenDetail={onOpenDetail}
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
