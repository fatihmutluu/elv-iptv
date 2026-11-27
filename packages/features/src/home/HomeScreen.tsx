import type { BrowseKind, CatalogService, ItemRow, RatingValue, SourceRow } from '@elv/data';
import { DEFAULT_HOME_LAYOUT, type HomeLayoutSectionPref, normalizeHomeLayout } from '@elv/domain';
import {
  type ContextMenuAnchor,
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
  type DetailTarget,
  hasManagedDownload,
  useCatalogUiCache,
  useDownloads,
  useRouteActive,
} from '../shared';
import { AmbientBackdrop } from '../shared/AmbientBackdrop';
import { buildHeroActionIds, HomeHero, type HomeHeroActionId } from './HomeHero';
import { HOME_HERO_AUTO_ROTATE_MS, useHomeHeroAutoRotate } from './HomeHeroBackdrop';
import {
  buildHomeRailSpecs,
  HomeCollectionsSection,
  HomeRail,
  type HomeRailId,
  type HomeRailSpec,
} from './HomeRail';
import { computeHomeLayout, HomeEmptyState, HomeSkeleton } from './HomeSkeleton';
import { buildHomeCardContextMenuItems } from './home-context-menu';
import {
  buildHeroSlides,
  buildHomeCollectionRails,
  buildHomeDetailTarget,
  buildHomeRailSets,
  buildVodPlayTarget,
  type HomeHeroSlide,
  type HomeRailEntry,
  type HomeRailKind,
  resolveHomeLivePlayTarget,
} from './home-model';
import { useHomeData } from './useHomeData';
import { buildHomeNavRows, type HomeNavRowId, useTvHomeNavigation } from './useTvHomeNavigation';

/** Props of {@link HomeScreen}. */
export interface HomeScreenProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenMultiView?: (target: PlayTarget) => void;
  readonly onOpenPopout?: (target: PlayTarget) => void;
  readonly onOpenTab: (tab: BrowseKind) => void;
  readonly onOpenDetail?: (target: DetailTarget) => void;
  readonly onOpenSeries?: (item: ItemRow) => void;
  readonly onOpenSources: () => void;
  readonly onScrollTopChange?: (scrolled: boolean) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
  /** True while full/mini/multi-view playback is active so background network refreshes pause (`#502`). */
  readonly isPlaybackActive?: boolean;
  /** User-configured Home section visibility and order from `PreferencesSnapshot.homeLayout`. */
  readonly homeLayout?: readonly HomeLayoutSectionPref[];
}

export { HOME_HERO_AUTO_ROTATE_MS };

const SCROLL_FROST_THRESHOLD = 24;
const RAIL_ORDER: readonly HomeRailKind[] = [
  'continue',
  'newEpisodes',
  'live',
  'movies',
  'series',
  'mylist',
];

type TvKeyHandler = Parameters<typeof useKeyInterpreter>[0];

function HomeTvKeyBridge({ onEvent }: { onEvent: TvKeyHandler }): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="home-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/**
 * Flagship Cinema Quietude Home screen (`UI_UX_PHILOSOPHY.md` §1–§4).
 * Renders a zero-CLS tonal skeleton during initial bounded queries, a constructive empty state
 * when no catalog items exist, or a full-bleed Hero spotlight paired with up to 5 horizontal
 * rails (*Continue watching*, *On air now*, *My list*, *Featured movies*, *Featured series*).
 */
export function HomeScreen({
  catalog,
  sources,
  refreshToken,
  userStateVersion = 0,
  onPlay,
  onOpenMultiView,
  onOpenPopout,
  onOpenTab,
  onOpenDetail,
  onOpenSeries,
  onOpenSources,
  onScrollTopChange,
  onFocusTopNav,
  isActiveScope = true,
  isPlaybackActive = false,
  homeLayout,
}: HomeScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const contextMenu = useContextMenu();

  const layout = computeHomeLayout(viewport, theme);
  const { isTv, isTouch, isPortrait, padX, railGap, heroTopClearance } = layout;

  const uiCache = useCatalogUiCache();
  const routeActive = useRouteActive();
  const data = useHomeData({
    catalog,
    sources,
    refreshToken,
    userStateVersion,
    isPlaybackActive,
    routeActive,
  });
  const [heroIndex, setHeroIndexState] = useState(() => uiCache?.getHome()?.heroIndex ?? 0);
  const [heroHovered, setHeroHovered] = useState(false);
  const [heroKeyboardFocused, setHeroKeyboardFocused] = useState(false);
  const setHeroIndex = useCallback(
    (idx: number) => {
      setHeroIndexState(idx);
      uiCache?.setHomeHeroIndex(idx);
    },
    [uiCache],
  );
  const scrolledRef = useRef(false);
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const railYRef = useRef(new Map<HomeNavRowId, number>());

  const heroSlides = useMemo(
    () =>
      buildHeroSlides({
        continueWatching: data.continueWatching,
        movies: data.movies,
        series: data.series,
        progressByKey: data.progressByKey,
      }),
    [data.continueWatching, data.movies, data.series, data.progressByKey],
  );

  useEffect(() => {
    if (heroIndex >= heroSlides.length && heroSlides.length > 0) setHeroIndex(0);
  }, [heroIndex, heroSlides.length, setHeroIndex]);

  const newEpisodeBadgeLabel = i18n.t('home.newEpisodeBadge');
  const railSets = useMemo(
    () =>
      buildHomeRailSets({
        continueWatching: data.continueWatching,
        newEpisodes: data.newEpisodes ?? [],
        newEpisodeBadgeLabel,
        recentChannels: data.recentChannels ?? [],
        liveItems: data.liveItems,
        liveCategoryName: data.liveCategory?.name ?? null,
        nowNextByKey: data.nowNextByKey,
        favorites: data.favorites,
        movies: data.movies,
        series: data.series,
        progressByKey: data.progressByKey,
      }),
    [data, newEpisodeBadgeLabel],
  );

  const effectiveHomeLayout = useMemo(
    () => (homeLayout !== undefined ? normalizeHomeLayout(homeLayout) : DEFAULT_HOME_LAYOUT),
    [homeLayout],
  );
  const visibleSections = useMemo(
    () => effectiveHomeLayout.filter((section) => section.visible),
    [effectiveHomeLayout],
  );
  const visibleSectionOrder = useMemo(
    () => visibleSections.map((section) => section.id),
    [visibleSections],
  );

  const collectionRails = useMemo(
    () => buildHomeCollectionRails(data.collections, data.progressByKey),
    [data.collections, data.progressByKey],
  );
  const collectionRailById = useMemo(
    () => new Map(collectionRails.map((rail) => [rail.id, rail])),
    [collectionRails],
  );

  const activeSlide = heroSlides[Math.min(heroIndex, Math.max(0, heroSlides.length - 1))];
  const heroActionIds = useMemo(
    () => buildHeroActionIds(activeSlide, heroSlides.length, onOpenDetail !== undefined),
    [activeSlide, heroSlides.length, onOpenDetail],
  );

  const hasContent =
    heroSlides.length > 0 ||
    RAIL_ORDER.some((railId) => railSets[railId].length > 0) ||
    collectionRails.length > 0;
  const isLoadingInitial = data.loading && !data.hasLoaded;

  const navRows = useMemo(
    () =>
      buildHomeNavRows({
        isLoading: isLoadingInitial,
        hasContent,
        heroActionCount: heroActionIds.length,
        railOrder: RAIL_ORDER,
        sectionOrder: visibleSectionOrder,
        railCounts: {
          continue: railSets.continue.length,
          newEpisodes: railSets.newEpisodes.length,
          live: railSets.live.length,
          mylist: railSets.mylist.length,
          movies: railSets.movies.length,
          series: railSets.series.length,
        },
        collectionRails: collectionRails.map((r) => ({ id: r.id, count: r.items.length })),
      }),
    [
      collectionRails,
      hasContent,
      heroActionIds.length,
      isLoadingInitial,
      railSets,
      visibleSectionOrder,
    ],
  );

  const openVodOrSeries = useCallback(
    (item: HomeHeroSlide | HomeRailEntry) => {
      if (item.kind === 'series') {
        const detail = buildHomeDetailTarget(item);
        if (detail && onOpenDetail) onOpenDetail(detail);
        else if (item.catalogItem && onOpenSeries) onOpenSeries(item.catalogItem);
        else onOpenTab('series');
        return;
      }
      onPlay(
        buildVodPlayTarget({
          itemKey: item.itemKey,
          sourceId: item.sourceId,
          title: item.title,
          kind: item.kind,
          logo: item.posterUri ?? item.backdropUri,
          subtitle: item.subtitle,
          ...('seriesKey' in item && item.seriesKey !== undefined
            ? { seriesKey: item.seriesKey }
            : {}),
          ...('season' in item && item.season !== undefined ? { season: item.season } : {}),
          ...('episode' in item && item.episode !== undefined ? { episode: item.episode } : {}),
          positionMs: item.positionMs,
          watched: item.watched,
        }),
      );
    },
    [onOpenDetail, onOpenSeries, onOpenTab, onPlay],
  );

  const buildLiveTargetForEntry = useCallback(
    (entry: HomeRailEntry): PlayTarget =>
      resolveHomeLivePlayTarget(catalog, data.liveCategory, data.liveItems, entry),
    [catalog, data.liveCategory, data.liveItems],
  );

  const activateEntry = useCallback(
    (entry: HomeRailEntry, _index?: number) => {
      if (entry.kind === 'live') {
        onPlay(buildLiveTargetForEntry(entry));
        return;
      }
      openVodOrSeries(entry);
    },
    [buildLiveTargetForEntry, onPlay, openVodOrSeries],
  );

  const activatePosterEntry = useCallback(
    (entry: HomeRailEntry, index: number) => {
      const detail = buildHomeDetailTarget(entry);
      if (detail && onOpenDetail) onOpenDetail(detail);
      else activateEntry(entry, index);
    },
    [activateEntry, onOpenDetail],
  );

  const {
    toggleMyList,
    toggleWatched,
    toggleRating,
    removeFromContinueWatching,
    dismissNewEpisode,
    markNewEpisodeWatched,
  } = data;
  const handleRemoveFromContinue = useCallback(
    (entry: HomeRailEntry) => void removeFromContinueWatching(entry.itemKey),
    [removeFromContinueWatching],
  );
  const handleDismissNewEpisode = useCallback(
    (entry: HomeRailEntry) => void dismissNewEpisode(entry.itemKey),
    [dismissNewEpisode],
  );
  const handleMarkNewEpisodeWatched = useCallback(
    (entry: HomeRailEntry) => void markNewEpisodeWatched(entry),
    [markNewEpisodeWatched],
  );
  const handleOpenEntryDetail = useCallback(
    (entry: HomeRailEntry) => {
      const detail = buildHomeDetailTarget(entry);
      if (detail && onOpenDetail) onOpenDetail(detail);
    },
    [onOpenDetail],
  );
  const handleOpenLiveMultiView = useCallback(
    (entry: HomeRailEntry) => {
      onOpenMultiView?.(buildLiveTargetForEntry(entry));
    },
    [buildLiveTargetForEntry, onOpenMultiView],
  );
  const handleOpenLivePopout = useCallback(
    (entry: HomeRailEntry) => {
      onOpenPopout?.(buildLiveTargetForEntry(entry));
    },
    [buildLiveTargetForEntry, onOpenPopout],
  );
  const handleOpenHeroDetails = useCallback(
    (slide: HomeHeroSlide) => {
      const detail = buildHomeDetailTarget(slide);
      if (detail && onOpenDetail) onOpenDetail(detail);
    },
    [onOpenDetail],
  );
  const handleToggleMyList = useCallback(
    (s: HomeHeroSlide) => void toggleMyList({ ...s, logo: s.posterUri ?? s.backdropUri }),
    [toggleMyList],
  );
  const handleToggleWatched = useCallback(
    (s: HomeHeroSlide) =>
      void toggleWatched({ ...s, logo: s.posterUri ?? s.backdropUri }, !s.watched),
    [toggleWatched],
  );
  const handleQuickToggleFavorite = useCallback(
    (entry: HomeRailEntry) =>
      void toggleMyList({
        sourceId: entry.sourceId,
        itemKey: entry.itemKey,
        kind: entry.kind,
        title: entry.title,
        logo: entry.posterUri ?? entry.backdropUri,
        year: entry.year,
        rating: entry.rating,
      }),
    [toggleMyList],
  );
  const handleQuickToggleRating = useCallback(
    (entry: HomeRailEntry, next: RatingValue) =>
      void toggleRating({ ...entry, logo: entry.posterUri ?? entry.backdropUri }, next),
    [toggleRating],
  );
  const handleQuickToggleWatched = useCallback(
    (entry: HomeRailEntry, currentWatched: boolean) =>
      void toggleWatched(
        {
          sourceId: entry.sourceId,
          itemKey: entry.itemKey,
          kind: entry.kind,
          title: entry.title,
          subtitle: entry.subtitle,
          logo: entry.posterUri ?? entry.backdropUri,
          durationMs: entry.durationMs,
        },
        !currentWatched,
      ),
    [toggleWatched],
  );

  const handleTvActivate = useCallback(
    (rowId: HomeNavRowId, colIndex: number) => {
      if (rowId === 'empty') {
        onOpenSources();
        return;
      }
      if (rowId === 'hero' && activeSlide) {
        const action = heroActionIds[colIndex];
        if (action === 'play') openVodOrSeries(activeSlide);
        else if (action === 'details') handleOpenHeroDetails(activeSlide);
        else if (action === 'mylist') handleToggleMyList(activeSlide);
        else if (action === 'watched') handleToggleWatched(activeSlide);
        else if (action?.startsWith('dot-')) {
          const idx = Number(action.slice(4));
          if (Number.isInteger(idx) && idx >= 0 && idx < heroSlides.length) setHeroIndex(idx);
        }
        return;
      }
      if (rowId.startsWith('collection:')) {
        const colRail = collectionRailById.get(rowId as `collection:${string}`);
        const entry = colRail?.items[colIndex];
        if (entry) activatePosterEntry(entry, colIndex);
        return;
      }
      const railId = rowId as HomeRailKind;
      const entry = railSets[railId]?.[colIndex];
      if (!entry) return;
      if (railId === 'mylist' || railId === 'movies' || railId === 'series') {
        activatePosterEntry(entry, colIndex);
      } else {
        activateEntry(entry, colIndex);
      }
    },
    [
      activateEntry,
      activatePosterEntry,
      activeSlide,
      collectionRailById,
      handleOpenHeroDetails,
      handleToggleMyList,
      handleToggleWatched,
      heroActionIds,
      heroSlides.length,
      onOpenSources,
      openVodOrSeries,
      railSets,
      setHeroIndex,
    ],
  );

  const reportScrolled = useCallback(
    (next: boolean) => {
      if (next !== scrolledRef.current) {
        scrolledRef.current = next;
        onScrollTopChange?.(next);
      }
    },
    [onScrollTopChange],
  );

  const handleFocusRow = useCallback(
    (rowId: HomeNavRowId) => {
      if (rowId === 'hero' || rowId === 'empty') {
        scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
        reportScrolled(false);
        return;
      }
      const railY = railYRef.current.get(rowId);
      if (railY !== undefined) {
        const targetY = Math.max(0, railY - heroTopClearance);
        scrollViewRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
        reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
      }
    },
    [heroTopClearance, reportScrolled, theme.reduceMotion],
  );

  const tvNav = useTvHomeNavigation({
    isTv,
    isActiveScope,
    rows: navRows,
    onActivate: handleTvActivate,
    onFocusRow: handleFocusRow,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) =>
      reportScrolled(e.nativeEvent.contentOffset.y > SCROLL_FROST_THRESHOLD),
    [reportScrolled],
  );
  const focusedHeroAction: HomeHeroActionId | null =
    tvNav.focusedRowId === 'hero' && tvNav.focusedCol !== null
      ? (heroActionIds[tvNav.focusedCol] ?? null)
      : null;
  const advanceHeroSlide = useCallback(() => {
    setHeroIndexState((prev) => {
      const next = (prev + 1) % Math.max(1, heroSlides.length);
      uiCache?.setHomeHeroIndex(next);
      return next;
    });
  }, [heroSlides.length, uiCache]);

  useHomeHeroAutoRotate({
    slideCount: heroSlides.length,
    reduceMotion: theme.reduceMotion,
    routeActive,
    hovered: heroHovered,
    tvFocused: heroKeyboardFocused || (isTv && isActiveScope && tvNav.focusedRowId === 'hero'),
    onAdvance: advanceHeroSlide,
  });

  useEffect(() => {
    scrolledRef.current = false;
    onScrollTopChange?.(false);
  }, [onScrollTopChange]);

  const recordRailY = useCallback((id: HomeRailId, y: number) => {
    railYRef.current.set(id, y);
  }, []);
  const railSpecsById = useMemo(() => {
    const map = new Map<HomeRailKind, HomeRailSpec>();
    for (const spec of buildHomeRailSpecs(i18n.t)) map.set(spec.id, spec);
    return map;
  }, [i18n]);
  const downloads = useDownloads();
  const openRailContextMenu = useCallback(
    (railId: HomeRailId, entry: HomeRailEntry, index: number, anchor?: ContextMenuAnchor) => {
      const isFavorite = data.favoriteKeys.has(entry.itemKey);
      const isWatched =
        data.watchedOverrides.get(entry.itemKey) ??
        (entry.watched ||
          (entry.kind === 'series' &&
            data.unplayedBySeriesKey.get(entry.itemKey)?.watched === true));
      const canDownloadMovie = downloads.supported && entry.kind === 'movie';
      const isDownloaded =
        canDownloadMovie && hasManagedDownload(downloads.byItemKey.get(entry.itemKey));
      const items = buildHomeCardContextMenuItems({
        railId,
        entry,
        index,
        isFavorite,
        isWatched,
        currentRating: data.ratingByKey.get(entry.itemKey) ?? null,
        isDownloaded,
        t: i18n.t,
        onPlay: activateEntry,
        ...(onOpenDetail !== undefined ? { onOpenDetail: handleOpenEntryDetail } : {}),
        onRemoveFromContinue: handleRemoveFromContinue,
        onDismissNewEpisode: handleDismissNewEpisode,
        onMarkNewEpisodeWatched: handleMarkNewEpisodeWatched,
        onToggleFavorite: handleQuickToggleFavorite,
        onToggleWatched: handleQuickToggleWatched,
        onToggleRating: handleQuickToggleRating,
        ...(onOpenMultiView !== undefined ? { onOpenMultiView: handleOpenLiveMultiView } : {}),
        ...(onOpenPopout !== undefined ? { onOpenPopout: handleOpenLivePopout } : {}),
        ...(canDownloadMovie
          ? {
              onDownload: (e: HomeRailEntry) => {
                void downloads.enqueue({
                  sourceId: e.sourceId,
                  itemKey: e.itemKey,
                  kind: 'movie',
                  title: e.title,
                  poster: e.posterUri ?? e.backdropUri ?? null,
                });
              },
              onDeleteDownload: (e: HomeRailEntry) => {
                void downloads.remove(e.itemKey);
              },
            }
          : {}),
      });
      if (items.length === 0) return;
      contextMenu.openContextMenu({
        title: entry.title,
        ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
        ...(anchor !== undefined ? { anchor } : {}),
        items,
      });
    },
    [
      activateEntry,
      contextMenu,
      data.favoriteKeys,
      data.ratingByKey,
      data.unplayedBySeriesKey,
      data.watchedOverrides,
      downloads,
      handleOpenEntryDetail,
      handleDismissNewEpisode,
      handleMarkNewEpisodeWatched,
      handleOpenLiveMultiView,
      handleOpenLivePopout,
      handleQuickToggleFavorite,
      handleQuickToggleRating,
      handleQuickToggleWatched,
      handleRemoveFromContinue,
      i18n.t,
      onOpenDetail,
      onOpenMultiView,
      onOpenPopout,
    ],
  );
  const focusedAmbientEntry = useMemo(() => {
    if (
      !isTv ||
      tvNav.focusedRowId === null ||
      tvNav.focusedRowId === 'hero' ||
      tvNav.focusedRowId === 'empty' ||
      tvNav.focusedCol === null
    ) {
      return null;
    }
    if (tvNav.focusedRowId.startsWith('collection:')) {
      return (
        collectionRailById.get(tvNav.focusedRowId as `collection:${string}`)?.items[
          tvNav.focusedCol
        ] ?? null
      );
    }
    return railSets[tvNav.focusedRowId as HomeRailKind]?.[tvNav.focusedCol] ?? null;
  }, [collectionRailById, isTv, railSets, tvNav.focusedCol, tvNav.focusedRowId]);

  return (
    <View testID="home-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv ? (
        <AmbientBackdrop
          testID="home-ambient-backdrop"
          backdropKey={focusedAmbientEntry?.itemKey ?? null}
          uri={focusedAmbientEntry?.backdropUri ?? focusedAmbientEntry?.posterUri ?? null}
          title={focusedAmbientEntry?.title ?? ''}
        />
      ) : null}
      {isTv && isActiveScope && !contextMenu.isOpen ? (
        <HomeTvKeyBridge onEvent={tvNav.handleTvKey} />
      ) : null}

      {isLoadingInitial ? (
        <HomeSkeleton
          heroHeight={layout.heroHeight}
          padX={padX}
          wideCardWidth={layout.wideCardWidth}
          posterCardWidth={layout.posterCardWidth}
          gap={railGap}
        />
      ) : !hasContent ? (
        <HomeEmptyState
          topClearance={heroTopClearance}
          padX={padX}
          isTv={isTv}
          focused={tvNav.focusedRowId === 'empty'}
          onOpenSources={onOpenSources}
        />
      ) : (
        <ScrollView
          ref={scrollViewRef}
          testID="home-scroll"
          onScroll={handleScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: heroSlides.length === 0 ? heroTopClearance : 0,
            paddingBottom: theme.spacing.xl + viewport.safeArea.bottom + (!isPortrait ? 8 : 20),
          }}
        >
          <HomeHero
            slides={heroSlides}
            activeIndex={heroIndex}
            onSelectIndex={setHeroIndex}
            inMyList={activeSlide !== undefined && data.favoriteKeys.has(activeSlide.itemKey)}
            onPlaySlide={openVodOrSeries}
            {...(onOpenDetail !== undefined ? { onOpenDetails: handleOpenHeroDetails } : {})}
            onToggleMyList={handleToggleMyList}
            onToggleWatched={handleToggleWatched}
            onHoverChange={setHeroHovered}
            onFocusChange={setHeroKeyboardFocused}
            isTv={isTv}
            isTouch={isTouch}
            isPortrait={isPortrait}
            topClearance={heroTopClearance}
            minHeight={layout.heroHeight}
            padX={padX}
            focusedAction={focusedHeroAction}
          />
          {visibleSections.map((section) => {
            if (section.id === 'collections') {
              return (
                <HomeCollectionsSection
                  key="collections"
                  collectionRails={collectionRails}
                  cardWidth={layout.posterCardWidth}
                  gap={railGap}
                  padX={padX}
                  isTv={isTv}
                  isTouch={isTouch}
                  focusedRowId={tvNav.focusedRowId}
                  focusedCol={tvNav.focusedCol}
                  favoriteKeys={data.favoriteKeys}
                  watchedOverrides={data.watchedOverrides}
                  unplayedBySeriesKey={data.unplayedBySeriesKey}
                  onPressItem={activatePosterEntry}
                  onContextMenuItem={openRailContextMenu}
                  onQuickPlay={activateEntry}
                  onQuickToggleFavorite={handleQuickToggleFavorite}
                  onQuickToggleWatched={handleQuickToggleWatched}
                  onLayoutY={recordRailY}
                />
              );
            }
            const spec = railSpecsById.get(section.id);
            if (!spec) return null;
            return (
              <HomeRail
                key={spec.id}
                id={spec.id}
                testID={`home-rail-${spec.id}`}
                itemTestIdPrefix={`home-${spec.id}-item`}
                title={spec.title}
                {...(spec.actionLabel !== undefined ? { actionLabel: spec.actionLabel } : {})}
                {...(spec.tab !== undefined
                  ? { actionTab: spec.tab, onPressAction: onOpenTab }
                  : {})}
                variant={spec.variant}
                items={railSets[spec.id]}
                cardWidth={spec.variant === 'wide' ? layout.wideCardWidth : layout.posterCardWidth}
                gap={railGap}
                padX={padX}
                isTv={isTv}
                isTouch={isTouch}
                focusedIndex={tvNav.focusedRowId === spec.id ? tvNav.focusedCol : null}
                onPressItem={spec.variant === 'poster' ? activatePosterEntry : activateEntry}
                onContextMenuItem={(entry, index, anchor) =>
                  openRailContextMenu(spec.id, entry, index, anchor)
                }
                {...(spec.variant === 'poster'
                  ? {
                      favoriteKeys: data.favoriteKeys,
                      watchedOverrides: data.watchedOverrides,
                      unplayedBySeriesKey: data.unplayedBySeriesKey,
                      onQuickPlay: activateEntry,
                      onQuickToggleFavorite: handleQuickToggleFavorite,
                      onQuickToggleWatched: handleQuickToggleWatched,
                    }
                  : {})}
                onLayoutY={recordRailY}
              />
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
