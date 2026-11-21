import type { BrowseKind, CatalogService, ItemRow, SourceRow } from '@elv/data';
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
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import type { DetailTarget } from '../shared';
import { buildHeroActionIds, HomeHero, type HomeHeroActionId } from './HomeHero';
import { buildHomeRailSpecs, HomeRail } from './HomeRail';
import { computeHomeLayout, HomeEmptyState, HomeSkeleton } from './HomeSkeleton';
import {
  buildHeroSlides,
  buildHomeDetailTarget,
  buildHomeLivePlayTarget,
  buildHomeRailSets,
  buildVodPlayTarget,
  type HomeHeroSlide,
  type HomeRailEntry,
  type HomeRailKind,
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
  readonly onOpenTab: (tab: BrowseKind) => void;
  readonly onOpenDetail?: (target: DetailTarget) => void;
  readonly onOpenSeries?: (item: ItemRow) => void;
  readonly onOpenSources: () => void;
  readonly onScrollTopChange?: (scrolled: boolean) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
}

const SCROLL_FROST_THRESHOLD = 24;
const RAIL_ORDER: readonly HomeRailKind[] = ['continue', 'live', 'mylist', 'movies', 'series'];

function HomeTvKeyBridge({ onEvent }: { onEvent: (event: KeyEvent) => void }): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="home-tv-focus-anchor" />;
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
  onOpenTab,
  onOpenDetail,
  onOpenSeries,
  onOpenSources,
  onScrollTopChange,
  onFocusTopNav,
  isActiveScope = true,
}: HomeScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();

  const layout = computeHomeLayout(viewport, theme);
  const { isTv, isTouch, isPortrait, padX, railGap, heroTopClearance } = layout;

  const data = useHomeData({ catalog, sources, refreshToken, userStateVersion });
  const [heroIndex, setHeroIndex] = useState(0);
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
  }, [heroIndex, heroSlides.length]);

  const railSets = useMemo(
    () =>
      buildHomeRailSets({
        continueWatching: data.continueWatching,
        liveItems: data.liveItems,
        liveCategoryName: data.liveCategory?.name ?? null,
        favorites: data.favorites,
        movies: data.movies,
        series: data.series,
        progressByKey: data.progressByKey,
      }),
    [
      data.continueWatching,
      data.favorites,
      data.liveCategory?.name,
      data.liveItems,
      data.movies,
      data.progressByKey,
      data.series,
    ],
  );

  const activeSlide = heroSlides[Math.min(heroIndex, Math.max(0, heroSlides.length - 1))];
  const heroActionIds = useMemo(
    () => buildHeroActionIds(activeSlide, heroSlides.length),
    [activeSlide, heroSlides.length],
  );

  const hasContent =
    heroSlides.length > 0 || RAIL_ORDER.some((railId) => railSets[railId].length > 0);
  const isLoadingInitial = data.loading && !data.hasLoaded;

  const navRows = useMemo(
    () =>
      buildHomeNavRows({
        isLoading: isLoadingInitial,
        hasContent,
        heroActionCount: heroActionIds.length,
        railOrder: RAIL_ORDER,
        railCounts: {
          continue: railSets.continue.length,
          live: railSets.live.length,
          mylist: railSets.mylist.length,
          movies: railSets.movies.length,
          series: railSets.series.length,
        },
      }),
    [hasContent, heroActionIds.length, isLoadingInitial, railSets],
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
          positionMs: item.positionMs,
          watched: item.watched,
        }),
      );
    },
    [onOpenDetail, onOpenSeries, onOpenTab, onPlay],
  );

  const activateEntry = useCallback(
    (entry: HomeRailEntry, index: number) => {
      if (entry.kind === 'live') {
        onPlay(
          data.liveCategory && entry.catalogItem
            ? buildHomeLivePlayTarget(catalog, data.liveCategory, entry.catalogItem, index)
            : {
                itemKey: entry.itemKey,
                sourceId: entry.sourceId,
                title: entry.title,
                kind: 'live',
              },
        );
        return;
      }
      openVodOrSeries(entry);
    },
    [catalog, data.liveCategory, onPlay, openVodOrSeries],
  );

  const activatePosterEntry = useCallback(
    (entry: HomeRailEntry, index: number) => {
      const detail = buildHomeDetailTarget(entry);
      if (detail && onOpenDetail) onOpenDetail(detail);
      else activateEntry(entry, index);
    },
    [activateEntry, onOpenDetail],
  );

  const { toggleMyList, toggleWatched } = data;
  const handleToggleMyList = useCallback(
    (slide: HomeHeroSlide) =>
      void toggleMyList({ ...slide, logo: slide.posterUri ?? slide.backdropUri }),
    [toggleMyList],
  );
  const handleToggleWatched = useCallback(
    (slide: HomeHeroSlide) =>
      void toggleWatched({ ...slide, logo: slide.posterUri ?? slide.backdropUri }, !slide.watched),
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
        else if (action === 'mylist') handleToggleMyList(activeSlide);
        else if (action === 'watched') handleToggleWatched(activeSlide);
        else if (action?.startsWith('dot-')) {
          const idx = Number(action.slice(4));
          if (Number.isInteger(idx) && idx >= 0 && idx < heroSlides.length) setHeroIndex(idx);
        }
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
      handleToggleMyList,
      handleToggleWatched,
      heroActionIds,
      heroSlides.length,
      onOpenSources,
      openVodOrSeries,
      railSets,
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

  useEffect(() => {
    scrolledRef.current = false;
    onScrollTopChange?.(false);
  }, [onScrollTopChange]);

  const recordRailY = useCallback((id: HomeRailKind, y: number) => {
    railYRef.current.set(id, y);
  }, []);
  const railSpecs = useMemo(() => buildHomeRailSpecs(i18n.t), [i18n]);

  return (
    <View testID="home-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && isActiveScope ? <HomeTvKeyBridge onEvent={tvNav.handleTvKey} /> : null}

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
            onToggleMyList={handleToggleMyList}
            onToggleWatched={handleToggleWatched}
            isTv={isTv}
            isTouch={isTouch}
            isPortrait={isPortrait}
            topClearance={heroTopClearance}
            minHeight={layout.heroHeight}
            padX={padX}
            focusedAction={focusedHeroAction}
          />
          {railSpecs.map((spec) => (
            <HomeRail
              key={spec.id}
              id={spec.id}
              testID={`home-rail-${spec.id}`}
              itemTestIdPrefix={`home-${spec.id}-item`}
              title={spec.title}
              {...(spec.actionLabel !== undefined ? { actionLabel: spec.actionLabel } : {})}
              {...(spec.tab !== undefined ? { actionTab: spec.tab, onPressAction: onOpenTab } : {})}
              variant={spec.variant}
              items={railSets[spec.id]}
              cardWidth={spec.variant === 'wide' ? layout.wideCardWidth : layout.posterCardWidth}
              gap={railGap}
              padX={padX}
              isTv={isTv}
              isTouch={isTouch}
              focusedIndex={tvNav.focusedRowId === spec.id ? tvNav.focusedCol : null}
              onPressItem={spec.variant === 'poster' ? activatePosterEntry : activateEntry}
              onLayoutY={recordRailY}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
