import {
  CtaButton,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  SkeletonBox,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type CatalogLayoutMetrics, type DisplayCategory, useRouteActive } from '../shared';
import type { CatalogQuickFilter } from './catalog-model';

const ALL_CATEGORIES_ID = '__all__';
const MY_LIST_FILTER_ID = '__mylist__';
const ELV_PICKS_FILTER_ID = '__elv_picks__';

/** TV key interpreter bridge mounted only when the Catalog tab is the active 10-ft focus scope. */
export function CatalogTvKeyBridge({
  kind,
  onEvent,
  preferredFocus = true,
}: {
  readonly kind: 'movie' | 'series';
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
  readonly preferredFocus?: boolean;
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return (
    <TvFocusAnchor
      testID={`catalog-tv-focus-anchor-${kind}`}
      hasTVPreferredFocus={routeActive && preferredFocus}
    />
  );
}

const SKELETON_CHIPS = [0, 1, 2, 3, 4] as const;
const SKELETON_RAILS = [0, 1] as const;
const SKELETON_CARDS = [0, 1, 2, 3, 4, 5] as const;

/** Zero-CLS tonal skeleton rendered while initial Movies/Series categories load. */
export function CatalogSkeleton({
  layout,
}: {
  readonly layout: CatalogLayoutMetrics;
}): ReactElement {
  const theme = useTheme();
  const posterHeight = Math.round(layout.posterRailWidth * 1.5);
  return (
    <View testID="catalog-skeleton" style={[styles.skeletonRoot, { paddingTop: theme.spacing.sm }]}>
      <View style={{ paddingHorizontal: layout.padX }}>
        <SkeletonBox width={140} height={28} borderRadius={theme.radius.button} />
        <View style={[styles.skeletonRow, { gap: theme.spacing.md, marginTop: 14 }]}>
          {SKELETON_CHIPS.map((slot) => (
            <SkeletonBox key={slot} width={76} height={24} borderRadius={theme.radius.button} />
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
          paddingTop: title ? theme.spacing.sm : 0,
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
  readonly quickFilter?: CatalogQuickFilter;
  readonly showElvPicks?: boolean;
  readonly focusedCatChipIndex: number | null;
  readonly onSelectCategory: (categoryId: string | null) => void;
  readonly onSelectQuickFilter?: (filter: CatalogQuickFilter) => void;
}

/** Top screen title + editorial underline category bar for Movies & Series. */
export const CatalogFilterHeader = memo(function CatalogFilterHeaderInner({
  screenTitle,
  layout,
  categories,
  selectedCategoryId,
  quickFilter = 'all',
  showElvPicks = false,
  focusedCatChipIndex,
  onSelectCategory,
  onSelectQuickFilter,
}: CatalogFilterHeaderProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const items = useMemo<readonly EditorialCategoryItem[]>(
    () => [
      {
        id: ALL_CATEGORIES_ID,
        label: i18n.t('catalog.filterAll'),
        testID: 'catalog-cat-chip-all',
      },
      {
        id: MY_LIST_FILTER_ID,
        label: i18n.t('catalog.filterMyList'),
        testID: 'catalog-filter-mylist',
      },
      ...(showElvPicks
        ? [
            {
              id: ELV_PICKS_FILTER_ID,
              label: i18n.t('catalog.filter.elvPicks'),
              testID: 'catalog-filter-elv-picks',
            },
          ]
        : []),
      ...categories.map((cat, index) => ({
        id: cat.row.id,
        label: cat.label,
        testID: `catalog-cat-chip-${index}`,
      })),
    ],
    [categories, i18n, showElvPicks],
  );

  const handleSelect = useCallback(
    (id: string) => {
      if (id === ALL_CATEGORIES_ID) {
        onSelectQuickFilter?.('all');
        onSelectCategory(null);
      } else if (id === MY_LIST_FILTER_ID) {
        onSelectQuickFilter?.('mylist');
        onSelectCategory(null);
      } else if (id === ELV_PICKS_FILTER_ID) {
        onSelectQuickFilter?.('elvPicks');
        onSelectCategory(null);
      } else {
        onSelectQuickFilter?.('all');
        onSelectCategory(id);
      }
    },
    [onSelectCategory, onSelectQuickFilter],
  );

  const activeId =
    selectedCategoryId !== null
      ? selectedCategoryId
      : quickFilter === 'mylist'
        ? MY_LIST_FILTER_ID
        : showElvPicks && quickFilter === 'elvPicks'
          ? ELV_PICKS_FILTER_ID
          : ALL_CATEGORIES_ID;

  return (
    <View style={[styles.headerRoot, { paddingTop: theme.spacing.sm }]}>
      <Text
        numberOfLines={1}
        style={[
          theme.typography.h1,
          { color: theme.colors.textPrimary, paddingHorizontal: layout.padX, marginBottom: 4 },
        ]}
      >
        {screenTitle}
      </Text>

      <EditorialCategoryBar
        items={items}
        activeId={activeId}
        onSelect={handleSelect}
        pickerLabel={i18n.t('catalog.categories')}
        padX={layout.padX}
        isTv={layout.isTv}
        focusedIndex={focusedCatChipIndex}
        testID="catalog-category-chips"
      />
    </View>
  );
});

const styles = StyleSheet.create({
  headerRoot: { position: 'relative', zIndex: 20 },
  skeletonRoot: { flex: 1, overflow: 'hidden' },
  skeletonSection: { marginTop: 22 },
  skeletonRow: { flexDirection: 'row', overflow: 'hidden' },
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyDesc: { maxWidth: 420, textAlign: 'center' },
});
