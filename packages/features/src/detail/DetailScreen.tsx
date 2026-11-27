import type { CatalogService, EpisodeRow, ItemRow, RatingValue } from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import { TvFocusAnchor, useI18n, useKeyInterpreter, useTheme, useViewport } from '@elv/ui-kit';
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
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
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
import { DetailCastStrip } from './DetailCastStrip';
import { DetailEpisodes } from './DetailEpisodes';
import { DetailFixMatchModal } from './DetailFixMatchModal';
import { DetailFranchiseStrip } from './DetailFranchiseStrip';
import { DetailHero, type DetailHeroFocusSlot } from './DetailHero';
import { DetailSynopsisSheet } from './DetailHeroExtras';
import { DetailRelatedRail } from './DetailRelatedRail';
import { DetailTrailerModal } from './DetailTrailerModal';
import {
  buildDetailNavRows,
  buildEpisodePlayTarget,
  buildPrimaryPlayAction,
  type DetailNavRowId,
} from './detail-model';
import {
  isValidTrailerStreamUrl,
  isValidYoutubeId,
  resolveTrailerPlaybackStrategy,
} from './detail-trailer-utils';
import { useDetailData } from './useDetailData';
import { useDetailDownloadActions } from './useDetailDownloadActions';
import { useDetailExtrasState } from './useDetailExtrasState';
import { useEpisodeChunks } from './useEpisodeChunks';
import { useTvDetailNavigation } from './useTvDetailNavigation';

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
 * Preserves exact vertical order: **Hero → Cast → Franchise (when `>= 2` library items) →
 * Season Selector & Episodes → More Like This**, with rich ELV hydration, in-app trailers,
 * clickable actor/director library modal, and Fix Match (`#14`, `#152`, `#512`).
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

  const [selectedVersionKey, setSelectedVersionKey] = useState<string | null>(null);
  const [activePerson, setActivePerson] = useState<PersonLibraryModalPerson | null>(null);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [fixMatchOpen, setFixMatchOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset modal & version state on title change
  useEffect(() => {
    setSelectedVersionKey(null);
    setActivePerson(null);
    setTrailerOpen(false);
    setFixMatchOpen(false);
  }, [target.itemKey]);

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

  const handleSelectVersion = useCallback((key: string) => {
    setSelectedVersionKey(key);
  }, []);

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

  const relatedQuickActions = useCardQuickActionsState({
    catalog,
    refreshToken,
    userStateVersion,
  });
  const elvModeEnabled = elvPreferences?.elvModeEnabled === true;
  const hasTrailer =
    isValidTrailerStreamUrl(data.trailerStreamUrl) || isValidYoutubeId(data.trailerYoutubeId);
  const canFixMatch = elvModeEnabled && catalog.applyElvFixMatch !== undefined;

  const extras = useDetailExtrasState({
    target,
    plot: data.plot,
    cast: data.cast,
    director: data.director,
    hasFixMatch: canFixMatch,
    versions: data.versions,
    ...(activeVersion !== undefined ? { activeVersionKey: activeVersion.key } : {}),
    onSelectVersion: handleSelectVersion,
  });

  const dl = useDetailDownloadActions({
    target,
    activeVersion,
    activeSeriesSourceId,
    title: data.title,
    backdropUri: data.backdropUri,
    onPlay,
  });

  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const scrolledRef = useRef(false);
  const castYRef = useRef<number | null>(null);
  const franchiseYRef = useRef<number | null>(null);
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
    franchiseYRef.current = null;
    onScrollTopChange?.(false);
    scrollViewRef.current?.scrollTo({ y: 0, animated: false });
  }, [onScrollTopChange, target.itemKey]);

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
  const handleOpenFixMatch = useCallback(() => setFixMatchOpen(true), []);
  const handleCloseFixMatch = useCallback(() => setFixMatchOpen(false), []);

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
  const handleToggleWatched = useCallback(() => void data.toggleWatched(), [data.toggleWatched]);
  const handleToggleRating = useCallback(
    (next: RatingValue) => void data.toggleRating(next),
    [data.toggleRating],
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
    (item: ItemRow) => void relatedQuickActions.toggleFavorite(item),
    [relatedQuickActions.toggleFavorite],
  );
  const handleQuickToggleRelatedWatched = useCallback(
    (item: ItemRow, currentWatched: boolean) =>
      void relatedQuickActions.toggleWatched(item, currentWatched),
    [relatedQuickActions.toggleWatched],
  );

  const seasons = data.seasonsState.kind === 'ready' ? data.seasonsState.seasons : [];

  const heroActionSlots = useMemo<
    readonly ('mylist' | 'like' | 'dislike' | 'watched' | 'download' | 'trailer')[]
  >(
    () => [
      'mylist',
      'like',
      'dislike',
      ...(target.kind === 'movie' ? (['watched'] as const) : []),
      ...(dl.showMovieDownload ? (['download'] as const) : []),
      ...(hasTrailer ? (['trailer'] as const) : []),
    ],
    [dl.showMovieDownload, hasTrailer, target.kind],
  );

  const {
    chunks: episodeChunks,
    selectedChunkIndex,
    visibleEpisodes,
    episodeIndexOffset,
    selectChunk: handleSelectChunk,
  } = useEpisodeChunks({
    itemKey: activeSeriesKey,
    selectedSeason: data.selectedSeason,
    episodes: data.episodes,
    episodeProgressByKey: data.episodeProgressByKey,
  });

  const navRows = useMemo(
    () =>
      buildDetailNavRows({
        heroActionCount: heroActionSlots.length,
        heroPlayCount: extras.heroPlaySlots.length,
        castCount: extras.castPeople.length,
        franchiseCount: data.franchiseItems.length,
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
      data.franchiseItems.length,
      data.related.length,
      data.seasonsState.kind,
      episodeChunks.length,
      extras.castPeople.length,
      extras.heroPlaySlots.length,
      heroActionSlots.length,
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
        else if (slot === 'download') dl.handlePressMovieDownload();
        else if (slot === 'trailer') handleOpenTrailer();
        return;
      }
      if (rowId === 'hero-play') {
        const slot = extras.heroPlaySlots[colIndex];
        if (slot === 'play') handlePlayPrimary();
        else if (slot === 'preplay-version') extras.toggleVersionMenu();
        else if (slot === 'synopsis') extras.toggleSynopsis();
        else if (slot === 'fix-match') handleOpenFixMatch();
        return;
      }
      if (rowId === 'cast') {
        const person = extras.castPeople[colIndex];
        if (person) handleSelectPerson(person);
        return;
      }
      if (rowId === 'franchise') {
        const entry = data.franchiseItems[colIndex];
        if (entry && entry.item.key !== target.itemKey) handlePressFranchise(entry.item);
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
      data.franchiseItems,
      data.related,
      data.retrySeasons,
      data.selectSeason,
      data.toggleMyList,
      data.toggleRating,
      data.toggleWatched,
      dl,
      episodeChunks,
      episodeIndexOffset,
      extras,
      handleOpenFixMatch,
      handleOpenTrailer,
      handlePlayPrimary,
      handlePressEpisode,
      handlePressFranchise,
      handlePressRelated,
      handleSelectChunk,
      handleSelectPerson,
      heroActionSlots,
      onBack,
      seasons,
      target.itemKey,
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
      if (rowId === 'franchise' && franchiseYRef.current !== null) {
        const targetY = Math.max(0, franchiseYRef.current - heroTopClearance);
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

  const anyModalOpen = activePerson !== null || trailerOpen || fixMatchOpen;
  const tvNav = useTvDetailNavigation({
    isTv,
    isActiveScope: isActiveScope && !anyModalOpen,
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
  const recordFranchiseY = useCallback((y: number) => {
    franchiseYRef.current = y;
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
      {isTv && isActiveScope && !dl.contextMenu.isOpen && !anyModalOpen ? (
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
          votes={data.votes}
          runtimeMin={data.runtimeMin}
          manualLock={data.manualLock}
          plot={data.plot}
          genres={data.genres}
          isEnriched={data.isEnriched}
          {...(dl.movieDownloadState !== undefined
            ? {
                downloadState: dl.movieDownloadState,
                onPressDownload: dl.handlePressMovieDownload,
              }
            : {})}
          {...(hasTrailer ? { onPressTrailer: handleOpenTrailer } : {})}
          {...(canFixMatch ? { onPressFixMatch: handleOpenFixMatch } : {})}
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
            cast={data.cast}
            {...(data.director !== null ? { director: data.director } : {})}
            padX={padX}
            isTv={isTv}
            focusedIndex={tvNav.focusedRowId === 'cast' ? tvNav.focusedCol : null}
            onSelectPerson={handleSelectPerson}
            {...(onSearchPerson !== undefined ? { onSearchPerson } : {})}
            onLayoutY={recordCastY}
          />
        ) : null}

        {data.franchiseItems.length >= 2 ? (
          <DetailFranchiseStrip
            items={data.franchiseItems}
            currentItemKey={target.itemKey}
            {...(elvPreferences !== undefined ? { elvPreferences } : {})}
            cardWidth={posterRailWidth}
            gap={railGap}
            padX={padX}
            isTv={isTv}
            focusedIndex={tvNav.focusedRowId === 'franchise' ? tvNav.focusedCol : null}
            onPressItem={handlePressFranchise}
            onLayoutY={recordFranchiseY}
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
            downloadsSupported={dl.downloads.supported}
            downloadsByKey={dl.downloads.byItemKey}
            onPressEpisodeDownload={dl.handlePressEpisodeDownload}
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

      <DetailFixMatchModal
        visible={fixMatchOpen}
        itemKey={target.itemKey}
        sourceId={target.sourceId}
        mediaType={target.kind}
        initialQuery={data.rawTitle}
        catalog={catalog}
        onApplied={data.applyFixMatchResult}
        onClose={handleCloseFixMatch}
      />
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
