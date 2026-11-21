import type { CatalogService, EpisodeRow, ItemRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { TvFocusAnchor, useI18n, useKeyInterpreter, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { computeCatalogLayout, type DetailTarget, detailTargetFromItem } from '../shared';
import { DetailCastStrip } from './DetailCastStrip';
import { DetailEpisodes } from './DetailEpisodes';
import { DetailHero, type DetailHeroFocusSlot } from './DetailHero';
import { DetailRelatedRail } from './DetailRelatedRail';
import {
  buildDetailNavRows,
  buildEpisodePlayTarget,
  buildPrimaryPlayAction,
  type DetailNavRowId,
} from './detail-model';
import { useDetailData } from './useDetailData';
import { useTvDetailNavigation } from './useTvDetailNavigation';

/** Props of {@link DetailScreen}. */
export interface DetailScreenProps {
  readonly target: DetailTarget;
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly onBack: () => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onScrollTopChange?: (scrolled: boolean) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
}

const SCROLL_FROST_THRESHOLD = 24;
const EPISODE_ROW_ESTIMATE_HEIGHT = 112;

function DetailTvKeyBridge({ onEvent }: { onEvent: (event: KeyEvent) => void }): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="detail-tv-focus-anchor" />;
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
  onBack,
  onPlay,
  onOpenDetail,
  onScrollTopChange,
  onFocusTopNav,
  isActiveScope = true,
}: DetailScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();

  const { isTv, isPortrait, padX, railGap, heroTopClearance, posterRailWidth } =
    computeCatalogLayout(viewport, theme);

  const data = useDetailData({ target, catalog, refreshToken, userStateVersion });
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const scrolledRef = useRef(false);
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
    onPlay(primaryAction.target);
  }, [onPlay, primaryAction]);

  const handleToggleMyList = useCallback(() => {
    void data.toggleMyList();
  }, [data.toggleMyList]);

  const handleToggleWatched = useCallback(() => {
    void data.toggleWatched();
  }, [data.toggleWatched]);

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

  const seasons = data.seasonsState.kind === 'ready' ? data.seasonsState.seasons : [];
  const heroActionCount = target.kind === 'movie' ? 2 : 1;

  const navRows = useMemo(
    () =>
      buildDetailNavRows({
        heroActionCount,
        seasonsCount: target.kind === 'series' ? seasons.length : 0,
        episodesCount: target.kind === 'series' && !data.episodesLoading ? data.episodes.length : 0,
        hasSeasonsError: target.kind === 'series' && data.seasonsState.kind === 'error',
        relatedCount: data.related.length,
      }),
    [
      data.episodes.length,
      data.episodesLoading,
      data.related.length,
      data.seasonsState.kind,
      heroActionCount,
      seasons.length,
      target.kind,
    ],
  );

  const handleTvActivate = useCallback(
    (rowId: DetailNavRowId, colIndex: number) => {
      if (rowId === 'back') return onBack();
      if (rowId === 'hero-actions') {
        if (colIndex === 0) void data.toggleMyList();
        else if (colIndex === 1 && target.kind === 'movie') void data.toggleWatched();
        return;
      }
      if (rowId === 'hero-play') return handlePlayPrimary();
      if (rowId === 'seasons') {
        const picked = seasons[colIndex];
        if (picked) data.selectSeason(picked.season);
        return;
      }
      if (rowId === 'retry') return data.retrySeasons();
      if (rowId === 'episodes') {
        const ep = data.episodes[colIndex];
        if (ep) handlePressEpisode(ep, colIndex);
        return;
      }
      if (rowId === 'related') {
        const item = data.related[colIndex];
        if (item) handlePressRelated(item);
      }
    },
    [
      data.episodes,
      data.related,
      data.retrySeasons,
      data.selectSeason,
      data.toggleMyList,
      data.toggleWatched,
      handlePlayPrimary,
      handlePressEpisode,
      handlePressRelated,
      onBack,
      seasons,
      target.kind,
    ],
  );

  const handleTvFocusRow = useCallback(
    (rowId: DetailNavRowId, colIndex: number) => {
      if (rowId === 'back' || rowId === 'hero-actions' || rowId === 'hero-play') {
        scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
        reportScrolled(false);
        return;
      }
      if (rowId === 'seasons' || rowId === 'retry' || rowId === 'episodes') {
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

  const recordEpisodesY = useCallback((y: number) => {
    episodesYRef.current = y;
  }, []);

  const recordRelatedY = useCallback((y: number) => {
    relatedYRef.current = y;
  }, []);

  const focusedHeroSlot: DetailHeroFocusSlot | null =
    tvNav.focusedRowId === 'back'
      ? 'back'
      : tvNav.focusedRowId === 'hero-play'
        ? 'play'
        : tvNav.focusedRowId === 'hero-actions'
          ? tvNav.focusedCol === 1 && target.kind === 'movie'
            ? 'watched'
            : 'mylist'
          : null;

  return (
    <View testID="detail-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && isActiveScope ? <DetailTvKeyBridge onEvent={tvNav.handleTvKey} /> : null}

      <ScrollView
        ref={scrollViewRef}
        testID="detail-scroll"
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
          {...(target.genres !== undefined ? { genres: target.genres } : {})}
          seasonsCount={seasons.length}
          inMyList={data.inMyList}
          watched={data.movieProgress?.watched === true}
          primaryAction={primaryAction}
          onBack={onBack}
          onPlayPrimary={handlePlayPrimary}
          onToggleMyList={handleToggleMyList}
          onToggleWatched={handleToggleWatched}
          isTv={isTv}
          isPortrait={isPortrait}
          topClearance={heroTopClearance}
          padX={padX}
          focusedSlot={focusedHeroSlot}
        />

        {target.cast && target.cast.length > 0 ? (
          <DetailCastStrip cast={target.cast} padX={padX} />
        ) : null}

        {target.kind === 'series' ? (
          <DetailEpisodes
            seasonsState={data.seasonsState}
            selectedSeason={data.selectedSeason}
            episodes={data.episodes}
            episodesLoading={data.episodesLoading}
            episodeProgressByKey={data.episodeProgressByKey}
            seriesBackdropUri={data.backdropUri}
            onSelectSeason={data.selectSeason}
            onRetrySeasons={data.retrySeasons}
            onPressEpisode={handlePressEpisode}
            isTv={isTv}
            isPortrait={isPortrait}
            padX={padX}
            focusedSeasonIndex={tvNav.focusedRowId === 'seasons' ? tvNav.focusedCol : null}
            focusedEpisodeIndex={tvNav.focusedRowId === 'episodes' ? tvNav.focusedCol : null}
            focusedRetry={tvNav.focusedRowId === 'retry'}
            onLayoutY={recordEpisodesY}
          />
        ) : null}

        <DetailRelatedRail
          items={data.related}
          progressByKey={data.relatedProgressByKey}
          cardWidth={posterRailWidth}
          gap={railGap}
          padX={padX}
          isTv={isTv}
          focusedIndex={tvNav.focusedRowId === 'related' ? tvNav.focusedCol : null}
          onPressItem={handlePressRelated}
          onLayoutY={recordRelatedY}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
