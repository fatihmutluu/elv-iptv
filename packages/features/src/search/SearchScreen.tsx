import type { CatalogService, ItemRow, SearchScope } from '@elv/data';
import { TextEntryBoundary, useI18n, useTheme, useViewport } from '@elv/ui-kit';
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
import { computeCatalogLayout, type DetailTarget, detailTargetFromItem } from '../shared';
import { createImeSubmitGuard } from '../shared/ime-guard';
import {
  SearchEmptyPanel,
  SearchHeaderBar,
  SearchIdlePanel,
  SearchTvKeyBridge,
} from './SearchChrome';
import { SearchResultsSection } from './SearchResultsSection';
import {
  buildLiveSearchPlayTarget,
  buildSearchNavRows,
  countScopeResults,
  SEARCH_SCOPES,
  type SearchFocusPosition,
  type SearchNavRowId,
  sanitizeSearchQuery,
} from './search-model';
import { useCatalogSearch } from './useCatalogSearch';
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
}: SearchScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const layout = useMemo(() => computeCatalogLayout(viewport, theme), [theme, viewport]);

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
    const rowHeight = cardHeight + (layout.isTv ? 64 : 52) + layout.gridGap;
    return { wideColumns: cols, wideCardWidth: cardWidth, wideRowHeight: rowHeight };
  }, [layout.gridGap, layout.isTv, layout.padX, viewport.columns.wideRail, viewport.width]);

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
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const resultsContainerYRef = useRef(0);
  const sectionYRef = useRef<Map<'live' | 'movies' | 'series', number>>(new Map());

  const recordResultsContainerY = useCallback((y: number) => {
    resultsContainerYRef.current = y;
  }, []);
  const recordSectionY = useCallback((section: 'live' | 'movies' | 'series', y: number) => {
    sectionYRef.current.set(section, y);
  }, []);

  const handlePlayLive = useCallback(
    (item: ItemRow) => {
      onPlay(buildLiveSearchPlayTarget(item));
    },
    [onPlay],
  );

  const sanitizedQuery = sanitizeSearchQuery(search.query);
  const hasQuery = sanitizedQuery.length > 0;
  const totalVisibleHits = useMemo(
    () => countScopeResults(search.results, search.scope),
    [search.results, search.scope],
  );

  const navRows = useMemo(
    () =>
      buildSearchNavRows({
        hasQuery,
        hasClearButton: search.query.length > 0,
        scope: search.scope,
        recentCount: search.recentSearches.length,
        liveCount: search.results.live.length,
        movieCount: search.results.movies.length,
        seriesCount: search.results.series.length,
        liveColumns: wideColumns,
        vodColumns: layout.gridColumns,
        searching: search.searching,
        hasSearched: search.hasSearched,
      }),
    [
      hasQuery,
      layout.gridColumns,
      search.hasSearched,
      search.query.length,
      search.recentSearches.length,
      search.results.live.length,
      search.results.movies.length,
      search.results.series.length,
      search.scope,
      search.searching,
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
      if (rowId === 'live') {
        const item = search.results.live[col];
        if (item) handlePlayLive(item);
        return;
      }
      if (rowId === 'movies') {
        const item = search.results.movies[col];
        const target = item ? detailTargetFromItem(item) : undefined;
        if (target) onOpenDetail(target);
        return;
      }
      if (rowId === 'series') {
        const item = search.results.series[col];
        const target = item ? detailTargetFromItem(item) : undefined;
        if (target) onOpenDetail(target);
        return;
      }
      if (rowId === 'clearEmpty') {
        search.clearSearch();
      }
    },
    [handlePlayLive, onOpenDetail, search],
  );

  const handleFocusPosition = useCallback(
    (pos: SearchFocusPosition) => {
      if (pos.rowId === 'input' || pos.rowId === 'scopes' || pos.rowId === 'recent') {
        scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
        return;
      }
      if (pos.rowId === 'live' || pos.rowId === 'movies' || pos.rowId === 'series') {
        const sectionY = sectionYRef.current.get(pos.rowId) ?? 0;
        const cols = pos.rowId === 'live' ? wideColumns : layout.gridColumns;
        const rowStride = pos.rowId === 'live' ? wideRowHeight : layout.gridRowHeight;
        const visualRow = Math.floor(pos.col / Math.max(1, cols));
        const targetY = Math.max(
          0,
          resultsContainerYRef.current + sectionY + visualRow * rowStride - 16,
        );
        scrollViewRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
      }
    },
    [layout.gridColumns, layout.gridRowHeight, theme.reduceMotion, wideColumns, wideRowHeight],
  );

  const tv = useTvSearchNavigation({
    isTv: layout.isTv,
    isActiveScope,
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
      movie: search.hasSearched
        ? i18n.t('search.scope.movies', { count: search.results.movies.length })
        : i18n.t('nav.movies'),
      series: search.hasSearched
        ? i18n.t('search.scope.series', { count: search.results.series.length })
        : i18n.t('nav.series'),
    }),
    [
      i18n,
      search.hasSearched,
      search.results.live.length,
      search.results.movies.length,
      search.results.series.length,
    ],
  );

  const isEmptySettled = hasQuery && totalVisibleHits === 0 && !search.searching;
  const bottomPad = Math.max(
    theme.spacing.xl,
    viewport.safeArea.bottom + (layout.isPortrait ? 72 : 24),
  );

  return (
    <View testID="search-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {layout.isTv && isActiveScope ? <SearchTvKeyBridge onEvent={tv.handleTvKey} /> : null}

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
          searching={search.searching}
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
            padX={layout.padX}
            isTv={layout.isTv}
            focusedRecentIndex={layout.isTv && tv.focusedRowId === 'recent' ? tv.focusedCol : null}
            onSelectRecent={search.selectRecent}
            onClearRecent={search.clearRecent}
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
            results={search.results}
            scope={search.scope}
            progressByKey={search.progressByKey}
            searching={search.searching}
            hasSearched={search.hasSearched}
            padX={layout.padX}
            gridGap={layout.gridGap}
            wideCardWidth={wideCardWidth}
            posterCardWidth={layout.gridCardWidth}
            isTv={layout.isTv}
            focusedRowId={tv.focusedRowId}
            focusedCol={tv.focusedCol}
            onPlayLive={handlePlayLive}
            onOpenDetail={onOpenDetail}
            onContainerLayoutY={recordResultsContainerY}
            onSectionLayoutY={recordSectionY}
          />
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Cinema Quietude instant Turkish-tolerant Search screen (`UI_UX_PHILOSOPHY.md` §2.1, §3, §4).
 * Provides debounced FTS5 search, instant single-query scope chips, recent searches, grouped
 * Live (`WideCard`) and VOD (`PosterCard`) results, and 10-ft TV D-pad ergonomics.
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
