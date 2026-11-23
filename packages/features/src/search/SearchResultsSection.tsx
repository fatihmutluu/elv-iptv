import type {
  ItemRow,
  SearchEpisodeHit,
  SearchItemHit,
  SearchProgrammeHit,
  SearchResults,
  SearchScope,
  WatchProgressRow,
} from '@elv/data';
import {
  MicroPill,
  PosterCard,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  WideCard,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { type DetailTarget, detailTargetFromItem, formatVodMeta } from '../shared';
import {
  computeSearchProgressRatio,
  formatSearchProgrammeTime,
  type SearchNavRowId,
  type SearchResultSectionId,
} from './search-model';

const LIVE_SKELETON_SLOTS = [0, 1, 2] as const;
const POSTER_SKELETON_SLOTS = [0, 1, 2, 3, 4] as const;

/** Props of {@link SearchResultsSection}. */
export interface SearchResultsSectionProps {
  readonly results: SearchResults;
  readonly scope: SearchScope;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly searching: boolean;
  readonly hasSearched: boolean;
  readonly padX: number;
  readonly gridGap: number;
  readonly wideCardWidth: number;
  readonly posterCardWidth: number;
  readonly isTv: boolean;
  readonly focusedRowId: SearchNavRowId | null;
  readonly focusedCol: number | null;
  readonly onPlayLive: (item: ItemRow) => void;
  readonly onSelectEpg?: (programme: SearchProgrammeHit) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onSelectEpisode?: (episode: SearchEpisodeHit) => void;
  readonly onContainerLayoutY?: (y: number) => void;
  readonly onSectionLayoutY?: (section: SearchResultSectionId, y: number) => void;
  readonly nowMs?: number;
}

interface SearchLiveCardItemProps {
  readonly item: ItemRow;
  readonly index: number;
  readonly width: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly liveKindLabel: string;
  readonly onPlayLive: (item: ItemRow) => void;
}

const SearchLiveCardItem = memo(function SearchLiveCardItemInner({
  item,
  index,
  width,
  isTv,
  focused,
  liveKindLabel,
  onPlayLive,
}: SearchLiveCardItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onPlayLive(item);
  }, [item, onPlayLive]);

  const subtitle = item.num !== null ? `${item.num} · ${liveKindLabel}` : liveKindLabel;

  return (
    <WideCard
      testID={`search-live-item-${index}`}
      title={item.name}
      subtitle={subtitle}
      imageUri={item.logo}
      live
      logoBackdrop
      width={width}
      maxDecodePx={320}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
    />
  );
});

interface SearchEpgCardItemProps {
  readonly hit: SearchProgrammeHit;
  readonly index: number;
  readonly width: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly nowMs: number;
  readonly airingNowLabel: string;
  readonly upcomingLabel: string;
  readonly onSelectEpg?: (programme: SearchProgrammeHit) => void;
}

const SearchEpgCardItem = memo(function SearchEpgCardItemInner({
  hit,
  index,
  width,
  isTv,
  focused,
  nowMs,
  airingNowLabel,
  upcomingLabel,
  onSelectEpg,
}: SearchEpgCardItemProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => {
    onSelectEpg?.(hit);
  }, [hit, onSelectEpg]);

  const isEnded = !hit.isLiveNow && hit.stop < nowMs;
  const badgeLabel = hit.isLiveNow ? airingNowLabel : isEnded ? null : upcomingLabel;
  const timeWindow = `${formatSearchProgrammeTime(hit.start)} – ${formatSearchProgrammeTime(hit.stop)}`;
  const channelSubtitle = hit.category ? `${hit.channelName} · ${hit.category}` : hit.channelName;

  return (
    <Pressable
      testID={`search-epg-item-${index}`}
      accessibilityRole="button"
      accessibilityLabel={
        badgeLabel !== null
          ? `${hit.title}, ${hit.channelName}, ${badgeLabel}, ${timeWindow}`
          : `${hit.title}, ${hit.channelName}, ${timeWindow}`
      }
      focusable={!isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.epgCard,
        webTransition(theme, 'background-color, border-color, opacity, transform'),
        webCursorPointer(),
        {
          width,
          borderRadius: theme.radius.card,
          backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
          borderColor: focused ? 'transparent' : theme.colors.surfaceBorder,
          borderWidth: 1,
          opacity: pressed ? 0.88 : 1,
          transform: [{ scale: focused ? theme.focus.buttonScale : 1 }],
        },
      ]}
    >
      <View style={styles.epgTopRow}>
        {badgeLabel !== null ? (
          <MicroPill
            testID={`search-epg-item-${index}-badge`}
            label={badgeLabel}
            tone={hit.isLiveNow ? 'live' : 'accent'}
          />
        ) : null}
        <Text
          testID={`search-epg-item-${index}-time`}
          numberOfLines={1}
          style={[
            theme.typography.micro,
            TABULAR_NUMS_STYLE,
            { color: theme.colors.textMuted, flexShrink: 0 },
          ]}
        >
          {timeWindow}
        </Text>
      </View>
      <Text
        testID={`search-epg-item-${index}-title`}
        numberOfLines={1}
        style={[
          theme.typography.title,
          { color: theme.colors.textPrimary, fontWeight: '600', marginTop: 6 },
        ]}
      >
        {hit.title}
      </Text>
      <Text
        testID={`search-epg-item-${index}-channel`}
        numberOfLines={1}
        style={[theme.typography.caption, { color: theme.colors.textSecondary, marginTop: 2 }]}
      >
        {channelSubtitle}
      </Text>
      {focused ? (
        <View
          pointerEvents="none"
          testID={`search-epg-item-${index}-focus-ring`}
          style={[
            styles.cardFocusRing,
            {
              borderRadius: theme.radius.card,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
});

interface SearchVodCardItemProps {
  readonly item: SearchItemHit;
  readonly index: number;
  readonly kindPrefix: 'movie' | 'series';
  readonly progress: WatchProgressRow | undefined;
  readonly watchedLabel: string;
  readonly matchedInCastLabel: string;
  readonly width: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onOpenDetail: (target: DetailTarget) => void;
}

const SearchVodCardItem = memo(function SearchVodCardItemInner({
  item,
  index,
  kindPrefix,
  progress,
  watchedLabel,
  matchedInCastLabel,
  width,
  isTv,
  focused,
  onOpenDetail,
}: SearchVodCardItemProps): ReactElement {
  const handlePress = useCallback(() => {
    const target = detailTargetFromItem(item);
    if (target) onOpenDetail(target);
  }, [item, onOpenDetail]);

  const baseMeta = formatVodMeta(item.year, item.rating);
  const isCastMatch = item.matchedBy === 'cast' || item.matchedBy === 'director';
  const showCastBadge = isCastMatch && !progress?.watched;
  const badge = progress?.watched ? watchedLabel : showCastBadge ? matchedInCastLabel : undefined;
  const meta =
    isCastMatch && !showCastBadge
      ? baseMeta !== undefined
        ? `${baseMeta} · ${matchedInCastLabel}`
        : matchedInCastLabel
      : baseMeta;
  const ratio = computeSearchProgressRatio(progress);

  return (
    <PosterCard
      testID={`search-${kindPrefix}-item-${index}`}
      title={item.name}
      {...(meta !== undefined ? { meta } : {})}
      imageUri={item.logo}
      {...(ratio !== undefined ? { progress: ratio } : {})}
      {...(badge !== undefined ? { badge } : {})}
      width={width}
      maxDecodePx={320}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
    />
  );
});

interface SearchEpisodeCardItemProps {
  readonly hit: SearchEpisodeHit;
  readonly index: number;
  readonly episodeLabel: string;
  readonly width: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelectEpisode?: (episode: SearchEpisodeHit) => void;
}

const SearchEpisodeCardItem = memo(function SearchEpisodeCardItemInner({
  hit,
  index,
  episodeLabel,
  width,
  isTv,
  focused,
  onSelectEpisode,
}: SearchEpisodeCardItemProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => {
    onSelectEpisode?.(hit);
  }, [hit, onSelectEpisode]);

  const displayTitle = hit.title.trim() || episodeLabel;

  return (
    <Pressable
      testID={`search-episode-item-${index}`}
      accessibilityRole="button"
      accessibilityLabel={`${hit.seriesName}, ${episodeLabel}, ${displayTitle}`}
      focusable={!isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.epgCard,
        webTransition(theme, 'background-color, border-color, opacity, transform'),
        webCursorPointer(),
        {
          width,
          borderRadius: theme.radius.card,
          backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
          borderColor: focused ? 'transparent' : theme.colors.surfaceBorder,
          borderWidth: 1,
          opacity: pressed ? 0.88 : 1,
          transform: [{ scale: focused ? theme.focus.buttonScale : 1 }],
        },
      ]}
    >
      <View style={styles.epgTopRow}>
        <Text
          testID={`search-episode-item-${index}-series`}
          numberOfLines={1}
          style={[
            theme.typography.caption,
            { color: theme.colors.textSecondary, flex: 1, fontWeight: '600' },
          ]}
        >
          {hit.seriesName}
        </Text>
        <MicroPill
          testID={`search-episode-item-${index}-label`}
          label={episodeLabel}
          tone="neutral"
        />
      </View>
      <Text
        testID={`search-episode-item-${index}-title`}
        numberOfLines={1}
        style={[
          theme.typography.title,
          { color: theme.colors.textPrimary, fontWeight: '600', marginTop: 6 },
        ]}
      >
        {displayTitle}
      </Text>
      {focused ? (
        <View
          pointerEvents="none"
          testID={`search-episode-item-${index}-focus-ring`}
          style={[
            styles.cardFocusRing,
            {
              borderRadius: theme.radius.card,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
});

interface SectionHeadingProps {
  readonly title: string;
  readonly count: number;
}

const SectionHeading = memo(function SectionHeadingInner({
  title,
  count,
}: SectionHeadingProps): ReactElement {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text
        numberOfLines={1}
        style={[theme.typography.h2, styles.sectionTitle, { color: theme.colors.textPrimary }]}
      >
        {title}
      </Text>
      <Text
        numberOfLines={1}
        style={[theme.typography.caption, TABULAR_NUMS_STYLE, { color: theme.colors.textMuted }]}
      >
        {count}
      </Text>
    </View>
  );
});

function SearchResultsSectionInner({
  results,
  scope,
  progressByKey,
  searching,
  hasSearched,
  padX,
  gridGap,
  wideCardWidth,
  posterCardWidth,
  isTv,
  focusedRowId,
  focusedCol,
  onPlayLive,
  onSelectEpg,
  onOpenDetail,
  onSelectEpisode,
  onContainerLayoutY,
  onSectionLayoutY,
  nowMs,
}: SearchResultsSectionProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();

  const handleContainerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onContainerLayoutY?.(event.nativeEvent.layout.y);
    },
    [onContainerLayoutY],
  );
  const handleLiveLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onSectionLayoutY?.('live', event.nativeEvent.layout.y);
    },
    [onSectionLayoutY],
  );
  const handleEpgLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onSectionLayoutY?.('epg', event.nativeEvent.layout.y);
    },
    [onSectionLayoutY],
  );
  const handleMoviesLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onSectionLayoutY?.('movies', event.nativeEvent.layout.y);
    },
    [onSectionLayoutY],
  );
  const handleSeriesLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onSectionLayoutY?.('series', event.nativeEvent.layout.y);
    },
    [onSectionLayoutY],
  );
  const handleEpisodesLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onSectionLayoutY?.('episodes', event.nativeEvent.layout.y);
    },
    [onSectionLayoutY],
  );

  if (searching && !hasSearched) {
    const wideHeight = Math.round((wideCardWidth * 9) / 16);
    const posterHeight = Math.round(posterCardWidth * 1.5);
    return (
      <View testID="search-skeleton" style={[styles.container, { paddingHorizontal: padX }]}>
        <View style={styles.section}>
          <SkeletonBox width={132} height={20} borderRadius={theme.radius.button} />
          <View style={[styles.grid, { gap: gridGap, marginTop: 12 }]}>
            {LIVE_SKELETON_SLOTS.map((slot) => (
              <View key={slot} style={{ width: wideCardWidth }}>
                <SkeletonBox
                  width={wideCardWidth}
                  height={wideHeight}
                  borderRadius={theme.radius.card}
                />
                <SkeletonBox
                  width="70%"
                  height={12}
                  borderRadius={theme.radius.button}
                  style={styles.skeletonLabel}
                />
              </View>
            ))}
          </View>
        </View>
        <View style={styles.section}>
          <SkeletonBox width={104} height={20} borderRadius={theme.radius.button} />
          <View style={[styles.grid, { gap: gridGap, marginTop: 12 }]}>
            {POSTER_SKELETON_SLOTS.map((slot) => (
              <View key={slot} style={{ width: posterCardWidth }}>
                <SkeletonBox
                  width={posterCardWidth}
                  height={posterHeight}
                  borderRadius={theme.radius.card}
                />
                <SkeletonBox
                  width="76%"
                  height={12}
                  borderRadius={theme.radius.button}
                  style={styles.skeletonLabel}
                />
              </View>
            ))}
          </View>
        </View>
      </View>
    );
  }

  const epgResults = results.epg ?? [];
  const episodeResults = results.episodes ?? [];
  const showLive = (scope === 'all' || scope === 'live') && results.live.length > 0;
  const showEpg = (scope === 'all' || scope === 'epg') && epgResults.length > 0;
  const showMovies = (scope === 'all' || scope === 'movie') && results.movies.length > 0;
  const showSeries = (scope === 'all' || scope === 'series') && results.series.length > 0;
  const showEpisodes = (scope === 'all' || scope === 'episode') && episodeResults.length > 0;

  if (!showLive && !showEpg && !showMovies && !showSeries && !showEpisodes) return null;

  const liveKindLabel = i18n.t('home.kind.live');
  const watchedLabel = i18n.t('home.watchedBadge');
  const matchedInCastLabel = i18n.t('search.matchedInCast');
  const airingNowLabel = i18n.t('search.airingNow');
  const upcomingLabel = i18n.t('search.upcoming');
  const effectiveNowMs = nowMs ?? Date.now();
  const gridPadY = isTv ? 10 : 4;

  return (
    <View
      testID="search-results-container"
      onLayout={onContainerLayoutY ? handleContainerLayout : undefined}
      style={[styles.container, { paddingHorizontal: padX }]}
    >
      {showLive ? (
        <View
          testID="search-section-live"
          onLayout={onSectionLayoutY ? handleLiveLayout : undefined}
          style={styles.section}
        >
          <SectionHeading title={i18n.t('search.section.live')} count={results.live.length} />
          <View style={[styles.grid, { gap: gridGap, paddingVertical: gridPadY }]}>
            {results.live.map((item, index) => (
              <SearchLiveCardItem
                key={item.key}
                item={item}
                index={index}
                width={wideCardWidth}
                isTv={isTv}
                focused={isTv && focusedRowId === 'live' && focusedCol === index}
                liveKindLabel={liveKindLabel}
                onPlayLive={onPlayLive}
              />
            ))}
          </View>
        </View>
      ) : null}

      {showEpg ? (
        <View
          testID="search-section-epg"
          onLayout={onSectionLayoutY ? handleEpgLayout : undefined}
          style={styles.section}
        >
          <SectionHeading title={i18n.t('search.sectionEpg')} count={epgResults.length} />
          <View style={[styles.grid, { gap: gridGap, paddingVertical: gridPadY }]}>
            {epgResults.map((hit, index) => (
              <SearchEpgCardItem
                key={`${hit.sourceId}:${hit.channelKey}:${hit.guideId}:${hit.start}`}
                hit={hit}
                index={index}
                width={wideCardWidth}
                isTv={isTv}
                focused={isTv && focusedRowId === 'epg' && focusedCol === index}
                nowMs={effectiveNowMs}
                airingNowLabel={airingNowLabel}
                upcomingLabel={upcomingLabel}
                {...(onSelectEpg !== undefined ? { onSelectEpg } : {})}
              />
            ))}
          </View>
        </View>
      ) : null}

      {showMovies ? (
        <View
          testID="search-section-movies"
          onLayout={onSectionLayoutY ? handleMoviesLayout : undefined}
          style={styles.section}
        >
          <SectionHeading title={i18n.t('search.section.movies')} count={results.movies.length} />
          <View style={[styles.grid, { gap: gridGap, paddingVertical: gridPadY }]}>
            {results.movies.map((item, index) => (
              <SearchVodCardItem
                key={item.key}
                item={item}
                index={index}
                kindPrefix="movie"
                progress={progressByKey.get(item.key)}
                watchedLabel={watchedLabel}
                matchedInCastLabel={matchedInCastLabel}
                width={posterCardWidth}
                isTv={isTv}
                focused={isTv && focusedRowId === 'movies' && focusedCol === index}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </View>
        </View>
      ) : null}

      {showSeries ? (
        <View
          testID="search-section-series"
          onLayout={onSectionLayoutY ? handleSeriesLayout : undefined}
          style={styles.section}
        >
          <SectionHeading title={i18n.t('search.section.series')} count={results.series.length} />
          <View style={[styles.grid, { gap: gridGap, paddingVertical: gridPadY }]}>
            {results.series.map((item, index) => (
              <SearchVodCardItem
                key={item.key}
                item={item}
                index={index}
                kindPrefix="series"
                progress={progressByKey.get(item.key)}
                watchedLabel={watchedLabel}
                matchedInCastLabel={matchedInCastLabel}
                width={posterCardWidth}
                isTv={isTv}
                focused={isTv && focusedRowId === 'series' && focusedCol === index}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </View>
        </View>
      ) : null}

      {showEpisodes ? (
        <View
          testID="search-section-episodes"
          onLayout={onSectionLayoutY ? handleEpisodesLayout : undefined}
          style={styles.section}
        >
          <SectionHeading title={i18n.t('search.sectionEpisodes')} count={episodeResults.length} />
          <View style={[styles.grid, { gap: gridGap, paddingVertical: gridPadY }]}>
            {episodeResults.map((hit, index) => (
              <SearchEpisodeCardItem
                key={hit.itemKey}
                hit={hit}
                index={index}
                episodeLabel={i18n.t('search.episodeLabel', {
                  season: hit.season,
                  episode: hit.episode,
                })}
                width={wideCardWidth}
                isTv={isTv}
                focused={isTv && focusedRowId === 'episodes' && focusedCol === index}
                {...(onSelectEpisode !== undefined ? { onSelectEpisode } : {})}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Memoized Cinema Quietude grouped search results view rendering Live `WideCard`s, EPG programme
 * cards, Movie/Series `PosterCard`s (with cast match attribution), and Episode cards (`#397`).
 */
export const SearchResultsSection = memo(SearchResultsSectionInner);
SearchResultsSection.displayName = 'SearchResultsSection';

const styles = StyleSheet.create({
  container: { flexGrow: 1 },
  section: { marginTop: 20 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 8,
  },
  sectionTitle: { flexShrink: 1 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
  epgCard: {
    position: 'relative',
    minHeight: 84,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  epgTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardFocusRing: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    left: -2,
    right: -2,
  },
  skeletonLabel: { marginTop: 8 },
});
