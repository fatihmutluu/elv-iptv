import type { KeyEvent } from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  FilterChip,
  SkeletonBox,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
} from '@elv/ui-kit';
import { type ComponentRef, memo, type ReactElement, useCallback, useEffect, useRef } from 'react';
import { type LayoutChangeEvent, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CatalogLayoutMetrics, DisplayCategory, WatchStatusFilter } from '../shared';
import { WATCH_STATUS_FILTERS } from './catalog-model';

/** TV key interpreter bridge mounted only when the Catalog tab is the active 10-ft focus scope. */
export function CatalogTvKeyBridge({
  kind,
  onEvent,
}: {
  readonly kind: 'movie' | 'series';
  readonly onEvent: (event: KeyEvent) => void;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID={`catalog-tv-focus-anchor-${kind}`} />;
}

const FILTER_LABEL_KEYS: Readonly<Record<WatchStatusFilter, MessageId>> = {
  all: 'catalog.filter.all',
  unwatched: 'catalog.filter.unwatched',
  inProgress: 'catalog.filter.inProgress',
  watched: 'catalog.filter.watched',
};

const SKELETON_CHIPS = [0, 1, 2, 3, 4] as const;
const SKELETON_RAILS = [0, 1] as const;
const SKELETON_CARDS = [0, 1, 2, 3, 4, 5] as const;

interface CategoryChipItemProps {
  readonly category: DisplayCategory;
  readonly index: number;
  readonly selected: boolean;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelect: (categoryId: string) => void;
  readonly onMeasureX: (chipIndex: number, x: number) => void;
}

const CategoryChipItem = memo(function CategoryChipItemInner({
  category,
  index,
  selected,
  isTv,
  focused,
  onSelect,
  onMeasureX,
}: CategoryChipItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onSelect(category.row.id);
  }, [category.row.id, onSelect]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onMeasureX(index + 1, event.nativeEvent.layout.x);
    },
    [index, onMeasureX],
  );

  return (
    <View onLayout={handleLayout}>
      <FilterChip
        testID={`catalog-cat-chip-${index}`}
        label={category.label}
        selected={selected}
        focusable={!isTv}
        focused={focused}
        onPress={handlePress}
      />
    </View>
  );
});

interface StatusChipItemProps {
  readonly filter: WatchStatusFilter;
  readonly label: string;
  readonly selected: boolean;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelect: (filter: WatchStatusFilter) => void;
}

const StatusChipItem = memo(function StatusChipItemInner({
  filter,
  label,
  selected,
  isTv,
  focused,
  onSelect,
}: StatusChipItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onSelect(filter);
  }, [filter, onSelect]);

  return (
    <FilterChip
      testID={`catalog-status-${filter}`}
      label={label}
      selected={selected}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
    />
  );
});

/** Zero-CLS tonal skeleton rendered while initial Movies/Series categories load. */
export function CatalogSkeleton({
  layout,
}: {
  readonly layout: CatalogLayoutMetrics;
}): ReactElement {
  const theme = useTheme();
  const posterHeight = Math.round(layout.posterRailWidth * 1.5);
  return (
    <View
      testID="catalog-skeleton"
      style={[styles.skeletonRoot, { paddingTop: layout.heroTopClearance }]}
    >
      <View style={{ paddingHorizontal: layout.padX }}>
        <SkeletonBox width={140} height={28} borderRadius={theme.radius.button} />
        <View style={[styles.skeletonRow, { gap: theme.spacing.xs, marginTop: 14 }]}>
          {SKELETON_CHIPS.map((slot) => (
            <SkeletonBox key={slot} width={84} height={32} borderRadius={theme.radius.pill} />
          ))}
        </View>
      </View>
      {SKELETON_RAILS.map((rail) => (
        <View key={rail} style={[styles.skeletonSection, { paddingHorizontal: layout.padX }]}>
          <SkeletonBox width={160} height={18} borderRadius={theme.radius.button} />
          <View style={[styles.skeletonRow, { gap: layout.railGap, marginTop: 12 }]}>
            {SKELETON_CARDS.map((slot) => (
              <View key={slot} style={{ width: layout.posterRailWidth }}>
                <SkeletonBox
                  width={layout.posterRailWidth}
                  height={posterHeight}
                  borderRadius={theme.radius.card}
                />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Constructive empty state displayed when no sources or no categories exist. */
export function CatalogEmptyState({
  testID,
  title,
  description,
  layout,
  ctaLabel,
  ctaTestID,
  ctaFocused,
  onPressCta,
}: {
  readonly testID: string;
  readonly title?: string;
  readonly description: string;
  readonly layout: CatalogLayoutMetrics;
  readonly ctaLabel?: string;
  readonly ctaTestID?: string;
  readonly ctaFocused?: boolean;
  readonly onPressCta?: () => void;
}): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.emptyBox,
        {
          paddingTop: title ? layout.heroTopClearance : 0,
          paddingHorizontal: layout.padX,
        },
      ]}
    >
      {title ? (
        <Text
          style={[theme.typography.h1, { color: theme.colors.textPrimary, textAlign: 'center' }]}
        >
          {title}
        </Text>
      ) : null}
      <Text
        style={[
          theme.typography.body,
          styles.emptyDesc,
          { color: theme.colors.textSecondary, marginTop: title ? theme.spacing.sm : 0 },
        ]}
      >
        {description}
      </Text>
      {ctaLabel && ctaTestID && onPressCta ? (
        <View style={{ marginTop: theme.spacing.lg }}>
          <CtaButton
            testID={ctaTestID}
            label={ctaLabel}
            {...(ctaTestID === 'catalog-open-sources' ? { icon: 'sources' as const } : {})}
            focusable={!layout.isTv}
            focused={Boolean(ctaFocused)}
            onPress={onPressCta}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Props of {@link CatalogFilterHeader}. */
export interface CatalogFilterHeaderProps {
  readonly screenTitle: string;
  readonly layout: CatalogLayoutMetrics;
  readonly categories: readonly DisplayCategory[];
  readonly selectedCategoryId: string | null;
  readonly watchFilter: WatchStatusFilter;
  readonly focusedCatChipIndex: number | null;
  readonly focusedStatusChipIndex: number | null;
  readonly onSelectAllCategories: () => void;
  readonly onSelectCategory: (categoryId: string) => void;
  readonly onSelectWatchFilter: (filter: WatchStatusFilter) => void;
}

/** Top screen title + horizontal category & watch-status `FilterChip` bars for Movies & Series. */
export const CatalogFilterHeader = memo(function CatalogFilterHeaderInner({
  screenTitle,
  layout,
  categories,
  selectedCategoryId,
  watchFilter,
  focusedCatChipIndex,
  focusedStatusChipIndex,
  onSelectAllCategories,
  onSelectCategory,
  onSelectWatchFilter,
}: CatalogFilterHeaderProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const chipPadY = layout.isTv ? 8 : 4;
  const catScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const chipXRef = useRef<Map<number, number>>(new Map());

  const recordChipX = useCallback((chipIndex: number, x: number) => {
    chipXRef.current.set(chipIndex, x);
  }, []);

  const handleAllChipLayout = useCallback((event: LayoutChangeEvent) => {
    chipXRef.current.set(0, event.nativeEvent.layout.x);
  }, []);

  useEffect(() => {
    if (!layout.isTv || focusedCatChipIndex === null) return;
    const measuredX = chipXRef.current.get(focusedCatChipIndex);
    const targetX =
      measuredX !== undefined
        ? Math.max(0, measuredX - layout.padX)
        : Math.max(0, focusedCatChipIndex * 116 - layout.padX);
    catScrollRef.current?.scrollTo({ x: targetX, animated: !theme.reduceMotion });
  }, [focusedCatChipIndex, layout.isTv, layout.padX, theme.reduceMotion]);

  return (
    <View style={{ paddingTop: layout.heroTopClearance }}>
      <Text
        numberOfLines={1}
        style={[
          theme.typography.h1,
          { color: theme.colors.textPrimary, paddingHorizontal: layout.padX, marginBottom: 8 },
        ]}
      >
        {screenTitle}
      </Text>

      <ScrollView
        ref={catScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          styles.chipRow,
          { paddingHorizontal: layout.padX, paddingVertical: chipPadY, gap: theme.spacing.xs },
        ]}
      >
        <View onLayout={handleAllChipLayout}>
          <FilterChip
            testID="catalog-cat-chip-all"
            label={i18n.t('catalog.allCategories')}
            selected={selectedCategoryId === null}
            focusable={!layout.isTv}
            focused={focusedCatChipIndex === 0}
            onPress={onSelectAllCategories}
          />
        </View>
        {categories.map((cat, index) => (
          <CategoryChipItem
            key={cat.row.id}
            category={cat}
            index={index}
            selected={selectedCategoryId === cat.row.id}
            isTv={layout.isTv}
            focused={focusedCatChipIndex === index + 1}
            onSelect={onSelectCategory}
            onMeasureX={recordChipX}
          />
        ))}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          styles.chipRow,
          { paddingHorizontal: layout.padX, paddingVertical: chipPadY, gap: theme.spacing.xs },
        ]}
      >
        {WATCH_STATUS_FILTERS.map((filter, idx) => (
          <StatusChipItem
            key={filter}
            filter={filter}
            label={i18n.t(FILTER_LABEL_KEYS[filter])}
            selected={watchFilter === filter}
            isTv={layout.isTv}
            focused={focusedStatusChipIndex === idx}
            onSelect={onSelectWatchFilter}
          />
        ))}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  skeletonRoot: { flex: 1, overflow: 'hidden' },
  skeletonSection: { marginTop: 22 },
  skeletonRow: { flexDirection: 'row', overflow: 'hidden' },
  chipRow: { flexDirection: 'row', alignItems: 'center' },
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyDesc: { maxWidth: 420, textAlign: 'center' },
});
