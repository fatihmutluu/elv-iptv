import type { ItemRow, SeriesUnplayedSummary, WatchProgressRow } from '@elv/data';
import { CtaButton, TvFocusGuideRegion, useI18n, useTheme } from '@elv/ui-kit';
import type { ComponentRef, ReactElement, RefObject } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  type CatalogLayoutMetrics,
  type DetailTarget,
  type DisplayCategory,
  useRouteActive,
} from '../shared';
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
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly watchedOverrides?: ReadonlyMap<string, boolean>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly hasMoreCategories: boolean;
  readonly focusedRowId: string | null;
  readonly focusedCol: number | null;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onResumeContinue?: (row: WatchProgressRow) => void;
  readonly onHideContinue?: (row: WatchProgressRow) => void;
  readonly onMarkContinueWatched?: (row: WatchProgressRow) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
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
  favoriteKeys,
  watchedOverrides,
  unplayedBySeriesKey,
  hasMoreCategories,
  focusedRowId,
  focusedCol,
  onOpenDetail,
  onResumeContinue,
  onHideContinue,
  onMarkContinueWatched,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onSeeAll,
  onLoadMore,
  onLayoutContinueY,
  onLayoutRailY,
}: CatalogRailsBodyProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const routeActive = useRouteActive();

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
        <View
          onLayout={
            onLayoutContinueY ? (e) => onLayoutContinueY(e.nativeEvent.layout.y) : undefined
          }
        >
          <TvFocusGuideRegion
            testID="catalog-continue-focus-guide"
            enabled={layout.isTv && routeActive}
            autoFocus
          >
            <CatalogContinueWatchingRail
              kind={kind}
              items={continueItems}
              cardWidth={layout.wideRailWidth}
              gap={layout.railGap}
              padX={layout.padX}
              isTv={layout.isTv}
              focusedIndex={focusedRowId === 'continue' ? focusedCol : null}
              onOpenDetail={onOpenDetail}
              {...(onResumeContinue !== undefined ? { onResumeContinue } : {})}
              {...(onHideContinue !== undefined ? { onHideContinue } : {})}
              {...(onMarkContinueWatched !== undefined ? { onMarkContinueWatched } : {})}
            />
          </TvFocusGuideRegion>
        </View>
      ) : null}

      {visibleCategories.map((cat, catIndex) => {
        const items = loadedRailItems.get(cat.row.id) ?? [];
        const isRailLoading = loadingRailIds.has(cat.row.id) && !loadedRailItems.has(cat.row.id);
        if (!isRailLoading && items.length === 0) return null;
        return (
          <View key={cat.row.id} onLayout={(e) => onLayoutRailY(catIndex, e.nativeEvent.layout.y)}>
            <TvFocusGuideRegion
              testID={`catalog-rail-${catIndex}-focus-guide`}
              enabled={layout.isTv && routeActive}
              autoFocus
            >
              <CatalogCategoryRail
                category={cat}
                catIndex={catIndex}
                items={items}
                loading={isRailLoading}
                progressByKey={progressByKey}
                {...(favoriteKeys !== undefined ? { favoriteKeys } : {})}
                {...(watchedOverrides !== undefined ? { watchedOverrides } : {})}
                {...(unplayedBySeriesKey !== undefined ? { unplayedBySeriesKey } : {})}
                cardWidth={layout.posterRailWidth}
                gap={layout.railGap}
                padX={layout.padX}
                isTv={layout.isTv}
                isTouch={layout.isTouch}
                focusedIndex={focusedRowId === `rail-${catIndex}` ? focusedCol : null}
                onOpenDetail={onOpenDetail}
                {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
                {...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {})}
                {...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {})}
                onSeeAll={onSeeAll}
              />
            </TvFocusGuideRegion>
          </View>
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
