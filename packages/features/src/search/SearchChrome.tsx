import type { SearchScope } from '@elv/data';
import {
  CtaButton,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  Icon,
  IconButton,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  TvTextInput,
  type TvTextInputInstance,
  useI18n,
  useKeyInterpreter,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type MutableRefObject, memo, type ReactElement, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouteActive } from '../shared';
import { MAX_SEARCH_QUERY_CHARS, SEARCH_SCOPES } from './search-model';

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
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedRecentIndex: number | null;
  readonly onSelectRecent: (term: string) => void;
  readonly onClearRecent: () => void;
}

/** Recent-search chip list and quiet Cinema Quietude prompt displayed when the query is empty. */
export const SearchIdlePanel = memo(function SearchIdlePanelInner({
  recentSearches,
  padX,
  isTv,
  focusedRecentIndex,
  onSelectRecent,
  onClearRecent,
}: SearchIdlePanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

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
              label={i18n.t('search.clearRecent')}
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
});
