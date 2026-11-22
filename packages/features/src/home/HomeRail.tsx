import type { BrowseKind, SeriesUnplayedSummary } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import {
  HorizontalRailScroll,
  Icon,
  PosterCard,
  type PosterCardQuickActions,
  TvFocusGuideRegion,
  useI18n,
  useTheme,
  WideCard,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  type ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { resolveSeriesBadgeProps, useRouteActive } from '../shared';
import {
  formatRemainingMinutes,
  type HomeRailEntry,
  type HomeRailKind,
  progressRatio,
} from './home-model';

/** Declarative configuration for one Home rail section. */
export interface HomeRailSpec {
  readonly id: HomeRailKind;
  readonly title: string;
  readonly variant: 'wide' | 'poster';
  readonly actionLabel?: string;
  readonly tab?: BrowseKind;
}

/** Returns the ordered Cinema Quietude Home rail specifications for the active locale. */
export function buildHomeRailSpecs(t: AppI18n['t']): readonly HomeRailSpec[] {
  return [
    { id: 'continue', title: t('home.continueWatching'), variant: 'wide' },
    {
      id: 'live',
      title: t('home.onAirNow'),
      variant: 'wide',
      actionLabel: t('home.channels'),
      tab: 'live',
    },
    { id: 'mylist', title: t('home.myList'), variant: 'poster' },
    {
      id: 'movies',
      title: t('home.featuredMovies'),
      variant: 'poster',
      actionLabel: t('home.seeAll'),
      tab: 'movie',
    },
    {
      id: 'series',
      title: t('home.featuredSeries'),
      variant: 'poster',
      actionLabel: t('home.seeAll'),
      tab: 'series',
    },
  ];
}

/** Props of {@link HomeRail}. */
export interface HomeRailProps {
  readonly id: HomeRailKind;
  readonly title: string;
  readonly actionLabel?: string;
  readonly actionTab?: BrowseKind;
  readonly onPressAction?: (tab: BrowseKind) => void;
  readonly variant: 'wide' | 'poster';
  readonly items: readonly HomeRailEntry[];
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focusedIndex: number | null;
  readonly onPressItem: (entry: HomeRailEntry, index: number) => void;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly onQuickPlay?: (entry: HomeRailEntry, index: number) => void;
  readonly onQuickToggleFavorite?: (entry: HomeRailEntry) => void;
  readonly onQuickToggleWatched?: (entry: HomeRailEntry) => void;
  readonly onLayoutY?: (id: HomeRailKind, y: number) => void;
  readonly testID: string;
  readonly itemTestIdPrefix: string;
}

function buildPosterMeta(entry: HomeRailEntry): string | undefined {
  const parts: string[] = [];
  if (entry.year !== null) parts.push(String(entry.year));
  if (entry.rating !== null) parts.push(`★ ${entry.rating.toFixed(1)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

interface RailCardItemProps {
  readonly variant: 'wide' | 'poster';
  readonly entry: HomeRailEntry;
  readonly index: number;
  readonly cardWidth: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly testID: string;
  readonly liveKindLabel: string;
  readonly watchedLabel: string;
  readonly isFavorite: boolean;
  readonly unplayedSummary: SeriesUnplayedSummary | undefined;
  readonly formatRemMin: (minutes: number) => string;
  readonly formatUnplayed: (count: number) => string;
  readonly formatQuickPlay: (title: string) => string;
  readonly addToListLabel: string;
  readonly inMyListLabel: string;
  readonly markWatchedLabel: string;
  readonly markUnwatchedLabel: string;
  readonly onPressItem: (entry: HomeRailEntry, index: number) => void;
  readonly onQuickPlay?: (entry: HomeRailEntry, index: number) => void;
  readonly onQuickToggleFavorite?: (entry: HomeRailEntry) => void;
  readonly onQuickToggleWatched?: (entry: HomeRailEntry) => void;
}

const RailCardItem = memo(function RailCardItemInner({
  variant,
  entry,
  index,
  cardWidth,
  isTv,
  focused,
  testID,
  liveKindLabel,
  watchedLabel,
  isFavorite,
  unplayedSummary,
  formatRemMin,
  formatUnplayed,
  formatQuickPlay,
  addToListLabel,
  inMyListLabel,
  markWatchedLabel,
  markUnwatchedLabel,
  onPressItem,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
}: RailCardItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onPressItem(entry, index);
  }, [entry, index, onPressItem]);

  const isSeries = entry.kind === 'series';
  const effectiveWatched = entry.watched || (isSeries && unplayedSummary?.watched === true);

  const quickActions = useMemo<PosterCardQuickActions | undefined>(() => {
    if (variant !== 'poster' || (!onQuickPlay && !onQuickToggleFavorite && !onQuickToggleWatched)) {
      return undefined;
    }
    return {
      ...(onQuickPlay !== undefined
        ? {
            onPlay: () => onQuickPlay(entry, index),
            playLabel: formatQuickPlay(entry.title),
          }
        : {}),
      ...(onQuickToggleFavorite !== undefined
        ? {
            isFavorite,
            onToggleFavorite: () => onQuickToggleFavorite(entry),
            favoriteLabel: isFavorite ? inMyListLabel : addToListLabel,
          }
        : {}),
      ...(onQuickToggleWatched !== undefined
        ? {
            isWatched: effectiveWatched,
            onToggleWatched: () => onQuickToggleWatched(entry),
            watchedLabel: effectiveWatched ? markUnwatchedLabel : markWatchedLabel,
          }
        : {}),
    };
  }, [
    addToListLabel,
    effectiveWatched,
    entry,
    formatQuickPlay,
    inMyListLabel,
    index,
    isFavorite,
    markUnwatchedLabel,
    markWatchedLabel,
    onQuickPlay,
    onQuickToggleFavorite,
    onQuickToggleWatched,
    variant,
  ]);

  if (variant === 'wide') {
    const isLive = Boolean(entry.live || entry.kind === 'live');
    const ratio =
      !isLive && entry.durationMs > 0
        ? progressRatio(entry.positionMs, entry.durationMs)
        : undefined;
    const remMin =
      !isLive && entry.durationMs > 0
        ? formatRemainingMinutes(entry.positionMs, entry.durationMs)
        : null;
    const remLabel = remMin !== null ? formatRemMin(remMin) : undefined;
    const subtitle = isLive
      ? (entry.subtitle ?? liveKindLabel)
      : entry.subtitle && remLabel
        ? `${entry.subtitle} · ${remLabel}`
        : (remLabel ?? entry.subtitle ?? undefined);

    return (
      <WideCard
        testID={testID}
        title={entry.title}
        {...(subtitle !== undefined ? { subtitle } : {})}
        imageUri={entry.backdropUri}
        live={isLive}
        logoBackdrop={isLive}
        showPlayBadge={!isLive}
        {...(ratio !== undefined ? { progress: ratio } : {})}
        width={cardWidth}
        maxDecodePx={480}
        focusable={!isTv}
        focused={focused}
        onPress={handlePress}
      />
    );
  }

  const meta = buildPosterMeta(entry);
  const ratio =
    !entry.watched && entry.positionMs > 0 && entry.durationMs > 0
      ? progressRatio(entry.positionMs, entry.durationMs)
      : undefined;
  const seriesBadge = isSeries
    ? resolveSeriesBadgeProps({
        summary: unplayedSummary,
        progressWatched: entry.watched,
        watchedOverride: undefined,
        formatUnplayed,
        watchedLabel,
      })
    : {};
  const badge = !isSeries && entry.watched ? watchedLabel : undefined;

  return (
    <PosterCard
      testID={testID}
      title={entry.title}
      {...(meta !== undefined ? { meta } : {})}
      imageUri={entry.posterUri}
      {...(ratio !== undefined ? { progress: ratio } : {})}
      {...(badge !== undefined ? { badge } : {})}
      {...seriesBadge}
      {...(quickActions !== undefined ? { quickActions } : {})}
      width={cardWidth}
      maxDecodePx={320}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
    />
  );
});

function HomeRailInner({
  id,
  title,
  actionLabel,
  actionTab,
  onPressAction,
  variant,
  items,
  cardWidth,
  gap,
  padX,
  isTv,
  isTouch,
  focusedIndex,
  onPressItem,
  favoriteKeys,
  unplayedBySeriesKey,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onLayoutY,
  testID,
  itemTestIdPrefix,
}: HomeRailProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const routeActive = useRouteActive();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!isTv || focusedIndex === null || focusedIndex < 0) return;
    const x = Math.max(0, focusedIndex * (cardWidth + gap) - padX);
    scrollRef.current?.scrollTo({ x, animated: !theme.reduceMotion });
  }, [cardWidth, focusedIndex, gap, isTv, padX, theme.reduceMotion]);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onLayoutY?.(id, e.nativeEvent.layout.y);
    },
    [id, onLayoutY],
  );

  const handleActionPress = useCallback(() => {
    if (actionTab !== undefined) onPressAction?.(actionTab);
  }, [actionTab, onPressAction]);

  const formatRemMin = useCallback(
    (minutes: number) => i18n.t('home.remainingMin', { minutes }),
    [i18n],
  );
  const formatUnplayed = useCallback(
    (count: number) => i18n.t('card.unplayedCount', { count }),
    [i18n],
  );
  const formatQuickPlay = useCallback(
    (cardTitle: string) => i18n.t('card.quickPlay', { title: cardTitle }),
    [i18n],
  );

  if (items.length === 0) return null;

  const cursor = webCursorPointer();
  const linkTransition = webTransition(theme, 'color, opacity');
  const liveKindLabel = i18n.t('home.kind.live');
  const watchedLabel = i18n.t('home.watchedBadge');
  const addToListLabel = i18n.t('home.addToList');
  const inMyListLabel = i18n.t('home.inMyList');
  const markWatchedLabel = i18n.t('home.markWatched');
  const markUnwatchedLabel = i18n.t('home.markUnwatched');

  return (
    <View testID={testID} onLayout={onLayoutY ? handleLayout : undefined} style={styles.section}>
      <View style={[styles.header, { paddingHorizontal: padX }]}>
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.title, { color: theme.colors.textPrimary }]}
        >
          {title}
        </Text>
        {actionLabel && actionTab !== undefined && onPressAction ? (
          <Pressable
            testID={`${testID}-action`}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            focusable={!isTv}
            onPress={handleActionPress}
            style={({ pressed }) => [
              styles.actionLink,
              isTouch ? styles.touchAction : null,
              cursor,
              linkTransition,
              { opacity: pressed ? 0.72 : 1 },
            ]}
          >
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {actionLabel}
            </Text>
            <Icon name="chevronRight" size={14} color={theme.colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      <TvFocusGuideRegion testID={`${testID}-focus-guide`} enabled={isTv && routeActive} autoFocus>
        <HorizontalRailScroll
          scrollRef={scrollRef}
          testID={`${testID}-strip`}
          isTv={isTv}
          contentContainerStyle={[
            styles.stripContent,
            {
              paddingHorizontal: padX,
              paddingTop: isTv ? 18 : 8,
              paddingBottom: isTv ? 20 : 12,
              gap,
            },
          ]}
        >
          {items.map((entry, index) => (
            <RailCardItem
              key={entry.itemKey}
              variant={variant}
              entry={entry}
              index={index}
              cardWidth={cardWidth}
              isTv={isTv}
              focused={isTv && focusedIndex === index}
              testID={`${itemTestIdPrefix}-${index}`}
              liveKindLabel={liveKindLabel}
              watchedLabel={watchedLabel}
              isFavorite={favoriteKeys?.has(entry.itemKey) ?? false}
              unplayedSummary={unplayedBySeriesKey?.get(entry.itemKey)}
              formatRemMin={formatRemMin}
              formatUnplayed={formatUnplayed}
              formatQuickPlay={formatQuickPlay}
              addToListLabel={addToListLabel}
              inMyListLabel={inMyListLabel}
              markWatchedLabel={markWatchedLabel}
              markUnwatchedLabel={markUnwatchedLabel}
              onPressItem={onPressItem}
              {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
              {...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {})}
              {...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {})}
            />
          ))}
        </HorizontalRailScroll>
      </TvFocusGuideRegion>
    </View>
  );
}

/**
 * Reusable Cinema Quietude horizontal rail (`16:9` `WideCard` or `2:3` `PosterCard`) with
 * memoized cards, decode-capped artwork, optional section shortcut, and TV auto-scroll.
 */
export const HomeRail = memo(HomeRailInner);
HomeRail.displayName = 'HomeRail';

const styles = StyleSheet.create({
  section: { marginTop: 22 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 4,
  },
  title: { flexShrink: 1 },
  actionLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  touchAction: { minHeight: 40, minWidth: 40, justifyContent: 'center' },
  stripContent: { alignItems: 'flex-start' },
});
