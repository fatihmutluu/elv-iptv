import type { CatalogService, CategoryRow, ItemRow } from '@elv/data';
import { createFocusStore, type FocusStore } from '@elv/focus-core';
import { useI18n } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Text, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { BROWSE_VISIBLE_ROWS, browseStyles, PlainBrowseButton } from './BrowseParts';
import { type DescribedBrowseFailure, formatItemTitle } from './browse-model';
import { createPagedListSource } from './paged-list-source';

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

/** Loading or empty-categories status block inside `BrowseScreen`. */
export function BrowseEmptyBox({
  isTv,
  loading,
  noReadySources,
  onOpenSources,
}: {
  isTv: boolean;
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
            highlighted={isTv}
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
  state,
  onBackToSeries,
  onRetry,
}: {
  isTv: boolean;
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
            highlighted={isTv}
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
