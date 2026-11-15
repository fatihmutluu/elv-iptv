import type { BrowseKind, CatalogService, CategoryRow, ItemRow, SourceRow } from '@elv/data';
import { createFocusStore, type FocusStore } from '@elv/focus-core';
import { useI18n } from '@elv/ui-kit';
import { type ReactElement, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { BROWSE_VISIBLE_ROWS, browseStyles, PlainBrowseButton } from './BrowseParts';
import {
  buildDisplayCategories,
  type DescribedBrowseFailure,
  type DisplayCategory,
  formatItemTitle,
} from './browse-model';
import { createPagedListSource, type PagedListSource } from './paged-list-source';

export interface TaggedItemsSource {
  readonly categoryId: string;
  readonly refreshToken: number;
  readonly source: PagedListSource<ItemRow>;
}

/** Creates and disposes an LRU-paged `ListSource` tagged with `categoryId` + `refreshToken`. */
export function useTaggedItemsSource(
  catalog: CatalogService,
  activeCategoryId: string | undefined,
  activeItemCount: number,
  refreshToken: number,
): TaggedItemsSource | null {
  const [taggedItems, setTaggedItems] = useState<TaggedItemsSource | null>(null);
  useEffect(() => {
    if (activeCategoryId === undefined || activeItemCount <= 0) {
      setTaggedItems(null);
      return undefined;
    }
    const next = createPagedListSource<ItemRow>({
      count: activeItemCount,
      pageSize: 200,
      maxPages: 16,
      loadPage: (offset, limit) => catalog.items(activeCategoryId, offset, limit),
    });
    setTaggedItems({ categoryId: activeCategoryId, refreshToken, source: next });
    return () => {
      next.dispose();
    };
  }, [activeCategoryId, activeItemCount, catalog, refreshToken]);
  return taggedItems;
}

const PARKED_SCOPE_ID = '__browse_parked__';
const PARKED_LIST_ID = '__browse_parked_list__';

/** Creates a 2-list vertical `FocusStore` for split browse/series panes. */
export function createTwoPaneFocusStore(
  scopeId: string,
  leftId: string,
  rightId: string,
  activeId: string,
): FocusStore {
  return createFocusStore({
    id: scopeId,
    lists: [
      { id: leftId, count: 0, index: 0, orientation: 'vertical', pageSize: BROWSE_VISIBLE_ROWS },
      { id: rightId, count: 0, index: 0, orientation: 'vertical', pageSize: BROWSE_VISIBLE_ROWS },
    ],
    active: activeId,
  });
}

/** Parks a 2-pane `FocusStore` when `!isActiveScope` (hiding TV focus rings) and restores `desiredListId` when active. */
export function syncTwoPaneScopeActive(
  store: FocusStore,
  isActiveScope: boolean,
  desiredListId: string,
): void {
  const scopes = store.getState().scopes;
  const isParked = scopes[scopes.length - 1]?.id === PARKED_SCOPE_ID;
  if (!isActiveScope) {
    if (!isParked) {
      store.pushScope(
        PARKED_SCOPE_ID,
        [{ id: PARKED_LIST_ID, count: 0, index: 0, orientation: 'vertical', pageSize: 1 }],
        PARKED_LIST_ID,
      );
    }
    return;
  }
  if (isParked) {
    store.popScope();
  }
  if (!store.isActive(desiredListId)) {
    store.activate(desiredListId);
  }
}

/** Loads and merges categories across all configured sources for a browse tab. */
export function useBrowseCategories(
  catalog: CatalogService,
  kind: BrowseKind,
  sources: readonly SourceRow[],
  refreshToken: number,
): { readonly categories: readonly DisplayCategory[]; readonly loading: boolean } {
  const [categories, setCategories] = useState<readonly DisplayCategory[]>([]);
  const [loading, setLoading] = useState(() => sources.length > 0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken intentionally re-reads SQLite categories
  useEffect(() => {
    if (sources.length === 0) {
      setCategories([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      sources.map(
        async (source) => [source.id, await catalog.categories(source.id, kind)] as const,
      ),
    ).then(
      (entries) => {
        if (cancelled) return;
        setCategories(
          buildDisplayCategories(sources, new Map<string, readonly CategoryRow[]>(entries)),
        );
        setLoading(false);
      },
      () => {
        if (!cancelled) {
          setCategories([]);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog, kind, refreshToken, sources]);

  return { categories, loading };
}

/** Loading or empty-categories status block inside `BrowseScreen`. */
export function BrowseEmptyBox({
  isTv,
  isActiveScope,
  loading,
  noReadySources,
  onOpenSources,
}: {
  isTv: boolean;
  isActiveScope: boolean;
  loading: boolean;
  noReadySources: boolean;
  onOpenSources: () => void;
}): ReactElement {
  const i18n = useI18n();
  return (
    <View style={browseStyles.emptyBox}>
      {loading ? (
        <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
          {i18n.t('browse.loading')}
        </Text>
      ) : noReadySources ? (
        <>
          <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
            {i18n.t('browse.emptyNoSources')}
          </Text>
          <PlainBrowseButton
            testID="browse-open-sources"
            label={i18n.t('browse.openSources')}
            isTv={isTv}
            highlighted={isTv && isActiveScope}
            onPress={onOpenSources}
          />
        </>
      ) : (
        <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
          {i18n.t('browse.emptyCategories')}
        </Text>
      )}
    </View>
  );
}

/** Builds a `PlayTarget` for an activated live channel with an LRU-paged `LiveChannelPlaylist`. */
export function buildLivePlayTarget(
  catalog: CatalogService,
  category: CategoryRow,
  item: ItemRow,
  currentIndex: number,
  onChangeIndex: (nextIndex: number) => void,
): PlayTarget {
  const playlistLoader = createPagedListSource<ItemRow>({
    count: category.itemCount,
    pageSize: 200,
    maxPages: 4,
    loadPage: (offset, limit) => catalog.items(category.id, offset, limit),
  });
  return {
    itemKey: item.key,
    sourceId: item.sourceId,
    title: formatItemTitle(item),
    kind: 'live',
    playlist: {
      count: category.itemCount,
      currentIndex,
      onChangeIndex,
      async getAt(targetIndex) {
        const row = await playlistLoader.loadItem(targetIndex);
        if (row === undefined) return undefined;
        return {
          itemKey: row.key,
          sourceId: row.sourceId,
          title: formatItemTitle(row),
          kind: 'live',
        };
      },
    },
  };
}

/** Loading, error, or empty-seasons status block inside `SeriesDetailPane`. */
export function SeriesStatusBox({
  isTv,
  isActiveScope,
  state,
  onBackToSeries,
  onRetry,
}: {
  isTv: boolean;
  isActiveScope: boolean;
  state:
    | { readonly kind: 'loading' }
    | { readonly kind: 'empty' }
    | { readonly kind: 'error'; readonly failure: DescribedBrowseFailure };
  onBackToSeries: () => void;
  onRetry: () => void;
}): ReactElement {
  const i18n = useI18n();
  return (
    <View style={browseStyles.emptyBox}>
      <PlainBrowseButton
        testID="series-back-series"
        label={i18n.t('series.backToSeries')}
        isTv={isTv}
        highlighted={isTv && isActiveScope && state.kind === 'empty'}
        onPress={onBackToSeries}
      />
      {state.kind === 'loading' ? (
        <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
          {i18n.t('series.loadingSeasons')}
        </Text>
      ) : state.kind === 'error' ? (
        <>
          <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
            {i18n.t(state.failure.messageId)}
          </Text>
          <Text style={[browseStyles.hintText, isTv ? browseStyles.hintTextTv : null]}>
            {i18n.t(state.failure.hintId)}
          </Text>
          <PlainBrowseButton
            testID="series-retry-seasons"
            label={i18n.t('series.retrySeasons')}
            isTv={isTv}
            highlighted={isTv && isActiveScope}
            onPress={onRetry}
          />
        </>
      ) : (
        <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
          {i18n.t('series.emptySeasons')}
        </Text>
      )}
    </View>
  );
}
