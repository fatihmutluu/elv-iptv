import type { BrowseKind, CatalogService, SourceRow } from '@elv/data';
import type { DownloadRecord } from '@elv/domain';
import {
  type ContextMenuAnchor,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  TvFocusAnchor,
  useContextMenu,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  computeCatalogLayout,
  type DetailTarget,
  hasManagedDownload,
  useDownloads,
  useRouteActive,
} from '../shared';
import {
  type LibraryCollectionModalState,
  LibraryCollectionModals,
} from './LibraryCollectionModals';
import { LibraryDownloadedSeriesView } from './LibraryDownloadedSeriesView';
import { LibraryDownloadsTab } from './LibraryDownloadsTab';
import { type LibraryCollectionRail, LibraryEditorialTabs } from './LibraryEditorialTabs';
import { LibrarySeeAllGrid } from './LibrarySeeAllGrid';
import {
  buildActiveDownloadMenuItems,
  buildDownloadedMediaMenuItems,
  buildLibraryLiveMenuItems,
  buildLibraryVodMenuItems,
} from './library-context-menu';
import {
  buildLibraryDetailTarget,
  buildLibraryPlayTarget,
  buildOfflineEpisodePlayTarget,
  deriveSeriesKeyFromEpisodeRecord,
  LIBRARY_SUB_TABS,
  type LibraryCardItem,
  type LibrarySeeAllState,
  type LibrarySubTab,
  mapCollectionItemsToLibraryCards,
  mapWatchedRowsToLibraryCards,
  partitionFavoritesForLibrary,
  partitionLibraryDownloads,
  partitionRatingsForLibrary,
  resolveLibrarySeeAllItems,
} from './library-model';
import { useLibraryData } from './useLibraryData';
import { useLibraryFolderDrag } from './useLibraryFolderDrag';
import { buildLibraryNavRails, useTvLibraryNavigation } from './useTvLibraryNavigation';

/** Props of {@link LibraryScreen}. */
export interface LibraryScreenProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly isPlaybackActive?: boolean;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onOpenMultiView?: (target: PlayTarget) => void;
  readonly onOpenPopout?: (target: PlayTarget) => void;
  readonly onOpenTab?: (tab: BrowseKind) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
}

type TvKeyHandler = Parameters<typeof useKeyInterpreter>[0];

function LibraryTvKeyBridge({ onEvent }: { readonly onEvent: TvKeyHandler }): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="library-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/**
 * Cinema Quietude v2 unified `Library` (`Kitaplık`) 5th navigation hub.
 * Organizes personal content across 4 borderless editorial sub-tabs:
 * `Following`, `Likes`, `Watched`, and `Downloads`.
 */
export function LibraryScreen({
  catalog,
  refreshToken,
  userStateVersion = 0,
  isPlaybackActive = false,
  onPlay,
  onOpenDetail,
  onOpenMultiView,
  onOpenPopout,
  onFocusTopNav,
  isActiveScope = true,
}: LibraryScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const downloads = useDownloads();
  const contextMenu = useContextMenu();
  const { isTv, padX, posterRailWidth, wideRailWidth } = computeCatalogLayout(viewport, theme);

  const [activeTab, setActiveTab] = useState<LibrarySubTab>('following');
  const [seeAll, setSeeAll] = useState<LibrarySeeAllState | null>(null);
  const [selectedSeriesGroupId, setSelectedSeriesGroupId] = useState<string | null>(null);
  const [collectionModal, setCollectionModal] = useState<LibraryCollectionModalState | null>(null);
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  const dlPartition = useMemo(
    () => partitionLibraryDownloads(downloads.records),
    [downloads.records],
  );

  const data = useLibraryData({
    catalog,
    refreshToken,
    userStateVersion,
    activeTab,
    isPlaybackActive,
    completedEpisodes: dlPartition.completedEpisodes,
  });

  const favPartition = useMemo(
    () => partitionFavoritesForLibrary(data.favorites, data.collectedItemKeys),
    [data.collectedItemKeys, data.favorites],
  );
  const ratingPartition = useMemo(() => partitionRatingsForLibrary(data.ratings), [data.ratings]);
  const watchedMovieCards = useMemo(
    () => mapWatchedRowsToLibraryCards(data.watchedMovies, 'movie'),
    [data.watchedMovies],
  );
  const watchedSeriesCards = useMemo(
    () => mapWatchedRowsToLibraryCards(data.watchedSeries, 'series'),
    [data.watchedSeries],
  );

  const completedMovieCards = useMemo<readonly LibraryCardItem[]>(
    () =>
      dlPartition.completedMovies.map((record) => ({
        id: record.id,
        itemKey: record.itemKey,
        sourceId: record.sourceId,
        kind: 'movie',
        title: record.title,
        imageUri: record.poster ?? null,
        subtitle: i18n.t('downloads.offlineBadge'),
        downloadRecord: record,
      })),
    [dlPartition.completedMovies, i18n],
  );

  const collectionRails = useMemo<readonly LibraryCollectionRail[]>(
    () =>
      data.collections.map((c) => ({
        railId: `collection-${c.collection.id}`,
        collectionId: c.collection.id,
        title: c.collection.name,
        items: mapCollectionItemsToLibraryCards(c.items),
      })),
    [data.collections],
  );
  const collectionMenuOptions = useMemo(
    () => data.collections.map((c) => ({ id: c.collection.id, name: c.collection.name })),
    [data.collections],
  );
  const canCreateCollection = typeof catalog.createCollection === 'function';

  const handleMoveItemToCollection = useCallback(
    (item: LibraryCardItem, targetCollectionId: string) => {
      void data.moveItemToCollection(item, targetCollectionId);
    },
    [data.moveItemToCollection],
  );
  const handleRemoveItemFromCollection = useCallback(
    (collectionId: string, itemKey: string) => {
      void data.removeItemFromCollection(collectionId, itemKey);
    },
    [data.removeItemFromCollection],
  );
  const dragController = useLibraryFolderDrag({
    enabled:
      !isTv && activeTab === 'following' && seeAll === null && selectedSeriesGroupId === null,
    onMoveToCollection: handleMoveItemToCollection,
    onRemoveFromCollection: handleRemoveItemFromCollection,
  });
  const handleOpenCreateCollection = useCallback(() => {
    setCollectionModal({ mode: 'create' });
  }, []);
  const handleOpenRenameCollection = useCallback((collectionId: string, currentName: string) => {
    setCollectionModal({ mode: 'rename', collectionId, currentName });
  }, []);
  const handleOpenDeleteCollection = useCallback((collectionId: string, name: string) => {
    setCollectionModal({ mode: 'delete', collectionId, name });
  }, []);
  const handleCloseCollectionModal = useCallback(() => {
    setCollectionModal(null);
  }, []);

  const selectedSeriesGroup = useMemo(
    () =>
      selectedSeriesGroupId !== null
        ? (data.downloadedSeriesGroups.find((g) => g.groupId === selectedSeriesGroupId) ?? null)
        : null,
    [data.downloadedSeriesGroups, selectedSeriesGroupId],
  );

  const handlePressCard = useCallback(
    (item: LibraryCardItem) => {
      if (item.downloadRecord) {
        onPlay(buildOfflineEpisodePlayTarget(item.downloadRecord));
        return;
      }
      if (item.kind === 'live') {
        onPlay(buildLibraryPlayTarget(item));
        return;
      }
      const target = buildLibraryDetailTarget(item);
      if (target) onOpenDetail(target);
    },
    [onOpenDetail, onPlay],
  );

  const handleTogglePauseResume = useCallback(
    (record: DownloadRecord) => {
      if (record.status === 'paused' || record.status === 'failed') {
        void downloads.resume(record.itemKey);
      } else {
        void downloads.pause(record.itemKey);
      }
    },
    [downloads],
  );

  const handleCancelActive = useCallback(
    (record: DownloadRecord) => {
      void downloads.cancel(record.itemKey);
    },
    [downloads],
  );

  const handleDeleteDownload = useCallback(
    (record: DownloadRecord) => {
      void downloads.remove(record.itemKey);
    },
    [downloads],
  );

  const openLiveContextMenu = useCallback(
    (item: LibraryCardItem, anchor?: ContextMenuAnchor) => {
      const target = buildLibraryPlayTarget(item);
      contextMenu.openContextMenu({
        title: item.title,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildLibraryLiveMenuItems({
          t: i18n.t,
          onPlay: () => onPlay(target),
          ...(onOpenMultiView !== undefined
            ? { onOpenMultiView: () => onOpenMultiView(target) }
            : {}),
          ...(onOpenPopout !== undefined ? { onOpenPopout: () => onOpenPopout(target) } : {}),
          onRemoveFavorite: () => {
            void data.toggleFavorite(item);
          },
        }),
      });
    },
    [contextMenu, data, i18n.t, onOpenMultiView, onOpenPopout, onPlay],
  );

  const openVodContextMenu = useCallback(
    (item: LibraryCardItem, anchor?: ContextMenuAnchor, currentCollectionId?: string | null) => {
      if (item.kind !== 'movie' && item.kind !== 'series') return;
      const detail = buildLibraryDetailTarget(item);
      const isFav = data.favoriteKeys.has(item.itemKey);
      const currentRating = data.ratingMap.get(item.itemKey) ?? null;
      const isWatched = item.allWatched === true || data.watchedKeys.has(item.itemKey);
      const existingDl = downloads.byItemKey.get(item.itemKey);
      const canDownload =
        item.kind === 'movie' && downloads.supported && !hasManagedDownload(existingDl);
      const resolvedCollectionId =
        currentCollectionId !== undefined
          ? currentCollectionId
          : (data.collections.find((c) => c.items.some((i) => i.key === item.itemKey))?.collection
              .id ?? null);

      contextMenu.openContextMenu({
        title: item.title,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildLibraryVodMenuItems({
          t: i18n.t,
          kind: item.kind,
          isFavorite: isFav,
          ratingValue: currentRating,
          isWatched,
          canDownload,
          collections: collectionMenuOptions,
          currentCollectionId: resolvedCollectionId,
          ...(item.kind === 'movie' ? { onPlay: () => onPlay(buildLibraryPlayTarget(item)) } : {}),
          onOpenDetail: () => {
            if (detail) onOpenDetail(detail);
          },
          onToggleFavorite: () => {
            void data.toggleFavorite(item);
          },
          onToggleLike: () => {
            void data.setRating(item, currentRating === 'like' ? null : 'like');
          },
          onToggleDislike: () => {
            void data.setRating(item, currentRating === 'dislike' ? null : 'dislike');
          },
          onToggleWatched: () => {
            void data.toggleWatched(item, isWatched);
          },
          onMoveToCollection: (targetCollectionId) => {
            void data.moveItemToCollection(item, targetCollectionId);
          },
          onRemoveFromCollection: (colId) => {
            void data.removeItemFromCollection(colId, item.itemKey);
          },
          ...(canDownload
            ? {
                onDownload: () => {
                  void downloads.enqueue({
                    sourceId: item.sourceId,
                    itemKey: item.itemKey,
                    kind: 'movie',
                    title: item.title,
                    poster: item.imageUri,
                  });
                },
              }
            : {}),
        }),
      });
    },
    [collectionMenuOptions, contextMenu, data, downloads, i18n.t, onOpenDetail, onPlay],
  );

  const openDownloadedContextMenu = useCallback(
    (record: DownloadRecord, anchor?: ContextMenuAnchor) => {
      const target = buildOfflineEpisodePlayTarget(record);
      let detailTarget: DetailTarget | undefined;
      if (record.kind === 'movie') {
        detailTarget = buildLibraryDetailTarget({
          itemKey: record.itemKey,
          sourceId: record.sourceId,
          kind: 'movie',
          title: record.title,
          imageUri: record.poster ?? null,
        });
      } else if (record.kind === 'episode') {
        const seriesGroup =
          selectedSeriesGroup ??
          data.downloadedSeriesGroups.find((g) => g.episodes.some((ep) => ep.id === record.id)) ??
          null;
        const seriesKey = seriesGroup?.seriesKey ?? deriveSeriesKeyFromEpisodeRecord(record);
        if (seriesKey) {
          detailTarget = buildLibraryDetailTarget({
            itemKey: seriesKey,
            sourceId: seriesGroup?.sourceId ?? record.sourceId,
            kind: 'series',
            title: seriesGroup?.seriesTitle ?? record.seriesTitle ?? record.title,
            imageUri: seriesGroup?.posterUri ?? record.poster ?? null,
          });
        }
      }
      contextMenu.openContextMenu({
        title: record.title,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildDownloadedMediaMenuItems({
          t: i18n.t,
          onPlayOffline: () => onPlay(target),
          ...(onOpenMultiView !== undefined
            ? { onOpenMultiView: () => onOpenMultiView(target) }
            : {}),
          ...(detailTarget !== undefined ? { onOpenDetail: () => onOpenDetail(detailTarget) } : {}),
          onDelete: () => handleDeleteDownload(record),
        }),
      });
    },
    [
      contextMenu,
      data.downloadedSeriesGroups,
      handleDeleteDownload,
      i18n.t,
      onOpenDetail,
      onOpenMultiView,
      onPlay,
      selectedSeriesGroup,
    ],
  );

  const openActiveDownloadContextMenu = useCallback(
    (record: DownloadRecord, anchor?: ContextMenuAnchor) => {
      const isPausedOrFailed = record.status === 'paused' || record.status === 'failed';
      contextMenu.openContextMenu({
        title: record.title,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildActiveDownloadMenuItems({
          t: i18n.t,
          isPausedOrFailed,
          onTogglePauseResume: () => handleTogglePauseResume(record),
          onCancel: () => handleCancelActive(record),
        }),
      });
    },
    [contextMenu, handleCancelActive, handleTogglePauseResume, i18n.t],
  );

  const navRails = useMemo(
    () =>
      buildLibraryNavRails({
        activeTab,
        favPartition,
        collectionRails,
        ratingPartition,
        watchedMovieCards,
        watchedSeriesCards,
        activeDownloads: dlPartition.active,
        completedMovieCards,
        downloadedSeriesGroups: data.downloadedSeriesGroups,
      }),
    [
      activeTab,
      collectionRails,
      completedMovieCards,
      data.downloadedSeriesGroups,
      dlPartition.active,
      favPartition,
      ratingPartition,
      watchedMovieCards,
      watchedSeriesCards,
    ],
  );

  const seeAllItems = useMemo(
    () =>
      resolveLibrarySeeAllItems({
        seeAll,
        favPartition,
        ratingPartition,
        watchedMovieCards,
        watchedSeriesCards,
        completedMovieCards,
        downloadedSeriesGroups: data.downloadedSeriesGroups,
        collectionRails,
        t: i18n.t,
      }),
    [
      collectionRails,
      completedMovieCards,
      data.downloadedSeriesGroups,
      favPartition,
      i18n.t,
      ratingPartition,
      seeAll,
      watchedMovieCards,
      watchedSeriesCards,
    ],
  );

  const selectSubTab = useCallback((next: LibrarySubTab) => {
    setActiveTab(next);
    setSeeAll(null);
    setSelectedSeriesGroupId(null);
  }, []);

  const tv = useTvLibraryNavigation({
    activeTab,
    navRails,
    seeAll,
    seeAllItems,
    selectedSeriesGroup,
    canCreateCollection,
    onOpenCreateCollection: handleOpenCreateCollection,
    onRenameCollection: handleOpenRenameCollection,
    onDeleteCollection: handleOpenDeleteCollection,
    onSelectTab: selectSubTab,
    onCloseSeeAll: () => setSeeAll(null),
    onSelectSeriesGroup: setSelectedSeriesGroupId,
    onPressCard: handlePressCard,
    onPlayOfflineEpisode: (rec) => onPlay(buildOfflineEpisodePlayTarget(rec)),
    onTogglePauseResume: handleTogglePauseResume,
    onOpenLiveMenu: openLiveContextMenu,
    onOpenVodMenu: (item, colId) => openVodContextMenu(item, undefined, colId),
    onOpenDownloadedMenu: openDownloadedContextMenu,
    onOpenActiveMenu: openActiveDownloadContextMenu,
    onFocusTopNav,
  });

  const handleSelectTabId = useCallback(
    (id: string) => {
      const next = LIBRARY_SUB_TABS.find((t) => t === id);
      if (!next) return;
      selectSubTab(next);
      tv.resetFocus();
    },
    [selectSubTab, tv],
  );

  useEffect(() => {
    if (
      isTv &&
      isActiveScope &&
      seeAll === null &&
      selectedSeriesGroup === null &&
      tv.tvZone === 'create-collection'
    ) {
      scrollViewRef.current?.scrollToEnd({ animated: !theme.reduceMotion });
    }
  }, [isActiveScope, isTv, seeAll, selectedSeriesGroup, theme.reduceMotion, tv.tvZone]);

  const tabItems = useMemo<readonly EditorialCategoryItem[]>(
    () => [
      { id: 'following', label: i18n.t('library.tabFollowing'), testID: 'library-tab-following' },
      { id: 'likes', label: i18n.t('library.tabLikes'), testID: 'library-tab-likes' },
      { id: 'watched', label: i18n.t('library.tabWatched'), testID: 'library-tab-watched' },
      { id: 'downloads', label: i18n.t('library.tabDownloads'), testID: 'library-tab-downloads' },
    ],
    [i18n],
  );

  const focusedRailId =
    isTv && isActiveScope && tv.tvZone === 'content'
      ? (navRails[tv.clampedRowIdx]?.id ?? null)
      : null;
  const focusedColFor = (railId: string): number | null =>
    focusedRailId === railId ? tv.tvColIdx : null;
  const focusedCollectionActionFor = (collectionId: string): 'rename' | 'delete' | null => {
    if (focusedRailId !== `collection-actions-${collectionId}`) return null;
    return tv.tvColIdx === 0 ? 'rename' : 'delete';
  };
  const focusedActiveIdx =
    isTv &&
    isActiveScope &&
    tv.tvZone === 'content' &&
    navRails[tv.clampedRowIdx]?.kind === 'active-download'
      ? tv.clampedRowIdx
      : null;

  return (
    <View testID="library-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && isActiveScope && !contextMenu.isOpen && collectionModal === null ? (
        <LibraryTvKeyBridge onEvent={tv.handleTvKey} />
      ) : null}

      <ScrollView
        ref={scrollViewRef}
        testID="library-scroll"
        {...(isTv ? { focusable: false } : {})}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: isTv ? 16 : 12,
          paddingBottom: theme.spacing.xl + viewport.safeArea.bottom + 24,
          gap: 18,
        }}
      >
        <View style={styles.headerBlock}>
          <View style={[styles.headerTitleRow, { paddingHorizontal: padX }]}>
            <Text style={[theme.typography.h1, { color: theme.colors.textPrimary }]}>
              {i18n.t('library.title')}
            </Text>
          </View>
          <EditorialCategoryBar
            testID="library-subtabs"
            items={tabItems}
            activeId={activeTab}
            onSelect={handleSelectTabId}
            padX={padX}
            isTv={isTv}
            focusedIndex={
              isTv &&
              isActiveScope &&
              tv.tvZone === 'tabs' &&
              seeAll === null &&
              selectedSeriesGroup === null
                ? LIBRARY_SUB_TABS.indexOf(activeTab)
                : null
            }
          />
        </View>

        {selectedSeriesGroup !== null ? (
          <LibraryDownloadedSeriesView
            group={selectedSeriesGroup}
            padX={padX}
            isTv={isTv}
            focusedIndex={isTv && isActiveScope ? tv.tvRowIdx : null}
            onBack={() => setSelectedSeriesGroupId(null)}
            onOpenSeriesDetail={
              selectedSeriesGroup.seriesKey !== null
                ? () => {
                    const target = buildLibraryDetailTarget({
                      itemKey: selectedSeriesGroup.seriesKey ?? '',
                      sourceId: selectedSeriesGroup.sourceId,
                      kind: 'series',
                      title: selectedSeriesGroup.seriesTitle,
                      imageUri: selectedSeriesGroup.posterUri,
                    });
                    if (target) onOpenDetail(target);
                  }
                : undefined
            }
            onPlayOffline={(record) => onPlay(buildOfflineEpisodePlayTarget(record))}
            {...(onOpenMultiView !== undefined
              ? {
                  onOpenMultiView: (record) =>
                    onOpenMultiView(buildOfflineEpisodePlayTarget(record)),
                }
              : {})}
            onDelete={handleDeleteDownload}
            onContextMenu={openDownloadedContextMenu}
          />
        ) : seeAll !== null ? (
          <LibrarySeeAllGrid
            railId={seeAll.railId}
            title={seeAll.title}
            items={seeAllItems}
            variant={seeAll.kind === 'live' ? 'live' : 'poster'}
            cardWidth={seeAll.kind === 'live' ? wideRailWidth : posterRailWidth}
            padX={padX}
            isTv={isTv}
            focusedIndex={isTv && isActiveScope ? tv.tvColIdx : null}
            onBack={() => setSeeAll(null)}
            onPressItem={(item) => {
              if (seeAll.kind === 'downloaded-series') {
                setSelectedSeriesGroupId(item.id);
                tv.setTvRowIdx(0);
              } else {
                handlePressCard(item);
              }
            }}
            onContextMenuItem={(item, anchor) => {
              if (seeAll.kind === 'live') openLiveContextMenu(item, anchor);
              else if (item.downloadRecord) openDownloadedContextMenu(item.downloadRecord, anchor);
              else if (seeAll.kind !== 'downloaded-series') openVodContextMenu(item, anchor);
            }}
          />
        ) : activeTab === 'downloads' ? (
          <LibraryDownloadsTab
            supported={downloads.supported}
            active={dlPartition.active}
            completedMovieCards={completedMovieCards}
            seriesGroups={data.downloadedSeriesGroups}
            totalCompletedBytes={dlPartition.totalCompletedBytes}
            cardWidth={posterRailWidth}
            padX={padX}
            isTv={isTv}
            focusedActiveIndex={focusedActiveIdx}
            focusedMovieIndex={focusedColFor('downloaded-movies')}
            focusedSeriesIndex={focusedColFor('downloaded-series')}
            onTogglePauseResume={handleTogglePauseResume}
            onCancelActive={handleCancelActive}
            onContextMenuActive={openActiveDownloadContextMenu}
            onPressMovie={handlePressCard}
            onContextMenuMovie={(item, anchor) => {
              if (item.downloadRecord) openDownloadedContextMenu(item.downloadRecord, anchor);
            }}
            onPressSeriesGroup={(group) => {
              setSelectedSeriesGroupId(group.groupId);
              tv.setTvRowIdx(0);
            }}
            onSeeAllMovies={() =>
              setSeeAll({
                railId: 'downloaded-movies',
                title: i18n.t('library.railDownloadedMovies'),
                kind: 'downloaded-movies',
              })
            }
            onSeeAllSeries={() =>
              setSeeAll({
                railId: 'downloaded-series',
                title: i18n.t('library.railDownloadedSeries'),
                kind: 'downloaded-series',
              })
            }
          />
        ) : (
          <LibraryEditorialTabs
            activeTab={activeTab}
            favPartition={favPartition}
            collectionRails={collectionRails}
            ratingPartition={ratingPartition}
            watchedMovieCards={watchedMovieCards}
            watchedSeriesCards={watchedSeriesCards}
            posterWidth={posterRailWidth}
            wideWidth={wideRailWidth}
            padX={padX}
            isTv={isTv}
            focusedColFor={focusedColFor}
            focusedCollectionActionFor={focusedCollectionActionFor}
            dragController={dragController}
            onRenameCollection={handleOpenRenameCollection}
            onDeleteCollection={handleOpenDeleteCollection}
            canCreateCollection={canCreateCollection}
            createCollectionFocused={isTv && isActiveScope && tv.tvZone === 'create-collection'}
            onOpenCreateCollection={handleOpenCreateCollection}
            onPressCard={handlePressCard}
            onContextMenuLive={openLiveContextMenu}
            onContextMenuVod={openVodContextMenu}
            onSeeAll={setSeeAll}
          />
        )}
      </ScrollView>

      <LibraryCollectionModals
        modal={collectionModal}
        isTv={isTv}
        onClose={handleCloseCollectionModal}
        onCreate={data.createCollection}
        onRename={data.renameCollection}
        onDelete={data.deleteCollection}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerBlock: { width: '100%', gap: 8 },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
});
