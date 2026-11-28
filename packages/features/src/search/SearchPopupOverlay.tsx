import type { CatalogService, ItemRow, SearchResults } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import {
  Icon,
  TextEntryBoundary,
  TvFocusAnchor,
  TvTextInput,
  type TvTextInputInstance,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  type DetailTarget,
  detailTargetFromItem,
  isElvFeatureActive,
  matchesElvSearchAliases,
  presentElvCatalogItems,
  useElvEnrichmentForKeys,
} from '../shared';
import { useDesktopDialogTrap } from '../shared/desktop-dialog-trap';
import { SearchPopupRails } from './SearchPopupRails';
import {
  buildLiveSearchPlayTarget,
  MAX_SEARCH_QUERY_CHARS,
  sanitizeSearchQuery,
} from './search-model';
import {
  buildSearchPopupNavRows,
  buildSearchPopupSuggestions,
  SEARCH_POPUP_RAIL_LIMIT,
  type SearchPopupFocusPosition,
  stepSearchPopupFocus,
} from './search-popup-model';
import { useCatalogSearch } from './useCatalogSearch';
import { useElvAliasSearch } from './useElvAliasSearch';

/** Props of {@link SearchPopupOverlay}. */
export interface SearchPopupOverlayProps {
  readonly visible: boolean;
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly elvPreferences?: ElvModePreferences;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onViewAll: (query: string) => void;
  readonly onClose: () => void;
}

function PopupTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="search-popup-tv-anchor" hasTVPreferredFocus />;
}

/**
 * Top-anchored frosted Search Popup overlay (`UI_UX_PHILOSOPHY.md`, Wave R1):
 * - Opens over the active screen with click-outside backdrop + Escape / TV Back dismiss.
 * - Up to 3 live title suggestions extracted from catalog matches + 3 single-row horizontal
 *   rails (`Movies -> Series -> Live`, omitting empty rails) + bare text-only `View all` button.
 */
export function SearchPopupOverlay(props: SearchPopupOverlayProps): ReactElement | null {
  if (!props.visible) return null;
  return <SearchPopupBody {...props} />;
}

function SearchPopupBody({
  visible,
  catalog,
  refreshToken,
  userStateVersion = 0,
  query,
  onQueryChange,
  elvPreferences,
  onPlay,
  onOpenDetail,
  onViewAll,
  onClose,
}: SearchPopupOverlayProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const elvPrefs = elvPreferences ?? DEFAULT_ELV_MODE_PREFERENCES;

  const isTv = viewport.formFactor === 'tv';
  const isPortrait = !isTv && viewport.orientation === 'portrait';
  const isTouch = viewport.inputModality === 'touch';

  const dialogRef = useRef<ComponentRef<typeof View> | null>(null);
  const inputRef = useRef<TvTextInputInstance | null>(null);

  useDesktopDialogTrap(dialogRef, visible && !isTv, onClose, { initialFocus: 'container' });

  // Fallback Escape listener when host node is a non-DOM stub (e.g. Jest RN test environment).
  useEffect(() => {
    if (!visible || isTv || (Platform.OS as string) !== 'web') return undefined;
    const node = dialogRef.current as { querySelectorAll?: unknown } | null;
    if (node && typeof node.querySelectorAll === 'function') return undefined;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (
            type: string,
            fn: (e: { key?: unknown; preventDefault?: () => void }) => void,
          ) => void;
          removeEventListener?: (
            type: string,
            fn: (e: { key?: unknown; preventDefault?: () => void }) => void,
          ) => void;
        };
      }
    ).window;
    if (!win?.addEventListener || !win.removeEventListener) return undefined;
    const onKeyDown = (event: { key?: unknown; preventDefault?: () => void }) => {
      if (event.key !== 'Escape') return;
      event.preventDefault?.();
      onClose();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown);
    };
  }, [isTv, onClose, visible]);

  const search = useCatalogSearch({
    catalog,
    refreshToken,
    userStateVersion,
    initialQuery: query,
    onQueryChange,
    initialScope: 'all',
  });

  const sanitizedQuery = sanitizeSearchQuery(search.query);
  const hasQuery = sanitizedQuery.length > 0;
  const elvEnrichActive = isElvFeatureActive(elvPrefs, 'elvEnrichMetadata');

  const existingVodKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const m of search.results.movies) keys.add(m.key);
    for (const s of search.results.series) keys.add(s.key);
    return keys;
  }, [search.results.movies, search.results.series]);

  const aliasSearch = useElvAliasSearch({
    catalog,
    query: search.query,
    scope: 'all',
    enabled: elvEnrichActive,
    refreshToken,
    existingKeys: existingVodKeys,
  });

  const mergedResults = useMemo<SearchResults>(() => {
    if (aliasSearch.movies.length === 0 && aliasSearch.series.length === 0) {
      return search.results;
    }
    const mergeUnique = (base: readonly ItemRow[], extra: readonly ItemRow[]): ItemRow[] => {
      if (extra.length === 0) return [...base];
      const seen = new Set(base.map((i) => i.key));
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
    return [...mergedResults.movies.map((m) => m.key), ...mergedResults.series.map((s) => s.key)];
  }, [elvPrefs.elvModeEnabled, mergedResults.movies, mergedResults.series]);

  const elvEnrichment = useElvEnrichmentForKeys(catalog, searchVodKeys, {
    enabled: elvPrefs.elvModeEnabled,
    lang: i18n.locale,
    catalogRevision: refreshToken,
  });

  const presentedResults = useMemo<SearchResults>(() => {
    if (!elvPrefs.elvModeEnabled) return mergedResults;
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
      ...mergedResults,
      movies: rankByAlias(mergedResults.movies),
      series: rankByAlias(mergedResults.series),
    };
  }, [
    elvEnrichment.enrichmentByKey,
    elvEnrichment.isKeyLookupPending,
    elvPrefs,
    i18n.locale,
    mergedResults,
    sanitizedQuery,
  ]);

  const suggestions = useMemo(
    () => buildSearchPopupSuggestions(presentedResults, sanitizedQuery),
    [presentedResults, sanitizedQuery],
  );
  const moviesSlice = useMemo(
    () => presentedResults.movies.slice(0, SEARCH_POPUP_RAIL_LIMIT),
    [presentedResults.movies],
  );
  const seriesSlice = useMemo(
    () => presentedResults.series.slice(0, SEARCH_POPUP_RAIL_LIMIT),
    [presentedResults.series],
  );
  const liveSlice = useMemo(
    () => presentedResults.live.slice(0, SEARCH_POPUP_RAIL_LIMIT),
    [presentedResults.live],
  );
  const effectiveSearching = search.searching || aliasSearch.searching;
  const totalSliceHits = moviesSlice.length + seriesSlice.length + liveSlice.length;
  const isEmptySettled =
    hasQuery && search.hasSearched && !effectiveSearching && totalSliceHits === 0;

  const navRows = useMemo(
    () =>
      buildSearchPopupNavRows({
        hasClear: search.query.length > 0,
        suggestionCount: hasQuery ? suggestions.length : 0,
        movieCount: hasQuery ? moviesSlice.length : 0,
        seriesCount: hasQuery ? seriesSlice.length : 0,
        liveCount: hasQuery ? liveSlice.length : 0,
        hasViewAll: hasQuery,
      }),
    [
      hasQuery,
      liveSlice.length,
      moviesSlice.length,
      search.query.length,
      seriesSlice.length,
      suggestions.length,
    ],
  );

  const [focusPos, setFocusPos] = useState<SearchPopupFocusPosition>({ rowId: 'input', col: 0 });
  const [editingInput, setEditingInput] = useState(false);
  const focusPosRef = useRef(focusPos);
  focusPosRef.current = focusPos;
  const editingInputRef = useRef(editingInput);
  editingInputRef.current = editingInput;
  const navRowsRef = useRef(navRows);
  navRowsRef.current = navRows;

  useEffect(() => {
    if (!isTv && visible) {
      inputRef.current?.focus?.();
    }
  }, [isTv, visible]);

  // Defer native TV EditText focus until editable/focusable commit on layout.
  useLayoutEffect(() => {
    if (isTv && visible && editingInput) {
      inputRef.current?.focus?.();
    }
  }, [editingInput, isTv, visible]);

  useEffect(() => {
    const cur = focusPosRef.current;
    const matched = navRows.find((r) => r.id === cur.rowId);
    if (!matched) {
      const fallback = navRows[0] ?? { id: 'input' as const, count: 1 };
      const next = { rowId: fallback.id, col: 0 };
      focusPosRef.current = next;
      setFocusPos(next);
      return;
    }
    const clampedCol = Math.min(Math.max(0, cur.col), Math.max(0, matched.count - 1));
    if (clampedCol !== cur.col) {
      const next = { rowId: matched.id, col: clampedCol };
      focusPosRef.current = next;
      setFocusPos(next);
    }
  }, [navRows]);

  const handlePickMovieOrSeries = useCallback(
    (item: ItemRow) => {
      const target = detailTargetFromItem(item);
      if (!target) return;
      onClose();
      onOpenDetail(target);
    },
    [onClose, onOpenDetail],
  );

  const handlePickLive = useCallback(
    (item: ItemRow) => {
      onClose();
      onPlay(buildLiveSearchPlayTarget(item));
    },
    [onClose, onPlay],
  );

  const handleViewAllPress = useCallback(() => {
    const currentQuery = search.query;
    onClose();
    onViewAll(currentQuery);
  }, [onClose, onViewAll, search.query]);

  const handleInputSubmit = useCallback(() => {
    if (!isTv) return;
    editingInputRef.current = false;
    setEditingInput(false);
  }, [isTv]);

  const stateCallbacksRef = useRef({
    suggestions,
    moviesSlice,
    seriesSlice,
    liveSlice,
    setQuery: search.setQuery,
    clearSearch: search.clearSearch,
    handlePickMovieOrSeries,
    handlePickLive,
    handleViewAllPress,
    onClose,
  });
  stateCallbacksRef.current = {
    suggestions,
    moviesSlice,
    seriesSlice,
    liveSlice,
    setQuery: search.setQuery,
    clearSearch: search.clearSearch,
    handlePickMovieOrSeries,
    handlePickLive,
    handleViewAllPress,
    onClose,
  };

  const handleTvKey = useCallback((event: KeyEvent): boolean => {
    if (event.kind === 'press' && event.key === 'back') {
      if (editingInputRef.current) {
        inputRef.current?.blur?.();
        editingInputRef.current = false;
        setEditingInput(false);
        return true;
      }
      stateCallbacksRef.current.onClose();
      return true;
    }

    if (event.kind === 'press' && event.key === 'select') {
      const cur = focusPosRef.current;
      const cb = stateCallbacksRef.current;
      if (cur.rowId === 'input' && cur.col === 0) {
        editingInputRef.current = true;
        setEditingInput(true);
        return true;
      }
      if (cur.rowId === 'input' && cur.col === 1) {
        cb.clearSearch();
        return true;
      }
      if (cur.rowId === 'suggestions') {
        const s = cb.suggestions[cur.col];
        if (s) cb.setQuery(s.title);
        return true;
      }
      if (cur.rowId === 'movies') {
        const m = cb.moviesSlice[cur.col];
        if (m) cb.handlePickMovieOrSeries(m);
        return true;
      }
      if (cur.rowId === 'series') {
        const s = cb.seriesSlice[cur.col];
        if (s) cb.handlePickMovieOrSeries(s);
        return true;
      }
      if (cur.rowId === 'live') {
        const ch = cb.liveSlice[cur.col];
        if (ch) cb.handlePickLive(ch);
        return true;
      }
      if (cur.rowId === 'viewAll') {
        cb.handleViewAllPress();
        return true;
      }
      return true;
    }

    if (event.kind !== 'press' && event.kind !== 'repeat') return false;
    if (
      event.key === 'up' ||
      event.key === 'down' ||
      event.key === 'left' ||
      event.key === 'right'
    ) {
      if (editingInputRef.current) {
        inputRef.current?.blur?.();
        editingInputRef.current = false;
        setEditingInput(false);
      }
      const res = stepSearchPopupFocus(navRowsRef.current, focusPosRef.current, event.key);
      if (res.position) {
        focusPosRef.current = res.position;
        setFocusPos(res.position);
      }
      return true;
    }
    return false;
  }, []);

  const topOffset = viewport.safeArea.top + (isTv ? Math.max(20, viewport.overscan.y) : 14);
  const horizontalPad = isTv ? Math.max(24, viewport.overscan.x) : isPortrait ? 12 : 24;
  const cursor = webCursorPointer();

  const inputFocused = isTv && focusPos.rowId === 'input' && focusPos.col === 0;
  const clearFocused = isTv && focusPos.rowId === 'input' && focusPos.col === 1;
  const backdropWebProps =
    (Platform.OS as string) === 'web' ? ({ tabIndex: -1 } as Record<string, unknown>) : undefined;

  return (
    <View
      ref={dialogRef}
      testID="search-popup-overlay"
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        styles.overlay,
        {
          paddingTop: topOffset,
          paddingHorizontal: horizontalPad,
        },
      ]}
    >
      {isTv ? <PopupTvKeyBridge onEvent={handleTvKey} /> : null}

      <Pressable
        testID="search-popup-backdrop"
        accessible={!isTv}
        focusable={false}
        {...backdropWebProps}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />

      <View
        testID="search-popup-panel"
        role="dialog"
        aria-modal
        aria-label={i18n.t('search.popup.title')}
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
            padding: isPortrait ? theme.spacing.md : theme.spacing.lg,
          },
          webBackdropBlur(28),
          webShadow('0 24px 64px rgba(0, 0, 0, 0.85)'),
        ]}
      >
        <TextEntryBoundary>
          <View
            style={[
              styles.searchBar,
              {
                backgroundColor: theme.colors.bgSurface,
                borderColor: inputFocused ? theme.colors.focusRingColor : theme.colors.chipBorder,
                borderWidth: inputFocused ? theme.focus.ringWidth : 1,
                borderRadius: theme.radius.pill,
                minHeight: isTouch || isPortrait ? 46 : 44,
              },
            ]}
          >
            <Icon name="search" size={18} color={theme.colors.textMuted} />
            <TvTextInput
              ref={inputRef}
              testID="search-popup-input"
              accessibilityLabel={i18n.t('search.popup.title')}
              value={search.query}
              onChangeText={search.setQuery}
              onSubmitEditing={handleInputSubmit}
              onBlur={() => {
                if (!isTv) return;
                editingInputRef.current = false;
                setEditingInput(false);
              }}
              editable={!isTv || editingInput}
              focusable={!isTv || editingInput}
              autoFocus={!isTv}
              placeholder={i18n.t('search.placeholder')}
              placeholderTextColor={theme.colors.textMuted}
              maxLength={MAX_SEARCH_QUERY_CHARS}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, theme.typography.body, { color: theme.colors.textPrimary }]}
            />
            {search.query.length > 0 ? (
              <Pressable
                testID="search-popup-clear"
                accessibilityRole="button"
                accessibilityLabel={i18n.t('search.clear')}
                focusable={!isTv}
                onPress={search.clearSearch}
                style={(state) => {
                  const hovered = Boolean((state as { hovered?: boolean }).hovered);
                  return [
                    styles.clearButton,
                    cursor,
                    {
                      borderWidth: clearFocused ? theme.focus.ringWidth : 0,
                      borderColor: clearFocused ? theme.colors.focusRingColor : 'transparent',
                      backgroundColor: clearFocused ? theme.colors.focusFill : 'transparent',
                      borderRadius: theme.radius.button,
                      opacity: hovered ? 0.85 : 1,
                    },
                  ];
                }}
              >
                <Text
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                >
                  {i18n.t('search.clear')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </TextEntryBoundary>

        {hasQuery ? (
          <SearchPopupRails
            isTv={isTv}
            isPortrait={isPortrait}
            sanitizedQuery={sanitizedQuery}
            suggestions={suggestions}
            moviesSlice={moviesSlice}
            seriesSlice={seriesSlice}
            liveSlice={liveSlice}
            isEmptySettled={isEmptySettled}
            focusPos={focusPos}
            onPickSuggestion={search.setQuery}
            onPickMovieOrSeries={handlePickMovieOrSeries}
            onPickLive={handlePickLive}
            onViewAllPress={handleViewAllPress}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    zIndex: 45,
    alignItems: 'center',
  },
  panel: {
    width: '100%',
    maxWidth: 960,
    maxHeight: '84%',
    borderWidth: 1,
    gap: 12,
    shadowColor: 'rgba(0, 0, 0, 1)',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.65,
    shadowRadius: 32,
    elevation: 20,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    paddingHorizontal: 16,
    gap: 10,
  },
  input: {
    flex: 1,
    minHeight: 38,
    paddingVertical: 6,
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
