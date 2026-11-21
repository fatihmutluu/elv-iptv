import type { ItemRow, WatchProgressRow } from '@elv/data';
import { CtaButton, useI18n, useTheme } from '@elv/ui-kit';
import type { ComponentRef, ReactElement, RefObject } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { CatalogLayoutMetrics, DetailTarget, DisplayCategory } from '../shared';
import { CatalogCategoryRail } from './CatalogCategoryRail';
import { CatalogContinueWatchingRail } from './CatalogContinueWatchingRail';

/** Props of {@link CatalogRailsBody}. */
export interface CatalogRailsBodyProps {
  readonly kind: 'movie' | 'series';
  readonly scrollRef: RefObject<ComponentRef<typeof ScrollView> | null>;
  readonly layout: CatalogLayoutMetrics;
  readonly safeBottomInset: number;
  readonly continueItems: readonly WatchProgressRow[];
  readonly visibleCategories: readonly DisplayCategory[];
  readonly loadedRailItems: ReadonlyMap<string, readonly ItemRow[]>;
  readonly loadingRailIds: ReadonlySet<string>;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly hasMoreCategories: boolean;
  readonly focusedRowId: string | null;
  readonly focusedCol: number | null;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onSeeAll: (categoryId: string) => void;
  readonly onLoadMore: () => void;
  readonly onLayoutContinueY?: (y: number) => void;
  readonly onLayoutRailY: (catIndex: number, y: number) => void;
}

/** Vertical Discovery Mode body rendering top Continue Watching rail, bounded poster rails, and `Load more`. */
export function CatalogRailsBody({
  kind,
  scrollRef,
  layout,
  safeBottomInset,
  continueItems,
  visibleCategories,
  loadedRailItems,
  loadingRailIds,
  progressByKey,
  hasMoreCategories,
  focusedRowId,
  focusedCol,
  onOpenDetail,
  onSeeAll,
  onLoadMore,
  onLayoutContinueY,
  onLayoutRailY,
}: CatalogRailsBodyProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <ScrollView
      ref={scrollRef}
      testID="catalog-discovery-scroll"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingBottom: theme.spacing.xl + safeBottomInset + (layout.isPortrait ? 20 : 12),
      }}
    >
      {continueItems.length > 0 ? (
        <CatalogContinueWatchingRail
          kind={kind}
          items={continueItems}
          cardWidth={layout.wideRailWidth}
          gap={layout.railGap}
          padX={layout.padX}
          isTv={layout.isTv}
          focusedIndex={focusedRowId === 'continue' ? focusedCol : null}
          onOpenDetail={onOpenDetail}
          {...(onLayoutContinueY !== undefined ? { onLayoutY: onLayoutContinueY } : {})}
        />
      ) : null}

      {visibleCategories.map((cat, catIndex) => {
        const items = loadedRailItems.get(cat.row.id) ?? [];
        const isRailLoading = loadingRailIds.has(cat.row.id) && !loadedRailItems.has(cat.row.id);
        return (
          <CatalogCategoryRail
            key={cat.row.id}
            category={cat}
            catIndex={catIndex}
            items={items}
            loading={isRailLoading}
            progressByKey={progressByKey}
            cardWidth={layout.posterRailWidth}
            gap={layout.railGap}
            padX={layout.padX}
            isTv={layout.isTv}
            isTouch={layout.isTouch}
            focusedIndex={focusedRowId === `rail-${catIndex}` ? focusedCol : null}
            onOpenDetail={onOpenDetail}
            onSeeAll={onSeeAll}
            onLayoutY={onLayoutRailY}
          />
        );
      })}

      {hasMoreCategories ? (
        <View style={[styles.loadMoreRow, { paddingHorizontal: layout.padX }]}>
          <CtaButton
            testID="catalog-load-more"
            variant="secondary"
            label={i18n.t('catalog.loadMoreCategories')}
            focusable={!layout.isTv}
            focused={focusedRowId === 'loadMore'}
            onPress={onLoadMore}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loadMoreRow: { marginTop: 24, alignItems: 'center' },
});
