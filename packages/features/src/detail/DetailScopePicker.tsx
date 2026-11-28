import type { SeasonRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import {
  AdaptiveSheet,
  CtaButton,
  Icon,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

/** Operation mode of {@link DetailScopePicker}. */
export type DetailScopePickerMode = 'watched' | 'download';

/** Return type accepted by {@link DetailScopePicker} apply callbacks (`false` keeps picker open with inline error). */
type ScopeApplyResult = void | boolean | Promise<boolean> | Promise<void>;

/** Props of {@link DetailScopePicker}. */
export interface DetailScopePickerProps {
  readonly visible: boolean;
  readonly mode: DetailScopePickerMode;
  readonly seriesTitle: string;
  readonly seasons: readonly SeasonRow[];
  readonly defaultSeason: number | null;
  readonly entireSeriesWatched?: boolean;
  readonly isSeasonWatched?: (season: number) => boolean;
  readonly onApplyEntireSeries: (nextWatched?: boolean) => ScopeApplyResult;
  readonly onApplySeason: (season: number, nextWatched?: boolean) => ScopeApplyResult;
  readonly onClose: () => void;
}

type FocusSlotId = 'entire-series' | 'season-select' | 'season-apply';

function ScopePickerTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="detail-scope-picker-tv-anchor" hasTVPreferredFocus />;
}

/**
 * Shared Cinema Quietude v2 TV-safe scope picker (`UI_UX_PHILOSOPHY.md` §3.2) for Series Hero
 * `✓` (Watched) and `↓` (Download) actions. Renders inside `AdaptiveSheet` (zero `<Modal>`),
 * offering **Entire Series** and an expandable **Season** dropdown + one-click apply CTA with
 * Escape, backdrop click, and full 10-ft TV D-pad Up/Down/Left/Right/Select/Back navigation.
 */
export const DetailScopePicker = memo(function DetailScopePickerInner({
  visible,
  mode,
  seriesTitle,
  seasons,
  defaultSeason,
  entireSeriesWatched = false,
  isSeasonWatched,
  onApplyEntireSeries,
  onApplySeason,
  onClose,
}: DetailScopePickerProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.inputModality === 'tv';
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');

  const resolvedDefaultSeason = useMemo(() => {
    if (defaultSeason !== null && seasons.some((s) => s.season === defaultSeason)) {
      return defaultSeason;
    }
    return seasons[0]?.season ?? null;
  }, [defaultSeason, seasons]);

  const [pickedSeason, setPickedSeason] = useState<number | null>(resolvedDefaultSeason);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [focusedSlot, setFocusedSlot] = useState<FocusSlotId>('entire-series');
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorVisible, setErrorVisible] = useState(false);

  const wasVisibleRef = useRef(false);
  const mountedRef = useRef(true);
  const openGenRef = useRef(0);
  const submittingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const justOpened = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!visible) {
      openGenRef.current += 1;
      submittingRef.current = false;
      setSubmitting(false);
      setErrorVisible(false);
      return;
    }
    if (justOpened) {
      openGenRef.current += 1;
      submittingRef.current = false;
      setSubmitting(false);
      setErrorVisible(false);
      setPickedSeason(resolvedDefaultSeason);
      setDropdownOpen(false);
      setFocusedSlot('entire-series');
      setDropdownIndex(
        Math.max(
          0,
          seasons.findIndex((s) => s.season === resolvedDefaultSeason),
        ),
      );
      setHoveredKey(null);
    }
  }, [resolvedDefaultSeason, seasons, visible]);

  useEffect(() => {
    if (visible && pickedSeason === null && resolvedDefaultSeason !== null) {
      setPickedSeason(resolvedDefaultSeason);
    }
  }, [pickedSeason, resolvedDefaultSeason, visible]);

  const hasSeasons = seasons.length > 0 && pickedSeason !== null;
  const entireSeriesDisabled = submitting || (mode === 'download' && seasons.length === 0);
  const focusSlots = useMemo<readonly FocusSlotId[]>(
    () => (hasSeasons ? ['entire-series', 'season-select', 'season-apply'] : ['entire-series']),
    [hasSeasons],
  );

  const selectedSeasonWatched =
    mode === 'watched' && pickedSeason !== null
      ? (isSeasonWatched?.(pickedSeason) ?? false)
      : false;

  const runApply = useCallback(
    async (task: () => ScopeApplyResult) => {
      if (submittingRef.current) return;
      const gen = openGenRef.current;
      submittingRef.current = true;
      setSubmitting(true);
      setErrorVisible(false);
      try {
        const outcome = await task();
        if (!mountedRef.current || openGenRef.current !== gen) return;
        submittingRef.current = false;
        setSubmitting(false);
        if (outcome === false) {
          setErrorVisible(true);
          return;
        }
        onClose();
      } catch {
        if (!mountedRef.current || openGenRef.current !== gen) return;
        submittingRef.current = false;
        setSubmitting(false);
        setErrorVisible(true);
      }
    },
    [onClose],
  );

  const handleApplyEntire = useCallback(() => {
    if (submittingRef.current || (mode === 'download' && seasons.length === 0)) return;
    void runApply(() => onApplyEntireSeries(mode === 'watched' ? !entireSeriesWatched : undefined));
  }, [entireSeriesWatched, mode, onApplyEntireSeries, runApply, seasons.length]);

  const handleApplyPickedSeason = useCallback(() => {
    if (submittingRef.current || pickedSeason === null) return;
    const seasonToApply = pickedSeason;
    const nextWatched = mode === 'watched' ? !selectedSeasonWatched : undefined;
    void runApply(() => onApplySeason(seasonToApply, nextWatched));
  }, [mode, onApplySeason, pickedSeason, runApply, selectedSeasonWatched]);

  const handleToggleDropdown = useCallback(() => {
    if (!hasSeasons || submittingRef.current) return;
    setDropdownOpen((prev) => {
      if (!prev) {
        const curIdx = Math.max(
          0,
          seasons.findIndex((s) => s.season === pickedSeason),
        );
        setDropdownIndex(curIdx);
      }
      return !prev;
    });
  }, [hasSeasons, pickedSeason, seasons]);

  const handlePickSeasonOption = useCallback((seasonNum: number) => {
    setPickedSeason(seasonNum);
    setDropdownOpen(false);
    setFocusedSlot('season-apply');
  }, []);

  const stateRef = useRef({
    dropdownOpen,
    dropdownIndex,
    focusedSlot,
    focusSlots,
    pickedSeason,
    seasons,
    handleApplyEntire,
    handleApplyPickedSeason,
    handleToggleDropdown,
    handlePickSeasonOption,
    onClose,
  });
  stateRef.current = {
    dropdownOpen,
    dropdownIndex,
    focusedSlot,
    focusSlots,
    pickedSeason,
    seasons,
    handleApplyEntire,
    handleApplyPickedSeason,
    handleToggleDropdown,
    handlePickSeasonOption,
    onClose,
  };

  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return undefined;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (type: string, fn: (ev: unknown) => void) => void;
          removeEventListener?: (type: string, fn: (ev: unknown) => void) => void;
        };
      }
    ).window;
    if (typeof win?.addEventListener !== 'function') return undefined;

    const handleKeyDown = (ev: unknown) => {
      const key = (ev as { key?: string } | null)?.key;
      if (key !== 'Escape') return;
      if (stateRef.current.dropdownOpen) {
        setDropdownOpen(false);
        return;
      }
      stateRef.current.onClose();
    };
    win.addEventListener('keydown', handleKeyDown);
    return () => {
      win.removeEventListener?.('keydown', handleKeyDown);
    };
  }, [visible]);

  const handleTvKey = useCallback((event: KeyEvent): boolean => {
    const isDirectional =
      event.key === 'up' || event.key === 'down' || event.key === 'left' || event.key === 'right';
    if (isDirectional) {
      if (event.kind !== 'press' && event.kind !== 'repeat') return true;
    } else if (event.kind !== 'press') {
      return true;
    }
    const s = stateRef.current;

    if (s.dropdownOpen) {
      if (event.key === 'back') {
        setDropdownOpen(false);
        setFocusedSlot('season-select');
        return true;
      }
      if (event.key === 'up') {
        setDropdownIndex((idx) => Math.max(0, idx - 1));
        return true;
      }
      if (event.key === 'down') {
        setDropdownIndex((idx) => Math.min(Math.max(0, s.seasons.length - 1), idx + 1));
        return true;
      }
      if (event.key === 'select') {
        const chosen = s.seasons[s.dropdownIndex];
        if (chosen) s.handlePickSeasonOption(chosen.season);
        return true;
      }
      return true;
    }

    if (event.key === 'back') {
      s.onClose();
      return true;
    }
    if (event.key === 'up' || event.key === 'down') {
      const idx = Math.max(0, s.focusSlots.indexOf(s.focusedSlot));
      const nextIdx =
        event.key === 'down' ? Math.min(s.focusSlots.length - 1, idx + 1) : Math.max(0, idx - 1);
      const next = s.focusSlots[nextIdx];
      if (next) setFocusedSlot(next);
      return true;
    }
    if (
      s.focusedSlot === 'season-select' &&
      (event.key === 'left' || event.key === 'right') &&
      s.seasons.length > 1
    ) {
      const curIdx = Math.max(
        0,
        s.seasons.findIndex((row) => row.season === s.pickedSeason),
      );
      const nextIdx =
        event.key === 'right'
          ? (curIdx + 1) % s.seasons.length
          : (curIdx - 1 + s.seasons.length) % s.seasons.length;
      const nextSeason = s.seasons[nextIdx];
      if (nextSeason) setPickedSeason(nextSeason.season);
      return true;
    }
    if (event.key === 'select') {
      if (submittingRef.current) return true;
      if (s.focusedSlot === 'entire-series') s.handleApplyEntire();
      else if (s.focusedSlot === 'season-select') s.handleToggleDropdown();
      else if (s.focusedSlot === 'season-apply') s.handleApplyPickedSeason();
      return true;
    }
    return true;
  }, []);

  if (!visible) return null;

  const sheetTitle =
    mode === 'watched'
      ? i18n.t('detail.scopePicker.watchedTitle')
      : i18n.t('detail.scopePicker.downloadTitle');
  const entireActionSubtitle =
    mode === 'watched'
      ? entireSeriesWatched
        ? i18n.t('detail.scopePicker.markEntireSeriesUnwatched')
        : i18n.t('detail.scopePicker.markEntireSeriesWatched')
      : i18n.t('detail.scopePicker.downloadEntireSeries');
  const pickedSeasonObj = seasons.find((s) => s.season === pickedSeason);
  const seasonApplyLabel =
    pickedSeason === null
      ? ''
      : mode === 'watched'
        ? selectedSeasonWatched
          ? i18n.t('detail.scopePicker.markSeasonUnwatched', { season: pickedSeason })
          : i18n.t('detail.scopePicker.markSeasonWatched', { season: pickedSeason })
        : i18n.t('detail.scopePicker.downloadSeason', { season: pickedSeason });

  const entireFocused = isTv && !dropdownOpen && focusedSlot === 'entire-series';
  const selectFocused = isTv && !dropdownOpen && focusedSlot === 'season-select';
  const applyFocused = isTv && !dropdownOpen && focusedSlot === 'season-apply';

  return (
    <>
      {isTv ? <ScopePickerTvKeyBridge onEvent={handleTvKey} /> : null}
      <AdaptiveSheet
        visible={visible}
        testID="detail-scope-picker"
        title={sheetTitle}
        popoverWidth={360}
        onDismiss={onClose}
      >
        <Text
          numberOfLines={1}
          style={[
            theme.typography.caption,
            { color: theme.colors.textMuted, marginBottom: theme.spacing.sm },
          ]}
        >
          {seriesTitle}
        </Text>

        <Pressable
          testID="detail-scope-entire-series"
          accessibilityRole="button"
          accessibilityLabel={entireActionSubtitle}
          accessibilityState={{ disabled: entireSeriesDisabled }}
          disabled={entireSeriesDisabled}
          focusable={!isTv && !entireSeriesDisabled}
          onHoverIn={() => setHoveredKey('entire')}
          onHoverOut={() => setHoveredKey((k) => (k === 'entire' ? null : k))}
          onPress={handleApplyEntire}
          style={({ pressed }) => [
            styles.entireCard,
            cursor,
            transition,
            {
              borderRadius: theme.radius.card,
              backgroundColor: entireFocused
                ? theme.colors.focusFill
                : hoveredKey === 'entire' || pressed
                  ? theme.colors.actionGlassHoverBg
                  : theme.colors.bgCard,
              borderColor: entireFocused
                ? theme.colors.focusRingColor
                : mode === 'watched' && entireSeriesWatched
                  ? theme.colors.accent
                  : theme.colors.surfaceBorder,
              padding: theme.spacing.sm,
              gap: theme.spacing.sm,
              opacity: entireSeriesDisabled ? 0.45 : pressed ? 0.88 : 1,
            },
          ]}
        >
          <View
            style={[
              styles.leadingBadge,
              {
                borderRadius: theme.radius.pill,
                backgroundColor:
                  mode === 'watched' && entireSeriesWatched
                    ? theme.colors.accentTint
                    : theme.colors.actionGlassBg,
                borderColor:
                  mode === 'watched' && entireSeriesWatched
                    ? theme.colors.accent
                    : theme.colors.actionGlassBorder,
              },
            ]}
          >
            <Icon
              name={mode === 'watched' ? 'check' : 'download'}
              size={16}
              color={theme.colors.textPrimary}
            />
          </View>
          <View style={styles.entireTextCol}>
            <Text
              numberOfLines={1}
              style={[
                theme.typography.title,
                { color: theme.colors.textPrimary, fontWeight: '600' },
              ]}
            >
              {i18n.t('detail.scopePicker.entireSeries')}
            </Text>
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {entireActionSubtitle}
            </Text>
          </View>
          <Icon name="chevronRight" size={16} color={theme.colors.textMuted} />
          {entireFocused ? (
            <View
              pointerEvents="none"
              testID="detail-scope-entire-series-focus-ring"
              style={[
                styles.focusRing,
                {
                  borderRadius: theme.radius.card + 2,
                  borderWidth: theme.focus.ringWidth,
                  borderColor: theme.colors.focusRingColor,
                },
              ]}
            />
          ) : null}
        </Pressable>

        {hasSeasons && pickedSeason !== null ? (
          <>
            <View
              style={[
                styles.divider,
                {
                  backgroundColor: theme.colors.surfaceBorder,
                  marginVertical: theme.spacing.sm,
                },
              ]}
            />

            <Text
              style={[
                theme.typography.caption,
                {
                  color: theme.colors.textMuted,
                  fontWeight: '600',
                  marginBottom: theme.spacing.xs,
                },
              ]}
            >
              {i18n.t('detail.scopePicker.season')}
            </Text>

            <Pressable
              testID="detail-scope-season-select"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('detail.scopePicker.chooseSeason')}
              accessibilityState={{ expanded: dropdownOpen, disabled: submitting }}
              disabled={submitting}
              focusable={!isTv && !submitting}
              onHoverIn={() => setHoveredKey('season-select')}
              onHoverOut={() => setHoveredKey((k) => (k === 'season-select' ? null : k))}
              onPress={handleToggleDropdown}
              style={({ pressed }) => [
                styles.seasonSelectBtn,
                cursor,
                transition,
                {
                  borderRadius: theme.radius.button,
                  backgroundColor: selectFocused
                    ? theme.colors.focusFill
                    : hoveredKey === 'season-select' || pressed
                      ? theme.colors.actionGlassHoverBg
                      : theme.colors.bgCard,
                  borderColor: dropdownOpen
                    ? theme.colors.accent
                    : selectFocused
                      ? theme.colors.focusRingColor
                      : theme.colors.surfaceBorder,
                  paddingHorizontal: theme.spacing.sm,
                  paddingVertical: theme.spacing.xs + 4,
                  marginBottom: theme.spacing.sm,
                },
              ]}
            >
              <View style={styles.seasonSelectLabelRow}>
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.body,
                    { color: theme.colors.textPrimary, fontWeight: '600' },
                  ]}
                >
                  {i18n.t('detail.seasonOption', { season: pickedSeason })}
                </Text>
                {pickedSeasonObj && pickedSeasonObj.episodeCount > 0 ? (
                  <Text
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    {i18n.t('detail.scopePicker.seasonEpisodesCount', {
                      count: pickedSeasonObj.episodeCount,
                    })}
                  </Text>
                ) : null}
              </View>
              <Icon name="chevronDown" size={16} color={theme.colors.textSecondary} />
              {selectFocused ? (
                <View
                  pointerEvents="none"
                  testID="detail-scope-season-select-focus-ring"
                  style={[
                    styles.focusRing,
                    {
                      borderRadius: theme.radius.button + 2,
                      borderWidth: theme.focus.ringWidth,
                      borderColor: theme.colors.focusRingColor,
                    },
                  ]}
                />
              ) : null}
            </Pressable>

            {dropdownOpen ? (
              <ScrollView
                testID="detail-scope-season-list"
                style={[
                  styles.dropdownList,
                  {
                    borderRadius: theme.radius.button,
                    backgroundColor: theme.colors.bgElevated,
                    borderColor: theme.colors.surfaceBorder,
                    marginBottom: theme.spacing.sm,
                  },
                ]}
              >
                {seasons.map((row, idx) => {
                  const isSelected = row.season === pickedSeason;
                  const isOptionTvFocused = isTv && dropdownIndex === idx;
                  const optKey = `opt-${row.season}`;
                  return (
                    <Pressable
                      key={row.season}
                      testID={`detail-scope-season-option-${row.season}`}
                      accessibilityRole="menuitem"
                      accessibilityLabel={i18n.t('detail.seasonOption', { season: row.season })}
                      accessibilityState={{ selected: isSelected }}
                      focusable={!isTv}
                      onHoverIn={() => setHoveredKey(optKey)}
                      onHoverOut={() => setHoveredKey((k) => (k === optKey ? null : k))}
                      onPress={() => handlePickSeasonOption(row.season)}
                      style={({ pressed }) => [
                        styles.dropdownOption,
                        cursor,
                        transition,
                        {
                          borderRadius: theme.radius.button,
                          backgroundColor: isOptionTvFocused
                            ? theme.colors.focusFill
                            : hoveredKey === optKey || pressed
                              ? theme.colors.actionGlassHoverBg
                              : isSelected
                                ? theme.colors.accentTint
                                : 'transparent',
                        },
                      ]}
                    >
                      <Text
                        numberOfLines={1}
                        style={[
                          theme.typography.caption,
                          {
                            color: isSelected
                              ? theme.colors.textPrimary
                              : theme.colors.textSecondary,
                            fontWeight: isSelected ? '600' : '500',
                          },
                        ]}
                      >
                        {i18n.t('detail.seasonOption', { season: row.season })}
                      </Text>
                      {isSelected ? (
                        <Icon name="check" size={14} color={theme.colors.accent} />
                      ) : null}
                      {isOptionTvFocused ? (
                        <View
                          pointerEvents="none"
                          testID={`detail-scope-season-option-${row.season}-focus-ring`}
                          style={[
                            styles.optionFocusRing,
                            {
                              borderRadius: theme.radius.button,
                              borderWidth: theme.focus.ringWidth,
                              borderColor: theme.colors.focusRingColor,
                            },
                          ]}
                        />
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            <CtaButton
              testID="detail-scope-season-apply"
              variant="primary"
              icon={mode === 'watched' ? 'check' : 'download'}
              label={seasonApplyLabel}
              disabled={submitting}
              focusable={!isTv}
              focused={applyFocused}
              onPress={handleApplyPickedSeason}
              style={styles.applyCta}
            />
          </>
        ) : null}
        {errorVisible ? (
          <Text
            testID="detail-scope-error"
            accessibilityRole="alert"
            style={[
              theme.typography.caption,
              { color: theme.colors.liveColor, marginTop: theme.spacing.sm },
            ]}
          >
            {mode === 'download' ? i18n.t('downloads.statusFailed') : i18n.t('ui.error.title')}
          </Text>
        ) : null}
      </AdaptiveSheet>
    </>
  );
});

const styles = StyleSheet.create({
  entireCard: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    minHeight: 54,
  },
  leadingBadge: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  entireTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  seasonSelectBtn: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    minHeight: 42,
    gap: 8,
  },
  seasonSelectLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  dropdownList: {
    maxHeight: 176,
    borderWidth: 1,
    padding: 4,
  },
  dropdownOption: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 9,
    minHeight: 36,
  },
  applyCta: {
    width: '100%',
    alignSelf: 'stretch',
  },
  focusRing: {
    position: 'absolute',
    top: -3,
    bottom: -3,
    left: -3,
    right: -3,
  },
  optionFocusRing: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    left: -2,
    right: -2,
  },
});
