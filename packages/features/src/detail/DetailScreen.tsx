import type { CatalogService, EpisodeRow, ItemRow, RatingValue } from '@elv/data';
import { computeDownloadProgressRatio, isPlayableDownload } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import {
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
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  computeCatalogLayout,
  type DetailTarget,
  detailTargetFromItem,
  useCardQuickActionsState,
  useDownloads,
  useRouteActive,
} from '../shared';
import { CollectionPickerOverlay } from '../shared/CollectionPickerOverlay';
import { DetailCastStrip } from './DetailCastStrip';
import { DetailEpisodes } from './DetailEpisodes';
import { DetailHero, type DetailHeroDownloadState, type DetailHeroFocusSlot } from './DetailHero';
import { DetailSynopsisSheet } from './DetailHeroExtras';
import { DetailRelatedRail } from './DetailRelatedRail';
import {
  buildDetailNavRows,
  buildEpisodePlayTarget,
  buildPrimaryPlayAction,
  type DetailNavRowId,
} from './detail-model';
import { useDetailData } from './useDetailData';
import { useDetailExtrasState } from './useDetailExtrasState';
import { useEpisodeChunks } from './useEpisodeChunks';
import { useTvDetailNavigation } from './useTvDetailNavigation';

/** Props of {@link DetailScreen}. */
export interface DetailScreenProps {
  readonly target: DetailTarget;
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly preferredAudioLang?: string;
  readonly preferredSubtitleLang?: string;
  readonly vodEnrichmentEnabled?: boolean;
  readonly onBack: () => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onSearchPerson?: (name: string) => void;
  readonly onScrollTopChange?: (scrolled: boolean) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
}

const SCROLL_FROST_THRESHOLD = 24;
const EPISODE_ROW_ESTIMATE_HEIGHT = 112;

type TvKeyHandler = Parameters<typeof useKeyInterpreter>[0];

function DetailTvKeyBridge({ onEvent }: { onEvent: TvKeyHandler }): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="detail-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/**
 * Flagship Cinema Quietude 2-column Movie & Series Detail screen (`UI_UX_PHILOSOPHY.md` §1–§6).
 * Preserves exact vertical order: **Hero → Cast (when present) → Season Selector & Episodes →
 * More Like This**, with zero-jank memoized sections and 10-ft TV D-pad focus landing directly
 * on the primary Play / Resume CTA.
 */
export function DetailScreen({
  target,
  catalog,
  refreshToken,
  userStateVersion = 0,
  vodEnrichmentEnabled = false,
  onBack,
  onPlay,
  onOpenDetail,
  onSearchPerson,
  onScrollTopChange,
  onFocusTopNav,
  isActiveScope = true,
}: DetailScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const downloads = useDownloads();
  const contextMenu = useContextMenu();

  const { isTv, isPortrait, padX, railGap, heroTopClearance, posterRailWidth } =
    computeCatalogLayout(viewport, theme);

  const data = useDetailData({
    target,
    catalog,
    refreshToken,
    userStateVersion,
    vodEnrichmentEnabled,
  });
  const [selectedVersionKey, setSelectedVersionKey] = useState<string | null>(null);
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset user version override and collection picker on title change
  useEffect(() => {
    setSelectedVersionKey(null);
    setCollectionPickerOpen(false);
  }, [target.itemKey]);
  const activeVersion = useMemo(() => {
    if (data.versions.length <= 1) return undefined;
    const picked =
      (selectedVersionKey !== null
        ? data.versions.find((v) => v.key === selectedVersionKey)
        : undefined) ??
      (data.movieProgress?.preferredItemKey
        ? data.versions.find((v) => v.key === data.movieProgress?.preferredItemKey)
        : undefined) ??
      data.versions.find((v) => v.key === target.itemKey) ??
      data.versions[0];
    return picked;
  }, [data.movieProgress?.preferredItemKey, data.versions, selectedVersionKey, target.itemKey]);
  const handleSelectVersion = useCallback((key: string) => {
    setSelectedVersionKey(key);
  }, []);
  const relatedQuickActions = useCardQuickActionsState({
    catalog,
    refreshToken,
    userStateVersion,
  });
  const extras = useDetailExtrasState({
    target,
    plot: data.plot,
    versions: data.versions,
    ...(activeVersion !== undefined ? { activeVersionKey: activeVersion.key } : {}),
    onSelectVersion: handleSelectVersion,
  });
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const scrolledRef = useRef(false);
  const castYRef = useRef<number | null>(null);
  const episodesYRef = useRef<number | null>(null);
  const relatedYRef = useRef<number | null>(null);

  const reportScrolled = useCallback(
    (next: boolean) => {
      if (next !== scrolledRef.current) {
        scrolledRef.current = next;
        onScrollTopChange?.(next);
      }
    },
    [onScrollTopChange],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll & frosted header whenever opening a new title
  useEffect(() => {
    scrolledRef.current = false;
    castYRef.current = null;
    onScrollTopChange?.(false);
    scrollViewRef.current?.scrollTo({ y: 0, animated: false });
  }, [onScrollTopChange, target.itemKey]);

  const primaryAction = useMemo(
    () =>
      buildPrimaryPlayAction({
        target,
        resolvedTitle: data.title,
        movieProgress: data.movieProgress,
        episodes: data.episodes,
        episodeProgressByKey: data.episodeProgressByKey,
        t: i18n.t,
      }),
    [data.episodeProgressByKey, data.episodes, data.movieProgress, data.title, i18n.t, target],
  );

  const handlePlayPrimary = useCallback(() => {
    if (primaryAction.kind === 'pending') return;
    if (primaryAction.kind === 'movie' && activeVersion !== undefined) {
      onPlay({
        ...primaryAction.target,
        itemKey: activeVersion.key,
        title: activeVersion.title,
      });
      return;
    }
    onPlay(primaryAction.target);
  }, [activeVersion, onPlay, primaryAction]);

  const handleToggleMyList = useCallback(() => void data.toggleMyList(), [data.toggleMyList]);
  const handleToggleWatched = useCallback(() => void data.toggleWatched(), [data.toggleWatched]);
  const handleToggleRating = useCallback(
    (next: RatingValue) => void data.toggleRating(next),
    [data.toggleRating],
  );

  const handlePressEpisode = useCallback(
    (episode: EpisodeRow, index: number) => {
      onPlay(
        buildEpisodePlayTarget({
          target,
          episode,
          index,
          progress: data.episodeProgressByKey.get(episode.key),
          seriesTitle: data.title,
          t: i18n.t,
          nextEpisodes: data.episodes.slice(index + 1),
        }),
      );
    },
    [data.episodeProgressByKey, data.episodes, data.title, i18n.t, onPlay, target],
  );

  const handlePressRelated = useCallback(
    (item: ItemRow) => {
      const next = detailTargetFromItem(item, data.relatedCategoryId);
      if (next) onOpenDetail(next);
    },
    [data.relatedCategoryId, onOpenDetail],
  );
  const handleQuickPlayRelated = useCallback(
    (item: ItemRow) => {
      if (item.kind === 'movie') {
        onPlay({
          itemKey: item.key,
          sourceId: item.sourceId,
          title: item.name,
          kind: 'vod',
          itemKind: 'movie',
          ...(item.logo !== null ? { logo: item.logo } : {}),
        });
        return;
      }
      handlePressRelated(item);
    },
    [handlePressRelated, onPlay],
  );
  const handleQuickToggleRelatedFavorite = useCallback(
    (item: ItemRow) => void relatedQuickActions.toggleFavorite(item),
    [relatedQuickActions.toggleFavorite],
  );
  const handleQuickToggleRelatedWatched = useCallback(
    (item: ItemRow, currentWatched: boolean) =>
      void relatedQuickActions.toggleWatched(item, currentWatched),
    [relatedQuickActions.toggleWatched],
  );

  const seasons = data.seasonsState.kind === 'ready' ? data.seasonsState.seasons : [];
  const hasCollections = typeof catalog.listCollections === 'function';
  const showMovieDownload = target.kind === 'movie' && downloads.supported;
  const activeMovieKey = activeVersion?.key ?? target.itemKey;
  const activeMovieTitle = activeVersion?.title ?? data.title;
  const movieDownloadRecord = showMovieDownload
    ? downloads.byItemKey.get(activeMovieKey)
    : undefined;

  const movieDownloadState = useMemo<DetailHeroDownloadState | undefined>(() => {
    if (!showMovieDownload) return undefined;
    if (isPlayableDownload(movieDownloadRecord)) {
      return { icon: 'check', active: true, label: i18n.t('downloads.actionDownloaded') };
    }
    if (movieDownloadRecord?.status === 'downloading' || movieDownloadRecord?.status === 'queued') {
      const pct = Math.round(
        (computeDownloadProgressRatio(
          movieDownloadRecord.bytesDownloaded,
          movieDownloadRecord.totalBytes,
        ) ?? 0) * 100,
      );
      return {
        icon: 'pause',
        active: true,
        label: i18n.t('downloads.actionDownloading', { percent: pct }),
      };
    }
    if (movieDownloadRecord?.status === 'paused' || movieDownloadRecord?.status === 'failed') {
      return { icon: 'download', active: false, label: i18n.t('downloads.actionResume') };
    }
    return { icon: 'download', active: false, label: i18n.t('downloads.actionDownload') };
  }, [i18n, movieDownloadRecord, showMovieDownload]);

  const handlePressMovieDownload = useCallback(() => {
    if (!showMovieDownload) return;
    if (movieDownloadRecord && isPlayableDownload(movieDownloadRecord)) {
      contextMenu.openContextMenu({
        title: activeMovieTitle,
        items: [
          {
            id: 'play-offline',
            label: i18n.t('downloads.actionPlayOffline'),
            icon: 'play',
            testID: 'detail-download-play-offline',
            onSelect: () => {
              onPlay({
                itemKey: activeMovieKey,
                sourceId: target.sourceId,
                title: activeMovieTitle,
                kind: 'vod',
                itemKind: 'movie',
                isLocalOffline: true,
                localFileUri: movieDownloadRecord.localUri,
                ...(data.backdropUri !== null ? { logo: data.backdropUri } : {}),
              });
            },
          },
          {
            id: 'delete-download',
            label: i18n.t('downloads.actionDelete'),
            icon: 'trash',
            destructive: true,
            testID: 'detail-download-delete',
            onSelect: () => {
              void downloads.remove(activeMovieKey);
            },
          },
        ],
      });
      return;
    }
    if (movieDownloadRecord?.status === 'downloading' || movieDownloadRecord?.status === 'queued') {
      void downloads.pause(activeMovieKey);
      return;
    }
    if (movieDownloadRecord?.status === 'paused' || movieDownloadRecord?.status === 'failed') {
      void downloads.resume(activeMovieKey);
      return;
    }
    void downloads.enqueue({
      sourceId: target.sourceId,
      itemKey: activeMovieKey,
      kind: 'movie',
      title: activeMovieTitle,
      poster: data.backdropUri,
    });
  }, [
    activeMovieKey,
    activeMovieTitle,
    contextMenu,
    data.backdropUri,
    downloads,
    i18n,
    movieDownloadRecord,
    onPlay,
    showMovieDownload,
    target.sourceId,
  ]);

  const handlePressEpisodeDownload = useCallback(
    (episode: EpisodeRow) => {
      if (!downloads.supported) return;
      const rec = downloads.byItemKey.get(episode.key);
      const epTitle =
        episode.title?.trim() ||
        i18n.t('series.episodeUntitled', { episode: episode.episode ?? 1 });
      if (rec && isPlayableDownload(rec)) {
        contextMenu.openContextMenu({
          title: epTitle,
          items: [
            {
              id: 'play-offline',
              label: i18n.t('downloads.actionPlayOffline'),
              icon: 'play',
              testID: 'detail-episode-download-play-offline',
              onSelect: () => {
                onPlay({
                  itemKey: episode.key,
                  sourceId: target.sourceId,
                  title: epTitle,
                  kind: 'vod',
                  itemKind: 'episode',
                  isLocalOffline: true,
                  localFileUri: rec.localUri,
                  subtitle: data.title,
                  ...(episode.season !== null ? { season: episode.season } : {}),
                  ...(episode.episode !== null ? { episode: episode.episode } : {}),
                  ...(data.backdropUri !== null ? { logo: data.backdropUri } : {}),
                });
              },
            },
            {
              id: 'delete-download',
              label: i18n.t('downloads.actionDelete'),
              icon: 'trash',
              destructive: true,
              testID: 'detail-episode-download-delete',
              onSelect: () => {
                void downloads.remove(episode.key);
              },
            },
          ],
        });
        return;
      }
      if (rec?.status === 'downloading' || rec?.status === 'queued') {
        void downloads.pause(episode.key);
        return;
      }
      if (rec?.status === 'paused' || rec?.status === 'failed') {
        void downloads.resume(episode.key);
        return;
      }
      void downloads.enqueue({
        sourceId: target.sourceId,
        itemKey: episode.key,
        kind: 'episode',
        title: epTitle,
        seriesTitle: data.title,
        season: episode.season,
        episodeNum: episode.episode,
        poster: data.backdropUri,
      });
    },
    [contextMenu, data.backdropUri, data.title, downloads, i18n, onPlay, target.sourceId],
  );

  const heroActionSlots = useMemo<
    readonly ('mylist' | 'like' | 'dislike' | 'watched' | 'download' | 'collections')[]
  >(
    () => [
      'mylist',
      'like',
      'dislike',
      ...(target.kind === 'movie' ? (['watched'] as const) : []),
      ...(showMovieDownload ? (['download'] as const) : []),
      ...(hasCollections ? (['collections'] as const) : []),
    ],
    [hasCollections, showMovieDownload, target.kind],
  );
  const heroActionCount = heroActionSlots.length;
  const handleOpenCollections = useCallback(() => setCollectionPickerOpen(true), []);
  const handleCloseCollections = useCallback(() => setCollectionPickerOpen(false), []);

  const {
    chunks: episodeChunks,
    selectedChunkIndex,
    visibleEpisodes,
    episodeIndexOffset,
    selectChunk: handleSelectChunk,
  } = useEpisodeChunks({
    itemKey: target.itemKey,
    selectedSeason: data.selectedSeason,
    episodes: data.episodes,
    episodeProgressByKey: data.episodeProgressByKey,
  });

  const navRows = useMemo(
    () =>
      buildDetailNavRows({
        heroActionCount,
        heroPlayCount: extras.heroPlaySlots.length,
        castCount: extras.castPeople.length,
        seasonsCount: target.kind === 'series' ? seasons.length : 0,
        episodeChunksCount:
          target.kind === 'series' && !data.episodesLoading ? episodeChunks.length : 0,
        episodesCount:
          target.kind === 'series' && !data.episodesLoading ? visibleEpisodes.length : 0,
        hasSeasonsError: target.kind === 'series' && data.seasonsState.kind === 'error',
        relatedCount: data.related.length,
      }),
    [
      data.episodesLoading,
      data.related.length,
      data.seasonsState.kind,
      episodeChunks.length,
      extras.castPeople.length,
      extras.heroPlaySlots.length,
      heroActionCount,
      seasons.length,
      target.kind,
      visibleEpisodes.length,
    ],
  );

  const handleTvActivate = useCallback(
    (rowId: DetailNavRowId, colIndex: number) => {
      if (rowId === 'back') return onBack();
      if (rowId === 'hero-actions') {
        const slot = heroActionSlots[colIndex];
        if (slot === 'mylist') void data.toggleMyList();
        else if (slot === 'like') void data.toggleRating('like');
        else if (slot === 'dislike') void data.toggleRating('dislike');
        else if (slot === 'watched') void data.toggleWatched();
        else if (slot === 'download') handlePressMovieDownload();
        else if (slot === 'collections') setCollectionPickerOpen(true);
        return;
      }
      if (rowId === 'hero-play') {
        const slot = extras.heroPlaySlots[colIndex];
        if (slot === 'play') handlePlayPrimary();
        else if (slot === 'preplay-version') extras.toggleVersionMenu();
        else if (slot === 'synopsis') extras.toggleSynopsis();
        return;
      }
      if (rowId === 'cast') {
        const person = extras.castPeople[colIndex];
        if (person) onSearchPerson?.(person);
        return;
      }
      if (rowId === 'seasons') {
        const picked = seasons[colIndex];
        if (picked) data.selectSeason(picked.season);
        return;
      }
      if (rowId === 'episode-chunks') {
        if (episodeChunks[colIndex]) handleSelectChunk(colIndex);
        return;
      }
      if (rowId === 'retry') return data.retrySeasons();
      if (rowId === 'episodes') {
        const ep = visibleEpisodes[colIndex];
        if (ep) handlePressEpisode(ep, episodeIndexOffset + colIndex);
        return;
      }
      if (rowId === 'related') {
        const item = data.related[colIndex];
        if (item) handlePressRelated(item);
      }
    },
    [
      data.related,
      data.retrySeasons,
      data.selectSeason,
      data.toggleMyList,
      data.toggleRating,
      data.toggleWatched,
      episodeChunks,
      episodeIndexOffset,
      extras,
      handlePlayPrimary,
      handlePressEpisode,
      handlePressMovieDownload,
      handlePressRelated,
      handleSelectChunk,
      heroActionSlots,
      onBack,
      onSearchPerson,
      seasons,
      visibleEpisodes,
    ],
  );

  const handleTvFocusRow = useCallback(
    (rowId: DetailNavRowId, colIndex: number) => {
      if (rowId === 'back' || rowId === 'hero-actions' || rowId === 'hero-play') {
        scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
        reportScrolled(false);
        return;
      }
      if (rowId === 'cast' && castYRef.current !== null) {
        const targetY = Math.max(0, castYRef.current - heroTopClearance);
        scrollViewRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
        reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
        return;
      }
      if (
        rowId === 'seasons' ||
        rowId === 'episode-chunks' ||
        rowId === 'retry' ||
        rowId === 'episodes'
      ) {
        const baseY = episodesYRef.current;
        if (baseY !== null) {
          const epOffset = rowId === 'episodes' ? colIndex * EPISODE_ROW_ESTIMATE_HEIGHT : 0;
          const targetY = Math.max(0, baseY + epOffset - heroTopClearance);
          scrollViewRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
          reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
        }
        return;
      }
      if (rowId === 'related' && relatedYRef.current !== null) {
        const targetY = Math.max(0, relatedYRef.current - heroTopClearance);
        scrollViewRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
        reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
      }
    },
    [heroTopClearance, reportScrolled, theme.reduceMotion],
  );

  const tvNav = useTvDetailNavigation({
    isTv,
    isActiveScope,
    targetKey: target.itemKey,
    rows: navRows,
    selectedChunkIndex,
    onActivate: handleTvActivate,
    onBack,
    onFocusRow: handleTvFocusRow,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      reportScrolled(event.nativeEvent.contentOffset.y > SCROLL_FROST_THRESHOLD);
    },
    [reportScrolled],
  );

  const recordCastY = useCallback((y: number) => {
    castYRef.current = y;
  }, []);
  const recordEpisodesY = useCallback((y: number) => {
    episodesYRef.current = y;
  }, []);
  const recordRelatedY = useCallback((y: number) => {
    relatedYRef.current = y;
  }, []);

  const handleTvKeyWithSheet = useCallback(
    (event: KeyEvent): boolean => extras.interceptTvKey(event, tvNav.handleTvKey),
    [extras, tvNav.handleTvKey],
  );

  const focusedHeroSlot: DetailHeroFocusSlot | null =
    tvNav.focusedRowId === 'back'
      ? 'back'
      : tvNav.focusedRowId === 'hero-play'
        ? (extras.heroPlaySlots[tvNav.focusedCol ?? 0] ?? 'play')
        : tvNav.focusedRowId === 'hero-actions'
          ? (heroActionSlots[tvNav.focusedCol ?? 0] ?? 'mylist')
          : null;

  return (
    <View testID="detail-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && isActiveScope && !collectionPickerOpen && !contextMenu.isOpen ? (
        <DetailTvKeyBridge onEvent={handleTvKeyWithSheet} />
      ) : null}

      <ScrollView
        ref={scrollViewRef}
        testID="detail-scroll"
        {...(isTv ? { focusable: false } : {})}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: theme.spacing.xl + viewport.safeArea.bottom + (!isPortrait ? 16 : 24),
        }}
      >
        <DetailHero
          kind={target.kind}
          title={data.title}
          backdropUri={data.backdropUri}
          year={data.year}
          rating={data.rating}
          plot={data.plot}
          genres={data.genres}
          isEnriched={data.isEnriched}
          collectionCount={data.collectionIds.length}
          {...(hasCollections ? { onOpenCollections: handleOpenCollections } : {})}
          {...(movieDownloadState !== undefined
            ? {
                downloadState: movieDownloadState,
                onPressDownload: handlePressMovieDownload,
              }
            : {})}
          {...(target.technicalMeta !== undefined ? { technicalMeta: target.technicalMeta } : {})}
          seasonsCount={seasons.length}
          inMyList={data.inMyList}
          userRating={data.userRating}
          watched={data.movieProgress?.watched === true}
          primaryAction={primaryAction}
          {...(activeVersion !== undefined && data.versions.length > 1
            ? {
                versions: data.versions,
                activeVersionKey: activeVersion.key,
                activeVersionLabel: activeVersion.versionLabel || activeVersion.title,
                versionMenuOpen: extras.versionMenuOpen,
                versionMenuIndex: extras.versionMenuIndex,
                onToggleVersionMenu: extras.toggleVersionMenu,
                onCloseVersionMenu: extras.closeVersionMenu,
                onSelectVersion: handleSelectVersion,
              }
            : {})}
          synopsisExpanded={extras.synopsisExpanded}
          onToggleSynopsis={extras.toggleSynopsis}
          onBack={onBack}
          onPlayPrimary={handlePlayPrimary}
          onToggleMyList={handleToggleMyList}
          onToggleRating={handleToggleRating}
          onToggleWatched={handleToggleWatched}
          isTv={isTv}
          isPortrait={isPortrait}
          topClearance={heroTopClearance}
          padX={padX}
          focusedSlot={focusedHeroSlot}
        />

        {extras.castPeople.length > 0 ? (
          <DetailCastStrip
            cast={target.cast ?? []}
            {...(target.director !== undefined ? { director: target.director } : {})}
            padX={padX}
            isTv={isTv}
            focusedIndex={tvNav.focusedRowId === 'cast' ? tvNav.focusedCol : null}
            {...(onSearchPerson !== undefined ? { onSearchPerson } : {})}
            onLayoutY={recordCastY}
          />
        ) : null}

        {target.kind === 'series' ? (
          <DetailEpisodes
            seasonsState={data.seasonsState}
            selectedSeason={data.selectedSeason}
            episodes={visibleEpisodes}
            episodesLoading={data.episodesLoading}
            episodesRefreshing={data.episodesRefreshing}
            episodeProgressByKey={data.episodeProgressByKey}
            seriesBackdropUri={data.backdropUri}
            onSelectSeason={data.selectSeason}
            onRetrySeasons={data.retrySeasons}
            onPressEpisode={handlePressEpisode}
            chunks={episodeChunks}
            selectedChunkIndex={selectedChunkIndex}
            focusedChunkIndex={tvNav.focusedRowId === 'episode-chunks' ? tvNav.focusedCol : null}
            episodeIndexOffset={episodeIndexOffset}
            onSelectChunk={handleSelectChunk}
            isTv={isTv}
            isPortrait={isPortrait}
            padX={padX}
            focusedSeasonIndex={tvNav.focusedRowId === 'seasons' ? tvNav.focusedCol : null}
            focusedEpisodeIndex={tvNav.focusedRowId === 'episodes' ? tvNav.focusedCol : null}
            focusedRetry={tvNav.focusedRowId === 'retry'}
            onLayoutY={recordEpisodesY}
            downloadsSupported={downloads.supported}
            downloadsByKey={downloads.byItemKey}
            onPressEpisodeDownload={handlePressEpisodeDownload}
          />
        ) : null}

        <DetailRelatedRail
          items={data.related}
          progressByKey={data.relatedProgressByKey}
          favoriteKeys={relatedQuickActions.favoriteKeys}
          watchedOverrides={relatedQuickActions.watchedOverrides}
          unplayedBySeriesKey={data.relatedUnplayedBySeriesKey}
          cardWidth={posterRailWidth}
          gap={railGap}
          padX={padX}
          isTv={isTv}
          focusedIndex={tvNav.focusedRowId === 'related' ? tvNav.focusedCol : null}
          onPressItem={handlePressRelated}
          onQuickPlay={handleQuickPlayRelated}
          onQuickToggleFavorite={handleQuickToggleRelatedFavorite}
          onQuickToggleWatched={handleQuickToggleRelatedWatched}
          onLayoutY={recordRelatedY}
        />
      </ScrollView>

      <DetailSynopsisSheet
        visible={extras.synopsisExpanded && extras.canExpandSynopsis}
        title={data.title}
        synopsis={extras.trimmedPlot}
        isTv={isTv}
        onDismiss={extras.dismissSynopsis}
      />

      <CollectionPickerOverlay
        visible={collectionPickerOpen}
        catalog={catalog}
        itemKey={target.itemKey}
        itemKind={target.kind}
        itemTitle={data.title}
        onMutated={data.setCollectionIds}
        onClose={handleCloseCollections}
      />
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
