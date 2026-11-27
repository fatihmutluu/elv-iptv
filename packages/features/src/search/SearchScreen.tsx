import type {
  CatalogService,
  ItemRow,
  RatingValue,
  SearchEpisodeHit,
  SearchProgrammeHit,
  SearchResults,
  SearchScope,
} from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { TextEntryBoundary, useContextMenu, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  computeCatalogLayout,
  type DetailTarget,
  detailTargetFromItem,
  isElvFeatureActive,
  matchesElvSearchAliases,
  presentElvCatalogItems,
  useCardQuickActionsState,
  useElvEnrichmentForKeys,
} from '../shared';
import { createImeSubmitGuard } from '../shared/ime-guard';
import {
  SearchEmptyPanel,
  SearchHeaderBar,
  SearchIdlePanel,
  SearchProgrammeDetailOverlay,
  SearchTvKeyBridge,
} from './SearchChrome';
import { SearchResultsSection } from './SearchResultsSection';
import {
  buildEpgSearchPlayTarget,
  buildEpisodeSearchPlayTarget,
  buildLiveSearchPlayTarget,
  buildSearchNavRows,
  countScopeResults,
  SEARCH_SCOPES,
  type SearchFocusPosition,
  type SearchNavRowId,
  type SearchResultSectionId,
  sanitizeSearchQuery,
} from './search-model';
import { useCatalogSearch } from './useCatalogSearch';
import { useElvAliasSearch } from './useElvAliasSearch';
import { useTvSearchNavigation } from './useTvSearchNavigation';

/** Props of {@link SearchScreen}. */
export interface SearchScreenProps {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly initialQuery?: string;
  readonly onQueryChange?: (next: string) => void;
  readonly initialScope?: SearchScope;
  readonly onScopeChange?: (next: SearchScope) => void;
  readonly recentSearches?: readonly string[];
  readonly onRecentSearchesChange?: (next: readonly string[]) => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
  /** Active ELV Mode display & merging preferences (`#511`). */
  readonly elvPreferences?: ElvModePreferences;
}

function SearchScreenBody({
  catalog,
  refreshToken,
  userStateVersion = 0,
  initialQuery,
  onQueryChange,
  initialScope,
  onScopeChange,
  recentSearches,
  onRecentSearchesChange,
  onPlay,
  onOpenDetail,
  onFocusTopNav,
  isActiveScope = true,
  elvPreferences,
}: SearchScreenProps): ReactElement {
  const elvPrefs = elvPreferences ?? DEFAULT_ELV_MODE_PREFERENCES;
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const contextMenu = useContextMenu();
  const layout = useMemo(
    () => computeCatalogLayout(viewport, theme, theme.fontScale),
    [theme, viewport],
  );
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;

  const { wideColumns, wideCardWidth, wideRowHeight } = useMemo(() => {
    const safeWidth = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1280;
    const available = Math.max(0, safeWidth - layout.padX * 2);
    const baseCols = Math.max(1, Math.floor(viewport.columns.wideRail));
    const rawCardWidth = Math.floor(
      (available - Math.max(0, baseCols - 1) * layout.gridGap) / baseCols,
    );
    const cols =
      baseCols >= 2 && rawCardWidth > 296
        ? Math.max(baseCols, Math.ceil((available + layout.gridGap) / (296 + layout.gridGap)))
        : baseCols;
    const cardWidth = Math.max(
      160,
      Math.min(296, Math.floor((available - Math.max(0, cols - 1) * layout.gridGap) / cols)),
    );
    const cardHeight = Math.round((cardWidth * 9) / 16);
    const rowHeight =
      cardHeight + Math.round((layout.isTv ? 64 : 52) * safeFontScale) + layout.gridGap;
    return { wideColumns: cols, wideCardWidth: cardWidth, wideRowHeight: rowHeight };
  }, [
    layout.gridGap,
    layout.isTv,
    layout.padX,
    safeFontScale,
    viewport.columns.wideRail,
    viewport.width,
  ]);

  const search = useCatalogSearch({
    catalog,
    refreshToken,
    userStateVersion,
    ...(initialQuery !== undefined ? { initialQuery } : {}),
    ...(onQueryChange !== undefined ? { onQueryChange } : {}),
    ...(initialScope !== undefined ? { initialScope } : {}),
    ...(onScopeChange !== undefined ? { onScopeChange } : {}),
    ...(recentSearches !== undefined ? { initialRecent: recentSearches } : {}),
    ...(onRecentSearchesChange !== undefined ? { onRecentChange: onRecentSearchesChange } : {}),
  });

  const [inputFocused, setInputFocused] = useState(false);
  const [selectedEpgProgramme, setSelectedEpgProgramme] = useState<SearchProgrammeHit | null>(null);
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const resultsContainerYRef = useRef(0);
  const sectionYRef = useRef<Map<SearchResultSectionId, number>>(new Map());

  const recordResultsContainerY = useCallback((y: number) => {
    resultsContainerYRef.current = y;
  }, []);
  const recordSectionY = useCallback((section: SearchResultSectionId, y: number) => {
    sectionYRef.current.set(section, y);
  }, []);

  const quickActionsState = useCardQuickActionsState({
    catalog,
    refreshToken,
    userStateVersion,
  });

  const handlePlayLive = useCallback(
    (item: ItemRow) => {
      onPlay(buildLiveSearchPlayTarget(item));
    },
    [onPlay],
  );

  const handlePlayVod = useCallback(
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
      const target = detailTargetFromItem(item);
      if (target) onOpenDetail(target);
    },
    [onOpenDetail, onPlay],
  );

  const handleToggleFavorite = useCallback(
    (item: ItemRow) => void quickActionsState.toggleFavorite(item),
    [quickActionsState.toggleFavorite],
  );

  const handleToggleWatched = useCallback(
    (item: ItemRow, currentWatched: boolean) =>
      void quickActionsState.toggleWatched(item, currentWatched),
    [quickActionsState.toggleWatched],
  );

  const handleToggleRating = useCallback(
    (item: ItemRow, next: RatingValue) => void quickActionsState.toggleRating(item, next),
    [quickActionsState.toggleRating],
  );

  const handleTuneEpgProgramme = useCallback(
    (programme: SearchProgrammeHit) => {
      onPlay(buildEpgSearchPlayTarget(programme));
    },
    [onPlay],
  );

  const handleSelectEpg = useCallback(
    (programme: SearchProgrammeHit) => {
      if (programme.isLiveNow) {
        onPlay(buildEpgSearchPlayTarget(programme));
      } else {
        setSelectedEpgProgramme(programme);
      }
    },
    [onPlay],
  );

  const handleSelectEpisode = useCallback(
    (episode: SearchEpisodeHit) => {
      const progress = search.progressByKey.get(episode.itemKey);
      const episodeLabel = i18n.t('search.episodeLabel', {
        season: episode.season,
        episode: episode.episode,
      });
      onPlay(buildEpisodeSearchPlayTarget(episode, progress, episodeLabel));
    },
    [i18n, onPlay, search.progressByKey],
  );

  const sanitizedQuery = sanitizeSearchQuery(search.query);
  const hasQuery = sanitizedQuery.length > 0;
  const elvEnrichActive = isElvFeatureActive(elvPrefs, 'elvEnrichMetadata');
  const existingCatalogVodKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const m of search.results.movies) keys.add(m.key);
    for (const s of search.results.series) keys.add(s.key);
    return keys;
  }, [search.results.movies, search.results.series]);
  const aliasSearch = useElvAliasSearch({
    catalog,
    query: search.query,
    scope: search.scope,
    enabled: elvEnrichActive,
    refreshToken,
    existingKeys: existingCatalogVodKeys,
  });
  const mergedBaseResults = useMemo<SearchResults>(() => {
    if (aliasSearch.movies.length === 0 && aliasSearch.series.length === 0) {
      return search.results;
    }
    const mergeUnique = (base: readonly ItemRow[], extra: readonly ItemRow[]): ItemRow[] => {
      if (extra.length === 0) return [...base];
      const seen = new Set(base.map((item) => item.key));
      const out = [...base];
      for (const item of extra) {
        if (!seen.has(item.key)) {
          seen.add(item.key);
          out.push(item);
        }
      }
      return out;
    };
    return {
      ...search.results,
      movies: mergeUnique(search.results.movies, aliasSearch.movies),
      series: mergeUnique(search.results.series, aliasSearch.series),
    };
  }, [aliasSearch.movies, aliasSearch.series, search.results]);
  const searchVodKeys = useMemo(() => {
    if (!elvPrefs.elvModeEnabled) return [] as string[];
    return [
      ...mergedBaseResults.movies.map((m) => m.key),
      ...mergedBaseResults.series.map((s) => s.key),
    ];
  }, [elvPrefs.elvModeEnabled, mergedBaseResults.movies, mergedBaseResults.series]);
  const elvEnrichment = useElvEnrichmentForKeys(catalog, searchVodKeys, {
    enabled: elvPrefs.elvModeEnabled,
    lang: i18n.locale,
    catalogRevision: refreshToken,
  });
  const presentedResults = useMemo<SearchResults>(() => {
    if (!elvPrefs.elvModeEnabled) return mergedBaseResults;
    const rankByAlias = <T extends ItemRow>(rows: readonly T[]): T[] => {
      const presented = presentElvCatalogItems(
        rows,
        elvEnrichment.enrichmentByKey,
        elvPrefs,
        i18n.locale,
        { isKeyLookupPending: elvEnrichment.isKeyLookupPending },
      );
      if (sanitizedQuery === '' || elvEnrichment.enrichmentByKey.size === 0) return [...presented];
      const matched: T[] = [];
      const rest: T[] = [];
      for (const item of presented) {
        if (
          matchesElvSearchAliases(
            sanitizedQuery,
            elvEnrichment.enrichmentByKey.get(item.key),
            item.name,
            i18n.locale,
          )
        ) {
          matched.push(item);
        } else {
          rest.push(item);
        }
      }
      return [...matched, ...rest];
    };
    return {
      ...mergedBaseResults,
      movies: rankByAlias(mergedBaseResults.movies),
      series: rankByAlias(mergedBaseResults.series),
    };
  }, [
    elvEnrichment.enrichmentByKey,
    elvEnrichment.isKeyLookupPending,
    elvPrefs,
    i18n.locale,
    mergedBaseResults,
    sanitizedQuery,
  ]);
  const effectiveSearching = search.searching || aliasSearch.searching;

  const totalVisibleHits = useMemo(
    () => countScopeResults(presentedResults, search.scope),
    [presentedResults, search.scope],
  );

  const navRows = useMemo(
    () =>
      buildSearchNavRows({
        hasQuery,
        hasClearButton: search.query.length > 0,
        scope: search.scope,
        recentCount: search.recentSearches.length,
        suggestionCount: search.suggestions.length,
        liveCount: presentedResults.live.length,
        epgCount: presentedResults.epg.length,
        movieCount: presentedResults.movies.length,
        seriesCount: presentedResults.series.length,
        episodeCount: presentedResults.episodes.length,
        liveColumns: wideColumns,
        epgColumns: wideColumns,
        vodColumns: layout.gridColumns,
        episodeColumns: wideColumns,
        searching: effectiveSearching,
        hasSearched: search.hasSearched,
      }),
    [
      effectiveSearching,
      hasQuery,
      layout.gridColumns,
      presentedResults.epg.length,
      presentedResults.episodes.length,
      presentedResults.live.length,
      presentedResults.movies.length,
      presentedResults.series.length,
      search.hasSearched,
      search.query.length,
      search.recentSearches.length,
      search.scope,
      search.suggestions.length,
      wideColumns,
    ],
  );

  const handleActivateRow = useCallback(
    (rowId: SearchNavRowId, col: number) => {
      if (rowId === 'input' && col === 1) {
        search.clearSearch();
        return;
      }
      if (rowId === 'scopes') {
        const nextScope = SEARCH_SCOPES[col];
        if (nextScope) search.setScope(nextScope);
        return;
      }
      if (rowId === 'recent') {
        if (col === search.recentSearches.length) {
          search.clearRecent();
          return;
        }
        const term = search.recentSearches[col];
        if (term) search.selectRecent(term);
        return;
      }
      if (rowId === 'suggestions') {
        const suggestion = search.suggestions[col];
        if (suggestion) search.selectSuggestion(suggestion);
        return;
      }
      if (rowId === 'live') {
        const item = search.results.live[col];
        if (item) handlePlayLive(item);
        return;
      }
      if (rowId === 'epg') {
        const hit = search.results.epg[col];
        if (hit) handleSelectEpg(hit);
        return;
      }
      if (rowId === 'movies') {
        const item = presentedResults.movies[col];
        const target = item ? detailTargetFromItem(item) : undefined;
        if (target) onOpenDetail(target);
        return;
      }
      if (rowId === 'series') {
        const item = presentedResults.series[col];
        const target = item ? detailTargetFromItem(item) : undefined;
        if (target) onOpenDetail(target);
        return;
      }
      if (rowId === 'episodes') {
        const hit = presentedResults.episodes[col];
        if (hit) handleSelectEpisode(hit);
        return;
      }
      if (rowId === 'clearEmpty') {
        search.clearSearch();
      }
    },
    [handlePlayLive, handleSelectEpg, handleSelectEpisode, onOpenDetail, presentedResults, search],
  );

  const handleFocusPosition = useCallback(
    (pos: SearchFocusPosition) => {
      if (
        pos.rowId === 'input' ||
        pos.rowId === 'scopes' ||
        pos.rowId === 'recent' ||
        pos.rowId === 'suggestions'
      ) {
        scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
        return;
      }
      if (
        pos.rowId === 'live' ||
        pos.rowId === 'epg' ||
        pos.rowId === 'movies' ||
        pos.rowId === 'series' ||
        pos.rowId === 'episodes'
      ) {
        const sectionY = sectionYRef.current.get(pos.rowId) ?? 0;
        const isVodGrid = pos.rowId === 'movies' || pos.rowId === 'series';
        const cols = isVodGrid ? layout.gridColumns : wideColumns;
        const rowStride =
          pos.rowId === 'epg' || pos.rowId === 'episodes'
            ? Math.round(96 * safeFontScale) + layout.gridGap
            : isVodGrid
              ? layout.gridRowHeight
              : wideRowHeight;
        const visualRow = Math.floor(pos.col / Math.max(1, cols));
        const targetY = Math.max(
          0,
          resultsContainerYRef.current + sectionY + visualRow * rowStride - 16,
        );
        scrollViewRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
      }
    },
    [
      layout.gridColumns,
      layout.gridGap,
      layout.gridRowHeight,
      safeFontScale,
      theme.reduceMotion,
      wideColumns,
      wideRowHeight,
    ],
  );

  const tv = useTvSearchNavigation({
    isTv: layout.isTv,
    isActiveScope: isActiveScope && selectedEpgProgramme === null,
    hasQuery,
    rows: navRows,
    onActivate: handleActivateRow,
    onClearSearch: search.clearSearch,
    onFocusPosition: handleFocusPosition,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const { endInputEdit } = tv;
  const { commitRecent } = search;

  const imeGuardRef = useRef(createImeSubmitGuard());
  const handleInputFocus = useCallback(() => setInputFocused(true), []);
  const handleInputBlur = useCallback(() => {
    imeGuardRef.current.reset();
    setInputFocused(false);
    endInputEdit();
  }, [endInputEdit]);
  const handleInputKeyPress = useCallback((event: unknown) => {
    imeGuardRef.current.onKeyPress(event);
  }, []);
  const handleInputSubmit = useCallback(
    (event?: unknown) => {
      if (!imeGuardRef.current.shouldAllowSubmit(event)) return;
      if (sanitizedQuery.length > 0) commitRecent(sanitizedQuery);
    },
    [commitRecent, sanitizedQuery],
  );

  const scopeLabels: Readonly<Record<SearchScope, string>> = useMemo(
    () => ({
      all: i18n.t('search.scope.all'),
      live: search.hasSearched
        ? i18n.t('search.scope.live', { count: search.results.live.length })
        : i18n.t('nav.live'),
      epg: search.hasSearched
        ? `${i18n.t('search.scopeEpg')} (${search.results.epg.length})`
        : i18n.t('search.scopeEpg'),
      movie: search.hasSearched
        ? i18n.t('search.scope.movies', { count: presentedResults.movies.length })
        : i18n.t('nav.movies'),
      series: search.hasSearched
        ? i18n.t('search.scope.series', { count: presentedResults.series.length })
        : i18n.t('nav.series'),
      episode: search.hasSearched
        ? `${i18n.t('search.scopeEpisodes')} (${presentedResults.episodes.length})`
        : i18n.t('search.scopeEpisodes'),
    }),
    [
      i18n,
      presentedResults.episodes.length,
      presentedResults.movies.length,
      presentedResults.series.length,
      search.hasSearched,
      search.results.epg.length,
      search.results.live.length,
    ],
  );

  const isEmptySettled = hasQuery && totalVisibleHits === 0 && !effectiveSearching;
  const bottomPad = Math.max(
    theme.spacing.xl,
    viewport.safeArea.bottom + (layout.isPortrait ? 72 : 24),
  );

  return (
    <View testID="search-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {layout.isTv && isActiveScope && selectedEpgProgramme === null && !contextMenu.isOpen ? (
        <SearchTvKeyBridge onEvent={tv.handleTvKey} />
      ) : null}

      <ScrollView
        ref={scrollViewRef}
        testID="search-scroll"
        {...(layout.isTv ? { focusable: false } : {})}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: theme.spacing.sm, paddingBottom: bottomPad },
        ]}
      >
        <SearchHeaderBar
          query={search.query}
          scope={search.scope}
          scopeLabels={scopeLabels}
          hasQuery={hasQuery}
          hasSearched={search.hasSearched}
          searching={effectiveSearching}
          totalVisibleHits={totalVisibleHits}
          padX={layout.padX}
          isTv={layout.isTv}
          isTouch={layout.isTouch}
          inputRef={tv.inputRef}
          allowNativeEdit={!layout.isTv || tv.editingInput}
          inputFocused={inputFocused}
          inputTvFocused={layout.isTv && tv.focusedRowId === 'input' && tv.focusedCol === 0}
          clearTvFocused={layout.isTv && tv.focusedRowId === 'input' && tv.focusedCol === 1}
          focusedScopeIndex={layout.isTv && tv.focusedRowId === 'scopes' ? tv.focusedCol : null}
          onChangeQuery={search.setQuery}
          onInputFocus={handleInputFocus}
          onInputBlur={handleInputBlur}
          onInputKeyPress={handleInputKeyPress}
          onInputSubmit={handleInputSubmit}
          onClearSearch={search.clearSearch}
          onSelectScope={search.setScope}
        />

        {!hasQuery ? (
          <SearchIdlePanel
            recentSearches={search.recentSearches}
            suggestions={search.suggestions}
            padX={layout.padX}
            isTv={layout.isTv}
            focusedRecentIndex={layout.isTv && tv.focusedRowId === 'recent' ? tv.focusedCol : null}
            focusedSuggestionIndex={
              layout.isTv && tv.focusedRowId === 'suggestions' ? tv.focusedCol : null
            }
            onSelectRecent={search.selectRecent}
            onClearRecent={search.clearRecent}
            onSelectSuggestion={search.selectSuggestion}
          />
        ) : isEmptySettled ? (
          <SearchEmptyPanel
            query={sanitizedQuery}
            padX={layout.padX}
            isTv={layout.isTv}
            clearFocused={layout.isTv && tv.focusedRowId === 'clearEmpty'}
            onClearSearch={search.clearSearch}
          />
        ) : (
          <SearchResultsSection
            results={presentedResults}
            scope={search.scope}
            progressByKey={search.progressByKey}
            favoriteKeys={quickActionsState.favoriteKeys}
            watchedOverrides={quickActionsState.watchedOverrides}
            ratingByKey={quickActionsState.ratingByKey}
            searching={effectiveSearching}
            hasSearched={search.hasSearched}
            padX={layout.padX}
            gridGap={layout.gridGap}
            wideCardWidth={wideCardWidth}
            posterCardWidth={layout.gridCardWidth}
            isTv={layout.isTv}
            focusedRowId={tv.focusedRowId}
            focusedCol={tv.focusedCol}
            onPlayLive={handlePlayLive}
            onPlayVod={handlePlayVod}
            onToggleFavorite={handleToggleFavorite}
            onToggleWatched={handleToggleWatched}
            onToggleRating={handleToggleRating}
            onSelectEpg={handleSelectEpg}
            onOpenDetail={onOpenDetail}
            onSelectEpisode={handleSelectEpisode}
            onContainerLayoutY={recordResultsContainerY}
            onSectionLayoutY={recordSectionY}
          />
        )}
      </ScrollView>

      <SearchProgrammeDetailOverlay
        programme={selectedEpgProgramme}
        isTv={layout.isTv}
        onTune={handleTuneEpgProgramme}
        onClose={() => setSelectedEpgProgramme(null)}
      />
    </View>
  );
}

/**
 * Cinema Quietude instant Turkish-tolerant Search screen (`UI_UX_PHILOSOPHY.md` §2.1, §3, §4).
 * Provides debounced FTS5 search, 6 scope underline tabs (`All`, `Live`, `On Now & Guide`, `Movies`,
 * `Series`, `Episodes`), recent searches, on-device quick picks, grouped result sections, and 10-ft TV D-pad.
 */
export function SearchScreen(props: SearchScreenProps): ReactElement {
  return (
    <TextEntryBoundary>
      <SearchScreenBody {...props} />
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { flexGrow: 1 },
});
