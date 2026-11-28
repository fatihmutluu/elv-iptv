import type { EpisodeRow, ItemRow, SeasonRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { DetailTarget, PersonLibraryModalPerson } from '../shared';
import type { DetailHeroFocusSlot } from './DetailHero';
import {
  buildDetailNavRows,
  type DetailEpisodeFocusAction,
  type DetailNavRowId,
  type EpisodeRowMetrics,
} from './detail-model';
import type { DetailDataState } from './useDetailData';
import type { DetailExtrasState } from './useDetailExtrasState';
import { useTvDetailNavigation } from './useTvDetailNavigation';

const SCROLL_FROST_THRESHOLD = 24;

/** Action slot identifiers rendered in the Detail Hero circular icon bar. */
export type DetailHeroActionSlot =
  | 'trailer'
  | 'mylist'
  | 'like'
  | 'dislike'
  | 'watched'
  | 'download';

/** Options for {@link useDetailScrollAndNav}. */
export interface UseDetailScrollAndNavOptions {
  readonly target: DetailTarget;
  readonly data: DetailDataState;
  readonly extras: DetailExtrasState;
  readonly seasons: readonly SeasonRow[];
  readonly listEpisodes: readonly EpisodeRow[];
  readonly showHeroDownload: boolean;
  readonly downloadsSupported: boolean;
  readonly hasTrailer: boolean;
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly anyModalOpen: boolean;
  readonly reduceMotion: boolean;
  readonly heroTopClearance: number;
  readonly headerHeight: number;
  readonly rowMetrics: EpisodeRowMetrics;
  readonly flatListRef: RefObject<FlatList<EpisodeRow> | null>;
  readonly onBack: () => void;
  readonly onFocusTopNav?: () => void;
  readonly onScrollTopChange?: (scrolled: boolean) => void;
  readonly onPlayPrimary: () => void;
  readonly onPressHeroWatched: () => void;
  readonly onPressHeroDownload: () => void;
  readonly onOpenTrailer: () => void;
  readonly onSelectPerson: (person: PersonLibraryModalPerson) => void;
  readonly onPressFranchise: (item: ItemRow) => void;
  readonly onPressEpisode: (episode: EpisodeRow, index: number) => void;
  readonly onPressEpisodeDownload: (episode: EpisodeRow) => void;
  readonly onPressRelated: (item: ItemRow) => void;
}

/** Coordinates FlatList scroll tracking, section Y anchors, and 10-ft TV D-pad focus for `DetailScreen`. */
export function useDetailScrollAndNav({
  target,
  data,
  extras,
  seasons,
  listEpisodes,
  showHeroDownload,
  downloadsSupported,
  hasTrailer,
  isTv,
  isActiveScope,
  anyModalOpen,
  reduceMotion,
  heroTopClearance,
  headerHeight,
  rowMetrics,
  flatListRef,
  onBack,
  onFocusTopNav,
  onScrollTopChange,
  onPlayPrimary,
  onPressHeroWatched,
  onPressHeroDownload,
  onOpenTrailer,
  onSelectPerson,
  onPressFranchise,
  onPressEpisode,
  onPressEpisodeDownload,
  onPressRelated,
}: UseDetailScrollAndNavOptions) {
  const scrolledRef = useRef(false);
  const castYRef = useRef<number | null>(null);
  const franchiseYRef = useRef<number | null>(null);
  const episodesYRef = useRef<number | null>(null);

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
    episodesYRef.current = null;
    onScrollTopChange?.(false);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [flatListRef, onScrollTopChange, target.itemKey]);

  const heroActionSlots = useMemo<readonly DetailHeroActionSlot[]>(
    () => [
      ...(hasTrailer ? (['trailer'] as const) : []),
      'mylist',
      'like',
      'dislike',
      'watched',
      ...(showHeroDownload ? (['download'] as const) : []),
    ],
    [hasTrailer, showHeroDownload],
  );

  const navRows = useMemo(
    () =>
      buildDetailNavRows({
        heroActionCount: heroActionSlots.length,
        heroPlayCount: extras.heroPlaySlots.length,
        castCount: extras.castPeople.length,
        franchiseCount: data.franchiseItems.length,
        seasonsCount: target.kind === 'series' ? seasons.length : 0,
        episodesCount: listEpisodes.length,
        hasSeasonsError: target.kind === 'series' && data.seasonsState.kind === 'error',
        relatedCount: data.related.length,
      }),
    [
      data.franchiseItems.length,
      data.related.length,
      data.seasonsState.kind,
      extras.castPeople.length,
      extras.heroPlaySlots.length,
      heroActionSlots.length,
      listEpisodes.length,
      seasons.length,
      target.kind,
    ],
  );

  const handleTvActivate = useCallback(
    (rowId: DetailNavRowId, colIndex: number, episodeAction?: DetailEpisodeFocusAction) => {
      if (rowId === 'back') return onBack();
      if (rowId === 'hero-actions') {
        const slot = heroActionSlots[colIndex];
        if (slot === 'mylist') void data.toggleMyList();
        else if (slot === 'like') void data.toggleRating('like');
        else if (slot === 'dislike') void data.toggleRating('dislike');
        else if (slot === 'watched') onPressHeroWatched();
        else if (slot === 'download') onPressHeroDownload();
        else if (slot === 'trailer') onOpenTrailer();
        return;
      }
      if (rowId === 'hero-play') {
        const slot = extras.heroPlaySlots[colIndex];
        if (slot === 'play') onPlayPrimary();
        else if (slot === 'preplay-version') extras.toggleVersionMenu();
        else if (slot === 'synopsis') extras.toggleSynopsis();
        return;
      }
      if (rowId === 'cast') {
        const person = extras.castPeople[colIndex];
        if (person) onSelectPerson(person);
        return;
      }
      if (rowId === 'franchise') {
        const entry = data.franchiseItems[colIndex];
        if (entry && entry.item.key !== target.itemKey) onPressFranchise(entry.item);
        return;
      }
      if (rowId === 'seasons') {
        const picked = seasons[colIndex];
        if (picked) data.selectSeason(picked.season);
        return;
      }
      if (rowId === 'retry') return data.retrySeasons();
      if (rowId === 'episodes') {
        const ep = listEpisodes[colIndex];
        if (!ep) return;
        if (episodeAction === 'watched') return void data.toggleEpisodeWatched(ep);
        if (episodeAction === 'download') return onPressEpisodeDownload(ep);
        onPressEpisode(ep, colIndex);
        return;
      }
      if (rowId === 'related') {
        const item = data.related[colIndex];
        if (item) onPressRelated(item);
      }
    },
    [
      data,
      extras,
      heroActionSlots,
      listEpisodes,
      onBack,
      onOpenTrailer,
      onPlayPrimary,
      onPressEpisode,
      onPressEpisodeDownload,
      onPressFranchise,
      onPressHeroDownload,
      onPressHeroWatched,
      onPressRelated,
      onSelectPerson,
      seasons,
      target.itemKey,
    ],
  );

  const handleTvFocusRow = useCallback(
    (rowId: DetailNavRowId, colIndex: number) => {
      const animated = !reduceMotion;
      if (rowId === 'back' || rowId === 'hero-actions' || rowId === 'hero-play') {
        flatListRef.current?.scrollToOffset({ offset: 0, animated });
        reportScrolled(false);
        return;
      }
      if (rowId === 'cast' && castYRef.current !== null) {
        const targetY = Math.max(0, castYRef.current - heroTopClearance);
        flatListRef.current?.scrollToOffset({ offset: targetY, animated });
        reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
        return;
      }
      if (rowId === 'franchise' && franchiseYRef.current !== null) {
        const targetY = Math.max(0, franchiseYRef.current - heroTopClearance);
        flatListRef.current?.scrollToOffset({ offset: targetY, animated });
        reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
        return;
      }
      if ((rowId === 'seasons' || rowId === 'retry') && episodesYRef.current !== null) {
        const targetY = Math.max(0, episodesYRef.current - heroTopClearance);
        flatListRef.current?.scrollToOffset({ offset: targetY, animated });
        reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
        return;
      }
      if (rowId === 'episodes') {
        if (colIndex >= 0 && colIndex < listEpisodes.length) {
          flatListRef.current?.scrollToIndex({ index: colIndex, animated, viewPosition: 0.35 });
          reportScrolled(true);
        } else {
          const baseY = headerHeight > 0 ? headerHeight : (episodesYRef.current ?? 0);
          const targetY = Math.max(0, baseY + colIndex * rowMetrics.itemStride - heroTopClearance);
          flatListRef.current?.scrollToOffset({ offset: targetY, animated });
          reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
        }
        return;
      }
      if (rowId === 'related') {
        const targetY = Math.max(
          0,
          headerHeight + listEpisodes.length * rowMetrics.itemStride - heroTopClearance,
        );
        flatListRef.current?.scrollToOffset({ offset: targetY, animated });
        reportScrolled(targetY > SCROLL_FROST_THRESHOLD);
      }
    },
    [
      flatListRef,
      headerHeight,
      heroTopClearance,
      listEpisodes.length,
      reduceMotion,
      reportScrolled,
      rowMetrics.itemStride,
    ],
  );

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const offset = Math.max(
        0,
        headerHeight + info.index * rowMetrics.itemStride - heroTopClearance,
      );
      flatListRef.current?.scrollToOffset({ offset, animated: !reduceMotion });
    },
    [flatListRef, headerHeight, heroTopClearance, reduceMotion, rowMetrics.itemStride],
  );

  const tvNav = useTvDetailNavigation({
    isTv,
    isActiveScope: isActiveScope && !anyModalOpen,
    targetKey: target.itemKey,
    rows: navRows,
    episodeDownloadEnabled: downloadsSupported,
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

  return {
    tvNav,
    focusedHeroSlot,
    handleScroll,
    handleScrollToIndexFailed,
    handleTvKeyWithSheet,
    recordCastY,
    recordFranchiseY,
    recordEpisodesY,
  };
}
