import type { KeyEvent } from '@elv/focus-core';
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
import type { CatalogLayoutMetrics, DisplayCategory } from '../shared';

const ALL_CATEGORIES_ID = '__all__';

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
  readonly focusedCatChipIndex: number | null;
  readonly onSelectCategory: (categoryId: string | null) => void;
}

/** Top screen title + editorial underline category bar for Movies & Series. */
export const CatalogFilterHeader = memo(function CatalogFilterHeaderInner({
  screenTitle,
  layout,
  categories,
  selectedCategoryId,
  focusedCatChipIndex,
  onSelectCategory,
}: CatalogFilterHeaderProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const items = useMemo<readonly EditorialCategoryItem[]>(
    () => [
      {
        id: ALL_CATEGORIES_ID,
        label: i18n.t('catalog.allCategories'),
        testID: 'catalog-cat-chip-all',
      },
      ...categories.map((cat, index) => ({
        id: cat.row.id,
        label: cat.label,
        testID: `catalog-cat-chip-${index}`,
      })),
    ],
    [categories, i18n],
  );

  const handleSelect = useCallback(
    (id: string) => onSelectCategory(id === ALL_CATEGORIES_ID ? null : id),
    [onSelectCategory],
  );

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
        activeId={selectedCategoryId ?? ALL_CATEGORIES_ID}
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
