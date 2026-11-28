import type { BrowseKind, RatingValue, SeriesUnplayedSummary } from '@elv/data';
import type { HomeLayoutSectionPref } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import {
  type ContextMenuAnchor,
  HorizontalRailScroll,
  Icon,
  PosterCard,
  TvFocusGuideRegion,
  useI18n,
  useTheme,
  WideCard,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  Fragment,
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
import { useCardPosterHoverPreview } from '../shared/PosterHoverPreviewContext';
import type { PosterHoverPreviewEntry } from '../shared/poster-hover-preview-model';
import {
  formatContinueEpisodeSubtitle,
  formatRemainingMinutes,
  type HomeCollectionRail,
  type HomeCollectionRailId,
  type HomeRailEntry,
  type HomeRailKind,
  type HomeRailSets,
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
    { id: 'elvShowcase', title: t('home.section.elvShowcase'), variant: 'poster' },
    { id: 'newEpisodes', title: t('home.newEpisodes'), variant: 'wide' },
    {
      id: 'live',
      title: t('home.liveTv'),
      variant: 'wide',
      actionLabel: t('home.channels'),
      tab: 'live',
    },
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
    { id: 'mylist', title: t('home.myList'), variant: 'poster' },
  ];
}

/** Identifier accepted by {@link HomeRail} (built-in rail or dynamic custom collection rail). */
export type HomeRailId = HomeRailKind | HomeCollectionRailId;

/** Props of {@link HomeRail}. */
interface HomeRailProps {
  readonly id: HomeRailId;
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
  readonly onContextMenuItem?: (
    entry: HomeRailEntry,
    index: number,
    anchor?: ContextMenuAnchor,
  ) => void;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly watchedOverrides?: ReadonlyMap<string, boolean>;
  readonly ratingByKey?: ReadonlyMap<string, RatingValue>;
  readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly onOpenDetail?: (entry: HomeRailEntry) => void;
  readonly onQuickPlay?: (entry: HomeRailEntry, index: number) => void;
  readonly onQuickToggleFavorite?: (entry: HomeRailEntry) => unknown;
  readonly onQuickToggleWatched?: (entry: HomeRailEntry, currentWatched: boolean) => unknown;
  readonly onQuickToggleRating?: (entry: HomeRailEntry, next: RatingValue) => unknown;
  readonly onDismissRecommendation?: (entry: HomeRailEntry) => unknown;
  readonly onLayoutY?: (id: HomeRailId, y: number) => void;
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
  readonly watchedOverride: boolean | undefined;
  readonly currentRating: RatingValue | null;
  readonly unplayedSummary: SeriesUnplayedSummary | undefined;
  readonly formatRemMin: (minutes: number) => string;
  readonly onPressItem: (entry: HomeRailEntry, index: number) => void;
  readonly onContextMenuItem?: (
    entry: HomeRailEntry,
    index: number,
    anchor?: ContextMenuAnchor,
  ) => void;
  readonly onOpenDetail?: (entry: HomeRailEntry) => void;
  readonly onQuickPlay?: (entry: HomeRailEntry, index: number) => void;
  readonly allowDismissRecommendation?: boolean;
  readonly onQuickToggleFavorite?: (entry: HomeRailEntry) => unknown;
  readonly onQuickToggleWatched?: (entry: HomeRailEntry, currentWatched: boolean) => unknown;
  readonly onQuickToggleRating?: (entry: HomeRailEntry, next: RatingValue) => unknown;
  readonly onDismissRecommendation?: (entry: HomeRailEntry) => unknown;
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
  watchedOverride,
  currentRating,
  unplayedSummary,
  formatRemMin,
  onPressItem,
  onContextMenuItem,
  onOpenDetail,
  onQuickPlay,
  allowDismissRecommendation = true,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
}: RailCardItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onPressItem(entry, index);
  }, [entry, index, onPressItem]);
  const handleContextMenu = useCallback(
    (anchor?: ContextMenuAnchor) => {
      onContextMenuItem?.(entry, index, anchor);
    },
    [entry, index, onContextMenuItem],
  );

  const isSeries = entry.kind === 'series';
  const effectiveWatched =
    watchedOverride ?? (entry.watched || (isSeries && unplayedSummary?.watched === true));

  const hoverEntry = useMemo<PosterHoverPreviewEntry | null>(
    () =>
      variant === 'poster' && (entry.kind === 'movie' || entry.kind === 'series')
        ? {
            itemKey: entry.itemKey,
            sourceId: entry.sourceId,
            kind: entry.kind,
            title: entry.title,
            posterUri: entry.posterUri,
            backdropUri: entry.backdropUri,
            year: entry.year,
            rating: entry.rating,
            overview: entry.overview ?? null,
            positionMs: entry.positionMs,
            watched: effectiveWatched,
            isFavorite,
            userRating: currentRating,
            ...(allowDismissRecommendation === false ? { allowDismissRecommendation: false } : {}),
            onPlay: () => (onQuickPlay ? onQuickPlay(entry, index) : onPressItem(entry, index)),
            onOpenDetail: () => (onOpenDetail ? onOpenDetail(entry) : onPressItem(entry, index)),
            ...(onQuickToggleFavorite !== undefined
              ? { onToggleFavorite: () => onQuickToggleFavorite(entry) }
              : {}),
            ...(onQuickToggleWatched !== undefined
              ? { onToggleWatched: (cur: boolean) => onQuickToggleWatched(entry, cur) }
              : {}),
            ...(onQuickToggleRating !== undefined
              ? { onToggleRating: (next: RatingValue) => onQuickToggleRating(entry, next) }
              : {}),
            ...(allowDismissRecommendation && onDismissRecommendation !== undefined
              ? { onDismissRecommendation: () => onDismissRecommendation(entry) }
              : {}),
          }
        : null,
    [
      allowDismissRecommendation,
      currentRating,
      effectiveWatched,
      entry,
      index,
      isFavorite,
      onDismissRecommendation,
      onOpenDetail,
      onPressItem,
      onQuickPlay,
      onQuickToggleFavorite,
      onQuickToggleRating,
      onQuickToggleWatched,
      variant,
    ],
  );
  const hoverHandlers = useCardPosterHoverPreview({
    enabled: variant === 'poster' && hoverEntry !== null,
    entry: hoverEntry,
    cardWidth,
  });

  if (variant === 'wide') {
    const isLive = Boolean(entry.live || entry.kind === 'live');
    const isInProgress = !isLive && entry.positionMs > 0;
    const ratio =
      isInProgress && entry.durationMs > 0
        ? progressRatio(entry.positionMs, entry.durationMs)
        : undefined;
    const remMin =
      isInProgress && entry.durationMs > 0
        ? formatRemainingMinutes(entry.positionMs, entry.durationMs)
        : null;
    const remLabel = remMin !== null ? formatRemMin(remMin) : undefined;
    const baseSubtitle = isLive
      ? (entry.subtitle ?? liveKindLabel)
      : entry.kind === 'episode'
        ? formatContinueEpisodeSubtitle(entry.season, entry.episode, entry.subtitle)
        : entry.subtitle;
    const subtitle = isLive
      ? (baseSubtitle ?? liveKindLabel)
      : baseSubtitle && remLabel
        ? `${baseSubtitle} · ${remLabel}`
        : (remLabel ?? baseSubtitle ?? undefined);

    return (
      <WideCard
        testID={testID}
        title={entry.title}
        {...(subtitle !== undefined ? { subtitle } : {})}
        {...(entry.badgeLabel ? { badge: entry.badgeLabel } : {})}
        imageUri={entry.backdropUri ?? entry.posterUri}
        portraitFallback={!isLive && !entry.backdropUri && Boolean(entry.posterUri)}
        live={isLive}
        logoBackdrop={isLive}
        showPlayBadge={!isLive}
        {...(ratio !== undefined ? { progress: ratio } : {})}
        width={cardWidth}
        maxDecodePx={480}
        focusable={!isTv}
        focused={focused}
        onPress={handlePress}
        {...(onContextMenuItem !== undefined ? { onContextMenu: handleContextMenu } : {})}
      />
    );
  }

  const meta = buildPosterMeta(entry);
  const ratio =
    !effectiveWatched && entry.positionMs > 0 && entry.durationMs > 0
      ? progressRatio(entry.positionMs, entry.durationMs)
      : undefined;
  const seriesBadge = isSeries
    ? resolveSeriesBadgeProps({
        summary: unplayedSummary,
        progressWatched: entry.watched,
        watchedOverride,
      })
    : {};
  const badge = entry.badgeLabel ?? (!isSeries && effectiveWatched ? watchedLabel : undefined);

  return (
    <PosterCard
      testID={testID}
      title={entry.title}
      {...(meta !== undefined ? { meta } : {})}
      imageUri={entry.posterUri}
      {...(ratio !== undefined ? { progress: ratio } : {})}
      {...(badge !== undefined ? { badge } : {})}
      {...seriesBadge}
      {...hoverHandlers}
      width={cardWidth}
      maxDecodePx={320}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
      {...(onContextMenuItem !== undefined ? { onContextMenu: handleContextMenu } : {})}
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
  onContextMenuItem,
  favoriteKeys,
  watchedOverrides,
  ratingByKey,
  unplayedBySeriesKey,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDismissRecommendation,
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

  if (items.length === 0) return null;

  const cursor = webCursorPointer();
  const linkTransition = webTransition(theme, 'color, opacity');
  const liveKindLabel = i18n.t('home.kind.live');
  const watchedLabel = i18n.t('home.watchedBadge');
  const isDiscoveryDismissible = id !== 'mylist' && !id.startsWith('collection:');

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
              watchedOverride={watchedOverrides?.get(entry.itemKey)}
              currentRating={ratingByKey?.get(entry.itemKey) ?? null}
              unplayedSummary={unplayedBySeriesKey?.get(entry.itemKey)}
              formatRemMin={formatRemMin}
              onPressItem={onPressItem}
              {...(onContextMenuItem !== undefined ? { onContextMenuItem } : {})}
              {...(onOpenDetail !== undefined ? { onOpenDetail } : {})}
              {...(onQuickPlay !== undefined ? { onQuickPlay } : {})}
              {...(onQuickToggleFavorite !== undefined ? { onQuickToggleFavorite } : {})}
              {...(onQuickToggleWatched !== undefined ? { onQuickToggleWatched } : {})}
              {...(onQuickToggleRating !== undefined ? { onQuickToggleRating } : {})}
              allowDismissRecommendation={isDiscoveryDismissible}
              {...(isDiscoveryDismissible && onDismissRecommendation !== undefined
                ? { onDismissRecommendation }
                : {})}
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
const HomeRail = memo(HomeRailInner);
HomeRail.displayName = 'HomeRail';

/** Props of {@link HomeCollectionsSection}. */
interface HomeCollectionsSectionProps {
  readonly collectionRails: readonly HomeCollectionRail[];
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focusedRowId: string | null;
  readonly focusedCol: number | null;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly ratingByKey?: ReadonlyMap<string, RatingValue>;
  readonly unplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly onPressItem: (entry: HomeRailEntry, index: number) => void;
  readonly onContextMenuItem: (
    railId: HomeRailId,
    entry: HomeRailEntry,
    index: number,
    anchor?: ContextMenuAnchor,
  ) => void;
  readonly onOpenDetail?: (entry: HomeRailEntry) => void;
  readonly onQuickPlay: (entry: HomeRailEntry, index: number) => void;
  readonly onQuickToggleFavorite: (entry: HomeRailEntry) => unknown;
  readonly onQuickToggleWatched: (entry: HomeRailEntry, currentWatched: boolean) => unknown;
  readonly onQuickToggleRating?: (entry: HomeRailEntry, next: RatingValue) => unknown;
  readonly onDismissRecommendation?: (entry: HomeRailEntry) => unknown;
  readonly onLayoutY: (id: HomeRailId, y: number) => void;
}

/** Renders non-empty hydrated custom VOD collection horizontal poster rails on Home (`#508`). */
function HomeCollectionsSection(p: HomeCollectionsSectionProps): ReactElement | null {
  if (p.collectionRails.length === 0) return null;
  return (
    <Fragment>
      {p.collectionRails.map((colRail) => (
        <HomeRail
          key={colRail.id}
          id={colRail.id}
          testID={`home-rail-collection-${colRail.collectionId}`}
          itemTestIdPrefix={`home-collection-${colRail.collectionId}-item`}
          title={colRail.title}
          variant="poster"
          items={colRail.items}
          cardWidth={p.cardWidth}
          gap={p.gap}
          padX={p.padX}
          isTv={p.isTv}
          isTouch={p.isTouch}
          focusedIndex={p.focusedRowId === colRail.id ? p.focusedCol : null}
          onPressItem={p.onPressItem}
          onContextMenuItem={(entry, index, anchor) =>
            p.onContextMenuItem(colRail.id, entry, index, anchor)
          }
          favoriteKeys={p.favoriteKeys}
          watchedOverrides={p.watchedOverrides}
          {...(p.ratingByKey !== undefined ? { ratingByKey: p.ratingByKey } : {})}
          unplayedBySeriesKey={p.unplayedBySeriesKey}
          {...(p.onOpenDetail !== undefined ? { onOpenDetail: p.onOpenDetail } : {})}
          onQuickPlay={p.onQuickPlay}
          onQuickToggleFavorite={p.onQuickToggleFavorite}
          onQuickToggleWatched={p.onQuickToggleWatched}
          {...(p.onQuickToggleRating !== undefined
            ? { onQuickToggleRating: p.onQuickToggleRating }
            : {})}
          onLayoutY={p.onLayoutY}
        />
      ))}
    </Fragment>
  );
}

/** Props of {@link HomeSectionsList}. */
export interface HomeSectionsListProps {
  readonly visibleSections: readonly HomeLayoutSectionPref[];
  readonly railSpecsById: ReadonlyMap<HomeRailKind, HomeRailSpec>;
  readonly railSets: HomeRailSets;
  readonly collectionRails: readonly HomeCollectionRail[];
  readonly wideCardWidth: number;
  readonly posterCardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focusedRowId: string | null;
  readonly focusedCol: number | null;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly ratingByKey?: ReadonlyMap<string, RatingValue>;
  readonly unplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly onOpenTab: (tab: BrowseKind) => void;
  readonly onPressWideItem: (entry: HomeRailEntry, index: number) => void;
  readonly onPressPosterItem: (entry: HomeRailEntry, index: number) => void;
  readonly onContextMenuItem: (
    railId: HomeRailId,
    entry: HomeRailEntry,
    index: number,
    anchor?: ContextMenuAnchor,
  ) => void;
  readonly onOpenDetail?: (entry: HomeRailEntry) => void;
  readonly onQuickPlay: (entry: HomeRailEntry, index: number) => void;
  readonly onQuickToggleFavorite: (entry: HomeRailEntry) => unknown;
  readonly onQuickToggleWatched: (entry: HomeRailEntry, currentWatched: boolean) => unknown;
  readonly onQuickToggleRating?: (entry: HomeRailEntry, next: RatingValue) => unknown;
  readonly onDismissRecommendation?: (entry: HomeRailEntry) => unknown;
  readonly onLayoutY: (id: HomeRailId, y: number) => void;
}

/**
 * Renders the ordered Home horizontal rails including the mixed Movies + Series ELV Showcase
 * (`home-rail-elv-showcase`) right after Continue Watching (or at top when hidden) (`#512`).
 */
export function HomeSectionsList(p: HomeSectionsListProps): ReactElement {
  const hasContinueSection = p.visibleSections.some((section) => section.id === 'continue');
  const elvShowcaseSpec = p.railSpecsById.get('elvShowcase');
  const posterCardExtras = {
    favoriteKeys: p.favoriteKeys,
    watchedOverrides: p.watchedOverrides,
    ...(p.ratingByKey !== undefined ? { ratingByKey: p.ratingByKey } : {}),
    unplayedBySeriesKey: p.unplayedBySeriesKey,
    ...(p.onOpenDetail !== undefined ? { onOpenDetail: p.onOpenDetail } : {}),
    onQuickPlay: p.onQuickPlay,
    onQuickToggleFavorite: p.onQuickToggleFavorite,
    onQuickToggleWatched: p.onQuickToggleWatched,
    ...(p.onQuickToggleRating !== undefined ? { onQuickToggleRating: p.onQuickToggleRating } : {}),
    ...(p.onDismissRecommendation !== undefined
      ? { onDismissRecommendation: p.onDismissRecommendation }
      : {}),
  };
  const renderElvShowcase = (): ReactElement | null => {
    if (!elvShowcaseSpec || p.railSets.elvShowcase.length === 0) return null;
    return (
      <HomeRail
        key="elvShowcase"
        id="elvShowcase"
        testID="home-rail-elv-showcase"
        itemTestIdPrefix="home-elv-showcase-item"
        title={elvShowcaseSpec.title}
        variant="poster"
        items={p.railSets.elvShowcase}
        cardWidth={p.posterCardWidth}
        gap={p.gap}
        padX={p.padX}
        isTv={p.isTv}
        isTouch={p.isTouch}
        focusedIndex={p.focusedRowId === 'elvShowcase' ? p.focusedCol : null}
        onPressItem={p.onPressPosterItem}
        onContextMenuItem={(entry, index, anchor) =>
          p.onContextMenuItem('elvShowcase', entry, index, anchor)
        }
        {...posterCardExtras}
        onLayoutY={p.onLayoutY}
      />
    );
  };

  return (
    <Fragment>
      {!hasContinueSection ? renderElvShowcase() : null}
      {p.visibleSections.map((section) => {
        if (section.id === 'collections') {
          return (
            <HomeCollectionsSection
              key="collections"
              collectionRails={p.collectionRails}
              cardWidth={p.posterCardWidth}
              gap={p.gap}
              padX={p.padX}
              isTv={p.isTv}
              isTouch={p.isTouch}
              focusedRowId={p.focusedRowId}
              focusedCol={p.focusedCol}
              onPressItem={p.onPressPosterItem}
              onContextMenuItem={p.onContextMenuItem}
              {...posterCardExtras}
              onLayoutY={p.onLayoutY}
            />
          );
        }
        const spec = p.railSpecsById.get(section.id);
        if (!spec) return null;
        const railNode = (
          <HomeRail
            key={spec.id}
            id={spec.id}
            testID={`home-rail-${spec.id}`}
            itemTestIdPrefix={`home-${spec.id}-item`}
            title={spec.title}
            {...(spec.actionLabel !== undefined ? { actionLabel: spec.actionLabel } : {})}
            {...(spec.tab !== undefined ? { actionTab: spec.tab, onPressAction: p.onOpenTab } : {})}
            variant={spec.variant}
            items={p.railSets[spec.id]}
            cardWidth={spec.variant === 'wide' ? p.wideCardWidth : p.posterCardWidth}
            gap={p.gap}
            padX={p.padX}
            isTv={p.isTv}
            isTouch={p.isTouch}
            focusedIndex={p.focusedRowId === spec.id ? p.focusedCol : null}
            onPressItem={spec.variant === 'poster' ? p.onPressPosterItem : p.onPressWideItem}
            onContextMenuItem={(entry, index, anchor) =>
              p.onContextMenuItem(spec.id, entry, index, anchor)
            }
            {...(spec.variant === 'poster' ? posterCardExtras : {})}
            onLayoutY={p.onLayoutY}
          />
        );
        if (section.id === 'continue') {
          return (
            <Fragment key="continue-group">
              {railNode}
              {renderElvShowcase()}
            </Fragment>
          );
        }
        return railNode;
      })}
    </Fragment>
  );
}

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
