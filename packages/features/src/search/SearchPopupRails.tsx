import type { ItemRow } from '@elv/data';
import {
  HorizontalRailScroll,
  Icon,
  PosterCard,
  useI18n,
  useTheme,
  WideCard,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SearchPopupFocusPosition, SearchPopupSuggestion } from './search-popup-model';

const RAIL_CARD_GAP = 12;

/** Props of {@link SearchPopupRails}. */
export interface SearchPopupRailsProps {
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly sanitizedQuery: string;
  readonly suggestions: readonly SearchPopupSuggestion[];
  readonly moviesSlice: readonly ItemRow[];
  readonly seriesSlice: readonly ItemRow[];
  readonly liveSlice: readonly ItemRow[];
  readonly isEmptySettled: boolean;
  readonly focusPos: SearchPopupFocusPosition;
  readonly onPickSuggestion: (title: string) => void;
  readonly onPickMovieOrSeries: (item: ItemRow) => void;
  readonly onPickLive: (item: ItemRow) => void;
  readonly onViewAllPress: () => void;
}

/**
 * Renders live title suggestions, the 3 single-row media rails (`Movies -> Series -> Live`,
 * omitting empty rails), quiet empty state, and bare text-only `View all` link inside
 * {@link SearchPopupOverlay}.
 */
export function SearchPopupRails({
  isTv,
  isPortrait,
  sanitizedQuery,
  suggestions,
  moviesSlice,
  seriesSlice,
  liveSlice,
  isEmptySettled,
  focusPos,
  onPickSuggestion,
  onPickMovieOrSeries,
  onPickLive,
  onViewAllPress,
}: SearchPopupRailsProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const posterWidth = isPortrait ? 112 : isTv ? 156 : 132;
  const wideWidth = isPortrait ? 188 : isTv ? 256 : 216;
  const cursor = webCursorPointer();
  const chipTransition = webTransition(theme, 'background-color, border-color');
  const viewAllFocused = isTv && focusPos.rowId === 'viewAll';

  const verticalScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const moviesScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const seriesScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const liveScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const sectionYRef = useRef<Partial<Record<'movies' | 'series' | 'live', number>>>({});

  useEffect(() => {
    if (!isTv) return;
    const animated = !theme.reduceMotion;
    if (focusPos.rowId === 'input' || focusPos.rowId === 'suggestions') {
      verticalScrollRef.current?.scrollTo?.({ y: 0, animated });
      return;
    }
    if (focusPos.rowId === 'viewAll') {
      verticalScrollRef.current?.scrollToEnd?.({ animated });
      return;
    }
    const sectionY = sectionYRef.current[focusPos.rowId];
    if (sectionY !== undefined) {
      verticalScrollRef.current?.scrollTo?.({ y: Math.max(0, sectionY - 8), animated });
    }
    if (focusPos.rowId === 'movies') {
      moviesScrollRef.current?.scrollTo?.({
        x: Math.max(0, focusPos.col * (posterWidth + RAIL_CARD_GAP) - posterWidth),
        animated,
      });
    } else if (focusPos.rowId === 'series') {
      seriesScrollRef.current?.scrollTo?.({
        x: Math.max(0, focusPos.col * (posterWidth + RAIL_CARD_GAP) - posterWidth),
        animated,
      });
    } else if (focusPos.rowId === 'live') {
      liveScrollRef.current?.scrollTo?.({
        x: Math.max(0, focusPos.col * (wideWidth + RAIL_CARD_GAP) - wideWidth),
        animated,
      });
    }
  }, [focusPos.col, focusPos.rowId, isTv, posterWidth, theme.reduceMotion, wideWidth]);

  return (
    <>
      {suggestions.length > 0 ? (
        <View
          testID="search-popup-suggestions"
          accessibilityLabel={i18n.t('search.popup.suggestions')}
          style={styles.suggestionsRow}
        >
          {suggestions.map((item, idx) => {
            const focused = isTv && focusPos.rowId === 'suggestions' && focusPos.col === idx;
            return (
              <Pressable
                key={item.itemKey}
                testID={`search-popup-suggestion-${idx}`}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                focusable={!isTv}
                onPress={() => onPickSuggestion(item.title)}
                style={(state) => {
                  const hovered = Boolean((state as { hovered?: boolean }).hovered);
                  return [
                    styles.suggestionChip,
                    cursor,
                    chipTransition,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: focused
                        ? theme.colors.focusFill
                        : hovered
                          ? theme.colors.subtleHighlight
                          : theme.colors.chipBg,
                      borderColor: focused ? theme.colors.focusRingColor : theme.colors.chipBorder,
                      borderWidth: focused ? theme.focus.ringWidth : 1,
                    },
                  ];
                }}
              >
                <Icon name="search" size={13} color={theme.colors.textMuted} />
                <Text
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
                >
                  {item.title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <ScrollView
        ref={verticalScrollRef}
        testID="search-popup-rails-scroll"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.railsScroll}
        contentContainerStyle={styles.railsContent}
      >
        {moviesSlice.length > 0 ? (
          <View
            testID="search-popup-rail-movies"
            onLayout={(e) => {
              sectionYRef.current.movies = e.nativeEvent.layout.y;
            }}
            style={styles.railSection}
          >
            <Text
              numberOfLines={1}
              style={[
                theme.typography.title,
                styles.railTitle,
                { color: theme.colors.textPrimary },
              ]}
            >
              {i18n.t('nav.movies')}
            </Text>
            <HorizontalRailScroll
              scrollRef={moviesScrollRef}
              testID="search-popup-scroll-movies"
              isTv={isTv}
              contentContainerStyle={styles.railRow}
            >
              {moviesSlice.map((movie, idx) => (
                <PosterCard
                  key={movie.key}
                  testID={`search-popup-movie-${idx}`}
                  title={movie.name}
                  meta={movie.year !== null ? String(movie.year) : undefined}
                  imageUri={movie.logo}
                  width={posterWidth}
                  focusable={!isTv}
                  focused={isTv && focusPos.rowId === 'movies' && focusPos.col === idx}
                  onPress={() => onPickMovieOrSeries(movie)}
                />
              ))}
            </HorizontalRailScroll>
          </View>
        ) : null}

        {seriesSlice.length > 0 ? (
          <View
            testID="search-popup-rail-series"
            onLayout={(e) => {
              sectionYRef.current.series = e.nativeEvent.layout.y;
            }}
            style={styles.railSection}
          >
            <Text
              numberOfLines={1}
              style={[
                theme.typography.title,
                styles.railTitle,
                { color: theme.colors.textPrimary },
              ]}
            >
              {i18n.t('nav.series')}
            </Text>
            <HorizontalRailScroll
              scrollRef={seriesScrollRef}
              testID="search-popup-scroll-series"
              isTv={isTv}
              contentContainerStyle={styles.railRow}
            >
              {seriesSlice.map((series, idx) => (
                <PosterCard
                  key={series.key}
                  testID={`search-popup-series-${idx}`}
                  title={series.name}
                  meta={series.year !== null ? String(series.year) : undefined}
                  imageUri={series.logo}
                  width={posterWidth}
                  focusable={!isTv}
                  focused={isTv && focusPos.rowId === 'series' && focusPos.col === idx}
                  onPress={() => onPickMovieOrSeries(series)}
                />
              ))}
            </HorizontalRailScroll>
          </View>
        ) : null}

        {liveSlice.length > 0 ? (
          <View
            testID="search-popup-rail-live"
            onLayout={(e) => {
              sectionYRef.current.live = e.nativeEvent.layout.y;
            }}
            style={styles.railSection}
          >
            <Text
              numberOfLines={1}
              style={[
                theme.typography.title,
                styles.railTitle,
                { color: theme.colors.textPrimary },
              ]}
            >
              {i18n.t('nav.live')}
            </Text>
            <HorizontalRailScroll
              scrollRef={liveScrollRef}
              testID="search-popup-scroll-live"
              isTv={isTv}
              contentContainerStyle={styles.railRow}
            >
              {liveSlice.map((channel, idx) => (
                <WideCard
                  key={channel.key}
                  testID={`search-popup-live-${idx}`}
                  title={channel.name}
                  imageUri={channel.logo}
                  live
                  logoBackdrop
                  width={wideWidth}
                  focusable={!isTv}
                  focused={isTv && focusPos.rowId === 'live' && focusPos.col === idx}
                  onPress={() => onPickLive(channel)}
                />
              ))}
            </HorizontalRailScroll>
          </View>
        ) : null}

        {isEmptySettled ? (
          <Text
            testID="search-popup-empty"
            style={[theme.typography.body, styles.emptyText, { color: theme.colors.textSecondary }]}
          >
            {i18n.t('search.noResultsTitle', { query: sanitizedQuery })}
          </Text>
        ) : null}
      </ScrollView>

      <View style={styles.footerWrap}>
        <Pressable
          testID="search-popup-view-all"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('search.viewAll')}
          focusable={!isTv}
          onPress={onViewAllPress}
          style={(state) => {
            const hovered = Boolean((state as { hovered?: boolean }).hovered);
            return [styles.viewAllButton, cursor, { opacity: hovered ? 0.8 : 1 }];
          }}
        >
          <Text
            style={[
              theme.typography.body,
              {
                color: viewAllFocused ? theme.colors.accent : theme.colors.textSecondary,
                fontWeight: '600',
                textDecorationLine: viewAllFocused ? 'underline' : 'none',
              },
            ]}
          >
            {i18n.t('search.viewAll')}
          </Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    flexShrink: 0,
    gap: 8,
  },
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: 260,
  },
  railsScroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  railsContent: {
    gap: 16,
    paddingBottom: 4,
  },
  railSection: {
    gap: 8,
  },
  railTitle: {
    fontWeight: '700',
  },
  railRow: {
    gap: 12,
    paddingRight: 12,
  },
  emptyText: {
    textAlign: 'center',
    paddingVertical: 20,
  },
  footerWrap: {
    alignItems: 'center',
    flexShrink: 0,
    paddingTop: 2,
  },
  viewAllButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
});
