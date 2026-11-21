import type { ItemRow, SearchResults, SearchScope, WatchProgressRow } from '@elv/data';
import {
  PosterCard,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  WideCard,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { type DetailTarget, detailTargetFromItem, formatVodMeta } from '../shared';
import { computeSearchProgressRatio, type SearchNavRowId } from './search-model';

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
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onContainerLayoutY?: (y: number) => void;
  readonly onSectionLayoutY?: (section: 'live' | 'movies' | 'series', y: number) => void;
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

interface SearchVodCardItemProps {
  readonly item: ItemRow;
  readonly index: number;
  readonly kindPrefix: 'movie' | 'series';
  readonly progress: WatchProgressRow | undefined;
  readonly watchedLabel: string;
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
  width,
  isTv,
  focused,
  onOpenDetail,
}: SearchVodCardItemProps): ReactElement {
  const handlePress = useCallback(() => {
    const target = detailTargetFromItem(item);
    if (target) onOpenDetail(target);
  }, [item, onOpenDetail]);

  const meta = formatVodMeta(item.year, item.rating);
  const ratio = computeSearchProgressRatio(progress);
  const badge = progress?.watched ? watchedLabel : undefined;

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
  onOpenDetail,
  onContainerLayoutY,
  onSectionLayoutY,
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

  const showLive = (scope === 'all' || scope === 'live') && results.live.length > 0;
  const showMovies = (scope === 'all' || scope === 'movie') && results.movies.length > 0;
  const showSeries = (scope === 'all' || scope === 'series') && results.series.length > 0;

  if (!showLive && !showMovies && !showSeries) return null;

  const liveKindLabel = i18n.t('home.kind.live');
  const watchedLabel = i18n.t('home.watchedBadge');
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
                width={posterCardWidth}
                isTv={isTv}
                focused={isTv && focusedRowId === 'series' && focusedCol === index}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Memoized Cinema Quietude grouped search results view rendering `16:9` Live `WideCard`s and
 * `2:3` Movie/Series `PosterCard`s with decode-capped artwork, tonal skeletons, and TV focus.
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
  skeletonLabel: { marginTop: 8 },
});
