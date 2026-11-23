import type {
  SearchProgrammeHit,
  SearchScope,
  SearchSuggestion,
  SearchSuggestionKind,
} from '@elv/data';
import {
  CtaButton,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  Icon,
  IconButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  TvTextInput,
  type TvTextInputInstance,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useTvKeyInterceptor,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type MutableRefObject,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouteActive } from '../shared';
import { formatSearchProgrammeTime, MAX_SEARCH_QUERY_CHARS, SEARCH_SCOPES } from './search-model';

/** Mounts the 10-ft TV key interpreter and focus anchor while `SearchScreen` owns focus. */
export function SearchTvKeyBridge({
  onEvent,
  preferredFocus = true,
}: {
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
  readonly preferredFocus?: boolean;
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return (
    <TvFocusAnchor
      testID="search-tv-focus-anchor"
      hasTVPreferredFocus={routeActive && preferredFocus}
    />
  );
}

interface RecentChipItemProps {
  readonly term: string;
  readonly index: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelect: (term: string) => void;
}

const RecentChipItem = memo(function RecentChipItemInner({
  term,
  index,
  isTv,
  focused,
  onSelect,
}: RecentChipItemProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => onSelect(term), [onSelect, term]);

  return (
    <Pressable
      testID={`search-recent-${index}`}
      accessibilityRole="button"
      accessibilityLabel={term}
      focusable={!isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.recentButton,
        webTransition(theme, 'background-color, border-color, opacity'),
        webCursorPointer(),
        {
          borderRadius: 4,
          backgroundColor: focused ? theme.colors.focusFill : theme.colors.chipBg,
          borderColor: focused ? theme.colors.focusRingColor : theme.colors.chipBorder,
          borderWidth: focused ? theme.focus.ringWidth : 1,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          theme.typography.caption,
          { color: focused ? theme.colors.textPrimary : theme.colors.textSecondary },
        ]}
      >
        {term}
      </Text>
    </Pressable>
  );
});

interface SuggestionChipItemProps {
  readonly suggestion: SearchSuggestion;
  readonly index: number;
  readonly kindLabel: string;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelect: (suggestion: SearchSuggestion) => void;
}

const SuggestionChipItem = memo(function SuggestionChipItemInner({
  suggestion,
  index,
  kindLabel,
  isTv,
  focused,
  onSelect,
}: SuggestionChipItemProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => onSelect(suggestion), [onSelect, suggestion]);

  return (
    <Pressable
      testID={`search-suggestion-${index}`}
      accessibilityRole="button"
      accessibilityLabel={`${suggestion.label}, ${kindLabel}`}
      focusable={!isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.suggestionCard,
        webTransition(theme, 'background-color, border-color, opacity'),
        webCursorPointer(),
        {
          borderRadius: theme.radius.button,
          backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
          borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
          borderWidth: focused ? theme.focus.ringWidth : 1,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        testID={`search-suggestion-${index}-label`}
        numberOfLines={1}
        style={[
          theme.typography.caption,
          {
            color: theme.colors.textPrimary,
            fontWeight: '600',
          },
        ]}
      >
        {suggestion.label}
      </Text>
      <Text
        testID={`search-suggestion-${index}-kind`}
        numberOfLines={1}
        style={[
          theme.typography.micro,
          { color: focused ? theme.colors.textSecondary : theme.colors.textMuted },
        ]}
      >
        {kindLabel}
      </Text>
    </Pressable>
  );
});

/** Props of {@link SearchHeaderBar}. */
export interface SearchHeaderBarProps {
  readonly query: string;
  readonly scope: SearchScope;
  readonly scopeLabels: Readonly<Record<SearchScope, string>>;
  readonly hasQuery: boolean;
  readonly hasSearched: boolean;
  readonly searching: boolean;
  readonly totalVisibleHits: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly inputRef: MutableRefObject<TvTextInputInstance | null>;
  readonly allowNativeEdit: boolean;
  readonly inputFocused: boolean;
  readonly inputTvFocused: boolean;
  readonly clearTvFocused: boolean;
  readonly focusedScopeIndex: number | null;
  readonly onChangeQuery: (next: string) => void;
  readonly onInputFocus: () => void;
  readonly onInputBlur: () => void;
  readonly onInputKeyPress?: (event: unknown) => void;
  readonly onInputSubmit: (event?: unknown) => void;
  readonly onClearSearch: () => void;
  readonly onSelectScope: (next: SearchScope) => void;
}

/** Cinema Quietude search input bar, clear action, scope filter chips, and tabular result count. */
export const SearchHeaderBar = memo(function SearchHeaderBarInner({
  query,
  scope,
  scopeLabels,
  hasQuery,
  hasSearched,
  searching,
  totalVisibleHits,
  padX,
  isTv,
  isTouch,
  inputRef,
  allowNativeEdit,
  inputFocused,
  inputTvFocused,
  clearTvFocused,
  focusedScopeIndex,
  onChangeQuery,
  onInputFocus,
  onInputBlur,
  onInputKeyPress,
  onInputSubmit,
  onClearSearch,
  onSelectScope,
}: SearchHeaderBarProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const inputBorderColor = inputTvFocused
    ? theme.colors.focusRingColor
    : inputFocused
      ? theme.colors.hoverRingBorder
      : theme.colors.chipBorder;
  const inputTransition = webTransition(theme, 'border-color, background-color');

  const scopeItems = useMemo<readonly EditorialCategoryItem[]>(
    () =>
      SEARCH_SCOPES.map((itemScope) => ({
        id: itemScope,
        label: scopeLabels[itemScope],
        testID: `search-scope-${itemScope}`,
      })),
    [scopeLabels],
  );

  const handleSelectScopeId = useCallback(
    (id: string) => onSelectScope(id as SearchScope),
    [onSelectScope],
  );

  return (
    <View style={{ paddingHorizontal: padX }}>
      <Text
        numberOfLines={1}
        style={[theme.typography.h1, { color: theme.colors.textPrimary, marginBottom: 12 }]}
      >
        {i18n.t('search.title')}
      </Text>

      <View
        style={[
          styles.searchBar,
          {
            backgroundColor: theme.colors.bgSurface,
            borderColor: inputBorderColor,
            borderWidth: inputTvFocused ? theme.focus.ringWidth : 1,
            borderRadius: theme.radius.card,
            minHeight: isTouch ? 48 : 44,
          },
          inputTransition,
        ]}
      >
        <Icon name="search" size={18} color={theme.colors.textMuted} />
        <TvTextInput
          ref={inputRef}
          testID="search-input"
          accessibilityLabel={i18n.t('search.title')}
          value={query}
          onChangeText={onChangeQuery}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          onKeyPress={onInputKeyPress}
          onSubmitEditing={onInputSubmit}
          editable={allowNativeEdit}
          focusable={allowNativeEdit}
          placeholder={i18n.t('search.placeholder')}
          placeholderTextColor={theme.colors.textMuted}
          maxLength={MAX_SEARCH_QUERY_CHARS}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, theme.typography.body, { color: theme.colors.textPrimary }]}
        />
        {query.length > 0 ? (
          <IconButton
            testID="search-clear"
            icon="close"
            size={40}
            accessibilityLabel={i18n.t('search.clear')}
            focusable={!isTv}
            focused={clearTvFocused}
            onPress={onClearSearch}
          />
        ) : null}
      </View>

      <View style={styles.scopeBarWrap}>
        <EditorialCategoryBar
          testID="search-scope-bar"
          items={scopeItems}
          activeId={scope}
          onSelect={handleSelectScopeId}
          isTv={isTv}
          focusedIndex={focusedScopeIndex}
          padX={0}
          rightAccessory={
            hasQuery && hasSearched ? (
              <Text
                testID="search-results-summary"
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textMuted },
                ]}
              >
                {searching
                  ? i18n.t('search.searching')
                  : i18n.t('search.resultsSummary', { count: totalVisibleHits })}
              </Text>
            ) : undefined
          }
        />
      </View>
    </View>
  );
});

/** Props of {@link SearchIdlePanel}. */
export interface SearchIdlePanelProps {
  readonly recentSearches: readonly string[];
  readonly suggestions?: readonly SearchSuggestion[];
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedRecentIndex: number | null;
  readonly focusedSuggestionIndex?: number | null;
  readonly onSelectRecent: (term: string) => void;
  readonly onClearRecent: () => void;
  readonly onSelectSuggestion?: (suggestion: SearchSuggestion) => void;
}

/** Recent-search chip list, on-device quick picks (`#397`), and quiet prompt when query is empty. */
export const SearchIdlePanel = memo(function SearchIdlePanelInner({
  recentSearches,
  suggestions = [],
  padX,
  isTv,
  focusedRecentIndex,
  focusedSuggestionIndex = null,
  onSelectRecent,
  onClearRecent,
  onSelectSuggestion,
}: SearchIdlePanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const suggestionKindLabels = useMemo<Readonly<Record<SearchSuggestionKind, string>>>(
    () => ({
      favorite: i18n.t('search.suggestionFavorites'),
      recent: i18n.t('search.suggestionRecent'),
      category: i18n.t('search.suggestionCategory'),
    }),
    [i18n],
  );

  const handleSelectSuggestion = useCallback(
    (suggestion: SearchSuggestion) => {
      if (onSelectSuggestion) {
        onSelectSuggestion(suggestion);
      } else {
        onSelectRecent(suggestion.query || suggestion.label);
      }
    },
    [onSelectRecent, onSelectSuggestion],
  );

  return (
    <View style={{ paddingHorizontal: padX }}>
      {recentSearches.length > 0 ? (
        <View testID="search-recent-section" style={styles.recentSection}>
          <View style={styles.recentHeader}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('search.recentTitle')}
            </Text>
            <CtaButton
              testID="search-clear-recent"
              label={i18n.t('search.clearHistory')}
              variant="ghost"
              focusable={!isTv}
              focused={focusedRecentIndex === recentSearches.length}
              onPress={onClearRecent}
            />
          </View>
          <View style={[styles.recentChips, { gap: theme.spacing.xs }]}>
            {recentSearches.map((term, idx) => (
              <RecentChipItem
                key={term}
                term={term}
                index={idx}
                isTv={isTv}
                focused={focusedRecentIndex === idx}
                onSelect={onSelectRecent}
              />
            ))}
          </View>
        </View>
      ) : null}

      {suggestions.length > 0 ? (
        <View testID="search-suggestions-section" style={styles.recentSection}>
          <View style={styles.recentHeader}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('search.suggestionsTitle')}
            </Text>
          </View>
          <View style={[styles.recentChips, { gap: theme.spacing.xs }]}>
            {suggestions.map((suggestion, idx) => (
              <SuggestionChipItem
                key={`${suggestion.kind}:${suggestion.itemKey ?? suggestion.categoryId ?? suggestion.label}`}
                suggestion={suggestion}
                index={idx}
                kindLabel={suggestionKindLabels[suggestion.kind]}
                isTv={isTv}
                focused={focusedSuggestionIndex === idx}
                onSelect={handleSelectSuggestion}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View testID="search-prompt" style={styles.stateBox}>
        <Icon name="search" size={28} color={theme.colors.textMuted} />
        <Text style={[theme.typography.h2, styles.stateTitle, { color: theme.colors.textPrimary }]}>
          {i18n.t('search.promptTitle')}
        </Text>
        <Text
          style={[theme.typography.body, styles.stateDesc, { color: theme.colors.textSecondary }]}
        >
          {i18n.t('search.promptDescription')}
        </Text>
      </View>
    </View>
  );
});

/** Props of {@link SearchEmptyPanel}. */
export interface SearchEmptyPanelProps {
  readonly query: string;
  readonly padX: number;
  readonly isTv: boolean;
  readonly clearFocused: boolean;
  readonly onClearSearch: () => void;
}

/** Constructive empty state with a primary `Clear search` CTA when a query returns zero hits. */
export const SearchEmptyPanel = memo(function SearchEmptyPanelInner({
  query,
  padX,
  isTv,
  clearFocused,
  onClearSearch,
}: SearchEmptyPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <View testID="search-empty" style={[styles.stateBox, { paddingHorizontal: padX }]}>
      <Text style={[theme.typography.h2, styles.stateTitle, { color: theme.colors.textPrimary }]}>
        {i18n.t('search.noResultsTitle', { query })}
      </Text>
      <Text
        style={[theme.typography.body, styles.stateDesc, { color: theme.colors.textSecondary }]}
      >
        {i18n.t('search.noResultsDescription')}
      </Text>
      <View style={styles.stateAction}>
        <CtaButton
          testID="search-empty-clear"
          label={i18n.t('search.clear')}
          focusable={!isTv}
          focused={clearFocused}
          onPress={onClearSearch}
        />
      </View>
    </View>
  );
});

function SearchProgrammeTvKeyTrap({
  onInput,
}: {
  readonly onInput: Parameters<typeof useTvKeyInterceptor>[0];
}): null {
  useTvKeyInterceptor(onInput);
  return null;
}

/** Props of {@link SearchProgrammeDetailOverlay}. */
export interface SearchProgrammeDetailOverlayProps {
  readonly programme: SearchProgrammeHit | null;
  readonly isTv: boolean;
  readonly onTune: (programme: SearchProgrammeHit) => void;
  readonly onClose: () => void;
  readonly nowMs?: number;
}

/**
 * In-tree Cinema Quietude Programme Info overlay for upcoming EPG search hits (`#397`).
 * Never uses RN `<Modal>`, traps 10-ft TV D-pad keys, and offers direct `Tune to channel`.
 */
export function SearchProgrammeDetailOverlay({
  programme,
  isTv,
  onTune,
  onClose,
  nowMs,
}: SearchProgrammeDetailOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const [focusedIdx, setFocusedIdx] = useState(0);
  const focusedIdxRef = useRef(0);
  focusedIdxRef.current = focusedIdx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset focused action when opened for a programme
  useEffect(() => {
    if (programme !== null) {
      focusedIdxRef.current = 0;
      setFocusedIdx(0);
    }
  }, [programme?.channelKey, programme?.start]);

  const handleTvTrap = useCallback(
    (input: Parameters<Parameters<typeof useTvKeyInterceptor>[0]>[0]): boolean => {
      if (input.action !== 'down' && input.action !== 'press') return true;
      if (input.key === 'back') {
        onClose();
        return true;
      }
      if (input.key === 'left' || input.key === 'up') {
        focusedIdxRef.current = 0;
        setFocusedIdx(0);
        return true;
      }
      if (input.key === 'right' || input.key === 'down') {
        focusedIdxRef.current = 1;
        setFocusedIdx(1);
        return true;
      }
      if (input.key === 'select') {
        if (focusedIdxRef.current === 0 && programme !== null) {
          onClose();
          onTune(programme);
        } else {
          onClose();
        }
        return true;
      }
      return true;
    },
    [onClose, onTune, programme],
  );

  useEffect(() => {
    if (programme === null || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        onClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [onClose, programme]);

  if (programme === null) return null;

  const description = programme.description?.trim() || i18n.t('epg.noDescription');
  const timeRange = `${formatSearchProgrammeTime(programme.start)} – ${formatSearchProgrammeTime(programme.stop)}`;
  const effectiveNowMs = nowMs ?? Date.now();
  const isEnded = !programme.isLiveNow && programme.stop < effectiveNowMs;
  const statusBadgeLabel = programme.isLiveNow
    ? i18n.t('search.airingNow')
    : isEnded
      ? null
      : i18n.t('search.upcoming');

  return (
    <View testID="search-epg-detail-modal" style={styles.modalRoot}>
      {isTv ? <SearchProgrammeTvKeyTrap onInput={handleTvTrap} /> : null}
      <Pressable
        testID="search-epg-detail-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        accessibilityRole="summary"
        style={[
          styles.modalCard,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.modalHeader}>
          <Text
            testID="search-epg-detail-channel"
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {programme.channelName}
          </Text>
          <Text
            testID="search-epg-detail-title"
            style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
          >
            {programme.title}
          </Text>
        </View>

        <View style={styles.modalPillsRow}>
          <MicroPill testID="search-epg-detail-time" label={timeRange} tone="neutral" />
          {statusBadgeLabel !== null ? (
            <MicroPill
              testID="search-epg-detail-badge"
              label={statusBadgeLabel}
              tone={programme.isLiveNow ? 'live' : 'accent'}
            />
          ) : null}
          {programme.category ? (
            <MicroPill
              testID="search-epg-detail-category"
              label={programme.category}
              tone="neutral"
            />
          ) : null}
        </View>

        <ScrollView style={styles.modalDescScroll} showsVerticalScrollIndicator={false}>
          <Text
            testID="search-epg-detail-description"
            style={[
              theme.typography.body,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {description}
          </Text>
        </ScrollView>

        <View style={styles.modalActionsRow}>
          <CtaButton
            testID="search-epg-detail-tune"
            variant="primary"
            icon="play"
            label={i18n.t('epg.tuneChannel')}
            focusable={!isTv}
            focused={isTv && focusedIdx === 0}
            onPress={() => {
              onClose();
              onTune(programme);
            }}
          />
          <CtaButton
            testID="search-epg-detail-close"
            variant="secondary"
            label={i18n.t('player.close')}
            focusable={!isTv}
            focused={isTv && focusedIdx === 1}
            onPress={onClose}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 6,
    gap: 10,
  },
  input: { flex: 1, minHeight: 40, paddingVertical: 8 },
  scopeBarWrap: { marginTop: 10 },
  recentButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 7,
    justifyContent: 'center',
    alignItems: 'center',
  },
  suggestionCard: {
    minHeight: 42,
    paddingHorizontal: 14,
    paddingVertical: 8,
    justifyContent: 'center',
    gap: 2,
  },
  recentSection: { marginTop: 22 },
  recentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  recentChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  stateBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 56 },
  stateTitle: { marginTop: 12, textAlign: 'center' },
  stateDesc: { marginTop: 8, maxWidth: 460, textAlign: 'center' },
  stateAction: { marginTop: 20 },
  modalRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 50,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 540,
    maxHeight: '82%',
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  modalHeader: { gap: 4 },
  modalPillsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  modalDescScroll: { maxHeight: 200 },
  modalActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingTop: 4,
  },
});
