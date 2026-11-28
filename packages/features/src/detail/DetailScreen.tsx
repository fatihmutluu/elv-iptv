import type { CatalogService, EpisodeRow, ItemRow, RatingValue, SeasonRow } from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import { TvFocusAnchor, useI18n, useKeyInterpreter, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, type ListRenderItemInfo, Platform, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import type { TrailerExternalPort } from '../ports/trailer-port';
import type { VideoHost } from '../ports/video-host';
import {
  computeCatalogLayout,
  type DetailTarget,
  detailTargetFromItem,
  type PersonLibraryModalPerson,
  useCardQuickActionsState,
  useRouteActive,
} from '../shared';
import { PersonLibraryModal } from '../shared/PersonLibraryModal';
import { DetailEpisodeRow } from './DetailEpisodeRow';
import {
  DetailListFooterSlot,
  DetailListHeaderSlot,
  DetailListSlotsContext,
  type DetailListSlotsValue,
} from './DetailListHeader';
import { DetailScopePicker, type DetailScopePickerMode } from './DetailScopePicker';
import { DetailSynopsisSheet } from './DetailSynopsisBlock';
import { DetailTrailerModal } from './DetailTrailerModal';
import {
  buildEpisodePlayTarget,
  buildPrimaryPlayAction,
  computeEpisodeRowMetrics,
} from './detail-model';
import {
  isValidTrailerStreamUrl,
  isValidYoutubeId,
  resolveTrailerPlaybackStrategy,
} from './detail-trailer-utils';
import { useDetailData } from './useDetailData';
import { useDetailDownloadActions } from './useDetailDownloadActions';
import { useDetailExtrasState } from './useDetailExtrasState';
import { useDetailScrollAndNav } from './useDetailScrollAndNav';

/** Props of {@link DetailScreen}. */
export interface DetailScreenProps {
  readonly target: DetailTarget;
  readonly catalog: CatalogService;
  readonly videoHost?: VideoHost;
  readonly trailerExternal?: TrailerExternalPort;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly preferredAudioLang?: string;
  readonly preferredSubtitleLang?: string;
  readonly vodEnrichmentEnabled?: boolean;
  readonly elvPreferences?: ElvModePreferences;
  readonly detailTrailerMuted?: boolean;
  readonly trailerPreviewSuppressed?: boolean;
  readonly onToggleDetailTrailerMuted?: () => void;
  readonly onBack: () => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onSearchPerson?: (name: string) => void;
  readonly onScrollTopChange?: (scrolled: boolean) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
}

const EMPTY_EPISODES: readonly EpisodeRow[] = [];
const EMPTY_SEASONS: readonly SeasonRow[] = [];

type TvKeyHandler = Parameters<typeof useKeyInterpreter>[0];

function DetailTvKeyBridge({ onEvent }: { onEvent: TvKeyHandler }): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="detail-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/**
 * Flagship Cinema Quietude 2-column Movie & Series Detail screen (`UI_UX_PHILOSOPHY.md` §1–§6).
 * Uses a single virtualized `FlatList` for endless single-column series episode scrolling (zero
 * 30-episode chunking), interactive per-episode watched toggles, and a shared TV-safe
 * `DetailScopePicker` for Series Hero `✓` (Watched) and `↓` (Download), preserving exact vertical
 * order: **Hero → Cast → Franchise → Season Selector & Episodes → More Like This**.
 */
export function DetailScreen({
  target,
  catalog,
  videoHost,
  trailerExternal,
  refreshToken,
  userStateVersion = 0,
  vodEnrichmentEnabled = false,
  elvPreferences,
  detailTrailerMuted = true,
  trailerPreviewSuppressed = false,
  onToggleDetailTrailerMuted,
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
  const { isTv, isPortrait, padX, railGap, heroTopClearance, posterRailWidth } =
    computeCatalogLayout(viewport, theme);
  const rowMetrics = useMemo(() => computeEpisodeRowMetrics(isPortrait, isTv), [isPortrait, isTv]);

  const [selectedVersionKey, setSelectedVersionKey] = useState<string | null>(null);
  const [activePerson, setActivePerson] = useState<PersonLibraryModalPerson | null>(null);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [scopePickerMode, setScopePickerMode] = useState<DetailScopePickerMode | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset modal, version & measured header height on title change
  useEffect(() => {
    setSelectedVersionKey(null);
    setActivePerson(null);
    setTrailerOpen(false);
    setScopePickerMode(null);
    setHeaderHeight(0);
  }, [target.itemKey]);

  const handleHeaderHeightChange = useCallback((next: number) => {
    if (!Number.isFinite(next) || next < 0) return;
    setHeaderHeight((prev) => (Math.abs(next - prev) > 1 ? next : prev));
  }, []);

  const data = useDetailData({
    target,
    catalog,
    refreshToken,
    userStateVersion,
    vodEnrichmentEnabled,
    ...(elvPreferences !== undefined ? { elvPreferences } : {}),
    locale: i18n.locale,
    selectedVersionKey: target.kind === 'series' ? selectedVersionKey : null,
  });

  const activeVersion = useMemo(() => {
    if (data.versions.length <= 1) return undefined;
    return (
      (selectedVersionKey !== null
        ? data.versions.find((v) => v.key === selectedVersionKey)
        : undefined) ??
      (data.movieProgress?.preferredItemKey
        ? data.versions.find((v) => v.key === data.movieProgress?.preferredItemKey)
        : undefined) ??
      data.versions.find((v) => v.key === target.itemKey) ??
      data.versions[0]
    );
  }, [data.movieProgress?.preferredItemKey, data.versions, selectedVersionKey, target.itemKey]);

  const handleSelectVersion = useCallback((key: string) => setSelectedVersionKey(key), []);

  const activeSeriesKey =
    target.kind === 'series' ? (activeVersion?.key ?? target.itemKey) : target.itemKey;
  const activeSeriesSourceId =
    target.kind === 'series' ? (activeVersion?.sourceId ?? target.sourceId) : target.sourceId;
  const effectivePlayTarget = useMemo<DetailTarget>(
    () =>
      activeSeriesKey === target.itemKey && activeSeriesSourceId === target.sourceId
        ? target
        : { ...target, itemKey: activeSeriesKey, sourceId: activeSeriesSourceId },
    [activeSeriesKey, activeSeriesSourceId, target],
  );

  const seasons = data.seasonsState.kind === 'ready' ? data.seasonsState.seasons : EMPTY_SEASONS;
  const listEpisodes =
    target.kind === 'series' &&
    data.seasonsState.kind === 'ready' &&
    seasons.length > 0 &&
    !data.episodesLoading
      ? data.episodes
      : EMPTY_EPISODES;

  const relatedQuickActions = useCardQuickActionsState({
    catalog,
    refreshToken,
    userStateVersion,
  });
  const elvModeEnabled = elvPreferences?.elvModeEnabled === true;
  const hasTrailer =
    isValidTrailerStreamUrl(data.trailerStreamUrl) || isValidYoutubeId(data.trailerYoutubeId);

  const extras = useDetailExtrasState({
    target,
    plot: data.plot,
    isPortrait,
    fontScale: theme.fontScale,
    cast: data.cast,
    director: data.director,
    versions: data.versions,
    ...(activeVersion !== undefined ? { activeVersionKey: activeVersion.key } : {}),
    onSelectVersion: handleSelectVersion,
  });

  const dl = useDetailDownloadActions({
    catalog,
    target,
    activeVersion,
    activeSeriesKey,
    activeSeriesSourceId,
    resolvedSeriesId: data.resolvedSeriesId,
    seasons,
    selectedSeason: data.selectedSeason,
    currentSeasonEpisodes: data.episodes,
    getCachedSeasonEpisodes: data.getCachedSeasonEpisodes,
    title: data.title,
    backdropUri: data.posterUri ?? data.backdropUri,
    onPlay,
  });

  const flatListRef = useRef<FlatList<EpisodeRow> | null>(null);

  const primaryAction = useMemo(
    () =>
      buildPrimaryPlayAction({
        target: effectivePlayTarget,
        resolvedTitle: data.title,
        movieProgress: data.movieProgress,
        episodes: data.episodes,
        episodeProgressByKey: data.episodeProgressByKey,
        t: i18n.t,
      }),
    [
      data.episodeProgressByKey,
      data.episodes,
      data.movieProgress,
      data.title,
      effectivePlayTarget,
      i18n.t,
    ],
  );

  const handlePlayPrimary = useCallback(() => {
    if (primaryAction.kind === 'pending') return;
    if (primaryAction.kind === 'movie' && activeVersion !== undefined) {
      onPlay({
        ...primaryAction.target,
        itemKey: activeVersion.key,
        sourceId: activeVersion.sourceId ?? primaryAction.target.sourceId,
        title: activeVersion.title,
      });
      return;
    }
    onPlay(primaryAction.target);
  }, [activeVersion, onPlay, primaryAction]);

  const handleOpenTrailer = useCallback(() => {
    if (!hasTrailer) return;
    const strategy = resolveTrailerPlaybackStrategy({
      trailerStreamUrl: data.trailerStreamUrl,
      trailerYoutubeId: data.trailerYoutubeId,
      formFactor: viewport.formFactor,
      platformOs: Platform.OS,
      hasVideoHost: videoHost !== undefined,
    });
    if (strategy.kind === 'external-youtube' && trailerExternal !== undefined) {
      void trailerExternal
        .openExternalUrl(strategy.watchUrl)
        .then((opened) => {
          if (!opened) setTrailerOpen(true);
        })
        .catch(() => setTrailerOpen(true));
      return;
    }
    setTrailerOpen(true);
  }, [
    data.trailerStreamUrl,
    data.trailerYoutubeId,
    hasTrailer,
    trailerExternal,
    videoHost,
    viewport.formFactor,
  ]);

  const handleClosePerson = useCallback(() => setActivePerson(null), []);
  const handleCloseTrailer = useCallback(() => setTrailerOpen(false), []);
  const handleCloseScopePicker = useCallback(() => setScopePickerMode(null), []);

  const handleSelectPerson = useCallback(
    (person: PersonLibraryModalPerson) => {
      if (elvModeEnabled && catalog.listElvPersonLibraryItems !== undefined) {
        setActivePerson(person);
        return;
      }
      onSearchPerson?.(person.name);
    },
    [catalog.listElvPersonLibraryItems, elvModeEnabled, onSearchPerson],
  );

  const handleToggleMyList = useCallback(() => void data.toggleMyList(), [data.toggleMyList]);
  const handlePressHeroWatched = useCallback(() => {
    if (target.kind === 'series') {
      setScopePickerMode('watched');
      return;
    }
    void data.toggleWatched();
  }, [data.toggleWatched, target.kind]);

  const handlePressHeroDownload = useCallback(() => {
    if (target.kind === 'series') {
      setScopePickerMode('download');
      return;
    }
    dl.handlePressMovieDownload();
  }, [dl, target.kind]);

  const handleToggleRating = useCallback(
    (next: RatingValue) => void data.toggleRating(next),
    [data.toggleRating],
  );
  const handleToggleEpisodeWatched = useCallback(
    (episode: EpisodeRow) => void data.toggleEpisodeWatched(episode),
    [data.toggleEpisodeWatched],
  );

  const handleApplyScopeEntireSeries = useCallback(
    async (nextWatched?: boolean): Promise<boolean> => {
      if (scopePickerMode === 'watched') {
        return data.markSeriesWatched(nextWatched ?? !data.isSeriesWatched);
      }
      if (scopePickerMode === 'download') {
        return dl.downloadEntireSeries();
      }
      return true;
    },
    [data, dl, scopePickerMode],
  );

  const handleApplyScopeSeason = useCallback(
    async (season: number, nextWatched?: boolean): Promise<boolean> => {
      if (scopePickerMode === 'watched') {
        return data.markSeasonWatched(season, nextWatched ?? !data.isSeasonWatched(season));
      }
      if (scopePickerMode === 'download') {
        return dl.downloadSeason(season);
      }
      return true;
    },
    [data, dl, scopePickerMode],
  );

  const handlePressEpisode = useCallback(
    (episode: EpisodeRow, index: number) => {
      onPlay(
        buildEpisodePlayTarget({
          target: effectivePlayTarget,
          episode,
          index,
          progress: data.episodeProgressByKey.get(episode.key),
          seriesTitle: data.title,
          t: i18n.t,
          nextEpisodes: data.episodes.slice(index + 1),
        }),
      );
    },
    [data.episodeProgressByKey, data.episodes, data.title, effectivePlayTarget, i18n.t, onPlay],
  );

  const handlePressRelated = useCallback(
    (item: ItemRow) => {
      const next = detailTargetFromItem(item, data.relatedCategoryId);
      if (next) onOpenDetail(next);
    },
    [data.relatedCategoryId, onOpenDetail],
  );
  const handlePressFranchise = useCallback(
    (item: ItemRow) => {
      const next = detailTargetFromItem(item);
      if (next) onOpenDetail(next);
    },
    [onOpenDetail],
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
    (item: ItemRow) => relatedQuickActions.toggleFavorite(item),
    [relatedQuickActions.toggleFavorite],
  );
  const handleQuickToggleRelatedWatched = useCallback(
    (item: ItemRow, currentWatched: boolean) =>
      relatedQuickActions.toggleWatched(item, currentWatched),
    [relatedQuickActions.toggleWatched],
  );
  const handleQuickToggleRelatedRating = useCallback(
    (item: ItemRow, next: RatingValue) => relatedQuickActions.toggleRating(item, next),
    [relatedQuickActions.toggleRating],
  );
  const handleDismissRelatedRecommendation = useCallback(
    (item: ItemRow) => relatedQuickActions.dismissRecommendation(item),
    [relatedQuickActions.dismissRecommendation],
  );
  const visibleRelatedItems = useMemo(
    () =>
      relatedQuickActions.dismissedKeys.size === 0
        ? data.related
        : data.related.filter((item) => !relatedQuickActions.dismissedKeys.has(item.key)),
    [data.related, relatedQuickActions.dismissedKeys],
  );

  const anyModalOpen = activePerson !== null || trailerOpen || scopePickerMode !== null;
  const trailerPreviewActive =
    isActiveScope &&
    !trailerPreviewSuppressed &&
    !anyModalOpen &&
    !extras.synopsisExpanded &&
    !extras.versionMenuOpen;
  const {
    tvNav,
    focusedHeroSlot,
    handleScroll,
    handleScrollToIndexFailed,
    handleTvKeyWithSheet,
    recordCastY,
    recordFranchiseY,
    recordEpisodesY,
  } = useDetailScrollAndNav({
    target,
    data,
    extras,
    seasons,
    listEpisodes,
    showHeroDownload: dl.showHeroDownload,
    downloadsSupported: dl.downloads.supported,
    hasTrailer,
    isTv,
    isActiveScope,
    anyModalOpen,
    reduceMotion: theme.reduceMotion,
    heroTopClearance,
    headerHeight,
    rowMetrics,
    flatListRef,
    onBack,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
    ...(onScrollTopChange !== undefined ? { onScrollTopChange } : {}),
    onPlayPrimary: handlePlayPrimary,
    onPressHeroWatched: handlePressHeroWatched,
    onPressHeroDownload: handlePressHeroDownload,
    onOpenTrailer: handleOpenTrailer,
    onSelectPerson: handleSelectPerson,
    onPressFranchise: handlePressFranchise,
    onPressEpisode: handlePressEpisode,
    onPressEpisodeDownload: dl.handlePressEpisodeDownload,
    onPressRelated: handlePressRelated,
  });

  const watchedLabel = i18n.t('home.watchedBadge');
  const heroWatched =
    target.kind === 'series' ? data.isSeriesWatched : data.movieProgress?.watched === true;

  const keyExtractor = useCallback((ep: EpisodeRow) => ep.key, []);
  const getItemLayout = useCallback(
    (_items: ArrayLike<EpisodeRow> | null | undefined, index: number) => ({
      length: rowMetrics.itemStride,
      offset: headerHeight + rowMetrics.itemStride * index,
      index,
    }),
    [headerHeight, rowMetrics.itemStride],
  );

  const renderEpisodeItem = useCallback(
    ({ item, index }: ListRenderItemInfo<EpisodeRow>): ReactElement => {
      const isFocusedRow = isTv && tvNav.focusedRowId === 'episodes' && tvNav.focusedCol === index;
      return (
        <View
          style={{
            height: rowMetrics.itemStride,
            paddingHorizontal: padX,
            paddingBottom: rowMetrics.gap,
            opacity: data.episodesRefreshing ? 0.72 : 1,
          }}
        >
          <DetailEpisodeRow
            episode={item}
            index={index}
            progress={data.episodeProgressByKey.get(item.key)}
            seriesBackdropUri={data.backdropUri}
            isTv={isTv}
            isPortrait={isPortrait}
            focused={isFocusedRow}
            focusedAction={isFocusedRow ? tvNav.focusedEpisodeAction : null}
            rowHeight={rowMetrics.rowHeight}
            watchedLabel={watchedLabel}
            onPressEpisode={handlePressEpisode}
            onToggleWatched={handleToggleEpisodeWatched}
            downloadsSupported={dl.downloads.supported}
            downloadRecord={dl.downloads.byItemKey.get(item.key)}
            onPressDownload={dl.handlePressEpisodeDownload}
          />
        </View>
      );
    },
    [
      data.backdropUri,
      data.episodeProgressByKey,
      data.episodesRefreshing,
      dl.downloads.byItemKey,
      dl.downloads.supported,
      dl.handlePressEpisodeDownload,
      handlePressEpisode,
      handleToggleEpisodeWatched,
      isPortrait,
      isTv,
      padX,
      rowMetrics.gap,
      rowMetrics.itemStride,
      rowMetrics.rowHeight,
      tvNav.focusedCol,
      tvNav.focusedEpisodeAction,
      tvNav.focusedRowId,
      watchedLabel,
    ],
  );

  const slotsValue = useMemo<DetailListSlotsValue>(
    () => ({
      header: {
        target,
        data,
        extras,
        activeVersion,
        ...(elvPreferences !== undefined ? { elvPreferences } : {}),
        seasonsCount: seasons.length,
        heroWatched,
        heroDownloadState: dl.heroDownloadState,
        hasTrailer,
        detailTrailerMuted,
        trailerPreviewActive,
        primaryAction,
        focusedHeroSlot,
        focusedRowId: tvNav.focusedRowId,
        focusedCol: tvNav.focusedCol,
        isTv,
        isPortrait,
        heroTopClearance,
        padX,
        posterRailWidth,
        railGap,
        onBack,
        onPlayPrimary: handlePlayPrimary,
        onToggleMyList: handleToggleMyList,
        onToggleRating: handleToggleRating,
        onPressHeroWatched: handlePressHeroWatched,
        onPressHeroDownload: handlePressHeroDownload,
        onOpenTrailer: handleOpenTrailer,
        ...(onToggleDetailTrailerMuted !== undefined ? { onToggleDetailTrailerMuted } : {}),
        onSelectVersion: handleSelectVersion,
        onSelectPerson: handleSelectPerson,
        ...(onSearchPerson !== undefined ? { onSearchPerson } : {}),
        onPressFranchise: handlePressFranchise,
        onRecordCastY: recordCastY,
        onRecordFranchiseY: recordFranchiseY,
        onRecordEpisodesY: recordEpisodesY,
        onHeaderHeightChange: handleHeaderHeightChange,
      },
      footer: {
        data,
        relatedItems: visibleRelatedItems,
        favoriteKeys: relatedQuickActions.favoriteKeys,
        watchedOverrides: relatedQuickActions.watchedOverrides,
        ratingByKey: relatedQuickActions.ratingByKey,
        cardWidth: posterRailWidth,
        gap: railGap,
        padX,
        isTv,
        focusedIndex: tvNav.focusedRowId === 'related' ? tvNav.focusedCol : null,
        onPressItem: handlePressRelated,
        onQuickPlay: handleQuickPlayRelated,
        onQuickToggleFavorite: handleQuickToggleRelatedFavorite,
        onQuickToggleWatched: handleQuickToggleRelatedWatched,
        onQuickToggleRating: handleQuickToggleRelatedRating,
        onDismissRecommendation: handleDismissRelatedRecommendation,
      },
    }),
    [
      activeVersion,
      data,
      detailTrailerMuted,
      dl.heroDownloadState,
      elvPreferences,
      extras,
      focusedHeroSlot,
      handleDismissRelatedRecommendation,
      handleHeaderHeightChange,
      handleOpenTrailer,
      handlePlayPrimary,
      handlePressFranchise,
      handlePressHeroDownload,
      handlePressHeroWatched,
      handlePressRelated,
      handleQuickPlayRelated,
      handleQuickToggleRelatedFavorite,
      handleQuickToggleRelatedRating,
      handleQuickToggleRelatedWatched,
      handleSelectPerson,
      handleSelectVersion,
      handleToggleMyList,
      handleToggleRating,
      hasTrailer,
      heroTopClearance,
      heroWatched,
      isPortrait,
      isTv,
      onBack,
      onSearchPerson,
      onToggleDetailTrailerMuted,
      padX,
      posterRailWidth,
      primaryAction,
      railGap,
      recordCastY,
      recordEpisodesY,
      recordFranchiseY,
      relatedQuickActions.favoriteKeys,
      relatedQuickActions.ratingByKey,
      relatedQuickActions.watchedOverrides,
      seasons.length,
      target,
      trailerPreviewActive,
      tvNav.focusedCol,
      tvNav.focusedRowId,
      visibleRelatedItems,
    ],
  );

  return (
    <View testID="detail-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && isActiveScope && !dl.contextMenu.isOpen && !anyModalOpen ? (
        <DetailTvKeyBridge onEvent={handleTvKeyWithSheet} />
      ) : null}

      <DetailListSlotsContext.Provider value={slotsValue}>
        <FlatList
          ref={flatListRef}
          testID="detail-scroll"
          data={listEpisodes}
          keyExtractor={keyExtractor}
          renderItem={renderEpisodeItem}
          getItemLayout={getItemLayout}
          windowSize={7}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          ListHeaderComponent={DetailListHeaderSlot}
          ListFooterComponent={DetailListFooterSlot}
          {...(isTv ? { focusable: false } : {})}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: theme.spacing.xl + viewport.safeArea.bottom + (!isPortrait ? 16 : 24),
          }}
        />
      </DetailListSlotsContext.Provider>

      <DetailSynopsisSheet
        visible={extras.synopsisExpanded && extras.trimmedPlot.length > 0 && (isTv || isPortrait)}
        title={data.title}
        synopsis={extras.trimmedPlot}
        isTv={isTv}
        onDismiss={extras.dismissSynopsis}
      />

      <DetailScopePicker
        visible={scopePickerMode !== null}
        mode={scopePickerMode ?? 'watched'}
        seriesTitle={data.title}
        seasons={seasons}
        defaultSeason={data.selectedSeason}
        entireSeriesWatched={data.isSeriesWatched}
        isSeasonWatched={data.isSeasonWatched}
        onApplyEntireSeries={handleApplyScopeEntireSeries}
        onApplySeason={handleApplyScopeSeason}
        onClose={handleCloseScopePicker}
      />

      <PersonLibraryModal
        visible={activePerson !== null}
        person={activePerson}
        catalog={catalog}
        {...(elvPreferences !== undefined ? { elvPreferences } : {})}
        onSelectItem={onOpenDetail}
        onClose={handleClosePerson}
      />

      <DetailTrailerModal
        visible={trailerOpen}
        title={data.title}
        trailerStreamUrl={data.trailerStreamUrl}
        trailerYoutubeId={data.trailerYoutubeId}
        {...(videoHost !== undefined ? { videoHost } : {})}
        {...(trailerExternal !== undefined ? { trailerExternal } : {})}
        onClose={handleCloseTrailer}
      />
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
