import type { KeyEvent } from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  FilterChip,
  Icon,
  type IconName,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, memo, type ReactElement, useCallback, useEffect, useRef } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { CatalogLayoutMetrics, DisplayCategory } from '../shared';
import type { LiveMode } from './live-model';

export { LiveNumberPad, type LiveNumberPadProps } from './LiveNumberPad';

interface ModeOption {
  readonly mode: LiveMode;
  readonly testID: string;
  readonly labelKey: MessageId;
  readonly icon: IconName;
}

const LIVE_MODES: readonly ModeOption[] = [
  { mode: 'watch', testID: 'live-mode-watch', labelKey: 'live.mode.watch', icon: 'play' },
  {
    mode: 'channels',
    testID: 'live-mode-channels',
    labelKey: 'live.mode.channels',
    icon: 'layers',
  },
  { mode: 'epg', testID: 'live-mode-epg', labelKey: 'live.mode.guide', icon: 'list' },
];

const ModePillButton = memo(function ModePillButtonInner(p: {
  readonly option: ModeOption;
  readonly label: string;
  readonly selected: boolean;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focused: boolean;
  readonly onSelect: (mode: LiveMode) => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, transform, opacity');
  const handlePress = useCallback(() => p.onSelect(p.option.mode), [p.onSelect, p.option.mode]);
  const fg = p.selected ? theme.colors.ctaFg : theme.colors.textSecondary;
  const bg = p.selected ? theme.colors.ctaBg : p.focused ? theme.colors.focusFill : 'transparent';

  return (
    <Pressable
      testID={p.option.testID}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityState={{ selected: p.selected }}
      focusable={!p.isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.modePill,
        {
          minHeight: p.isTouch ? 40 : 34,
          ...(p.isTouch ? { minWidth: 40 } : {}),
          borderRadius: theme.radius.pill,
          backgroundColor: bg,
          borderWidth: p.focused ? theme.focus.ringWidth : 0,
          borderColor: p.focused ? theme.colors.focusRingColor : 'transparent',
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: p.focused ? theme.focus.buttonScale : 1 }],
        },
        cursor,
        transition,
      ]}
    >
      <Icon name={p.option.icon} size={14} color={fg} />
      <Text
        numberOfLines={1}
        style={[theme.typography.caption, { color: fg, fontWeight: p.selected ? '700' : '600' }]}
      >
        {p.label}
      </Text>
    </Pressable>
  );
});

/** Props of {@link LiveModeSwitcher}. */
export interface LiveModeSwitcherProps {
  readonly mode: LiveMode;
  readonly onSelectMode: (mode: LiveMode) => void;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focusedIndex?: number | null;
}

/**
 * Unified Cinema Quietude segmented pill switcher (`Watch` | `Channels` | `TV Guide`) keeping all
 * Live TV sub-modes inside a single top-level destination (`UI_UX_PHILOSOPHY.md` §2.1).
 */
export const LiveModeSwitcher = memo(function LiveModeSwitcherInner({
  mode,
  onSelectMode,
  isTv,
  isTouch,
  focusedIndex = null,
}: LiveModeSwitcherProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  return (
    <View
      testID="live-mode-switcher"
      style={[
        styles.modeBar,
        {
          backgroundColor: theme.colors.glassBg,
          borderColor: theme.colors.glassBorder,
          borderRadius: theme.radius.pill,
        },
        webBackdropBlur(12),
      ]}
    >
      {LIVE_MODES.map((opt, idx) => (
        <ModePillButton
          key={opt.mode}
          option={opt}
          label={i18n.t(opt.labelKey)}
          selected={mode === opt.mode}
          isTv={isTv}
          isTouch={isTouch}
          focused={isTv && focusedIndex === idx}
          onSelect={onSelectMode}
        />
      ))}
    </View>
  );
});

const LiveCategoryChip = memo(function LiveCategoryChipInner(p: {
  readonly category: DisplayCategory;
  readonly index: number;
  readonly selected: boolean;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelect: (categoryId: string) => void;
  readonly onMeasureX: (index: number, x: number) => void;
}): ReactElement {
  const handlePress = useCallback(
    () => p.onSelect(p.category.row.id),
    [p.category.row.id, p.onSelect],
  );
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => p.onMeasureX(p.index, e.nativeEvent.layout.x),
    [p.index, p.onMeasureX],
  );
  return (
    <View onLayout={handleLayout}>
      <FilterChip
        testID={`live-cat-chip-${p.index}`}
        label={p.category.label}
        selected={p.selected}
        focusable={!p.isTv}
        focused={p.focused}
        onPress={handlePress}
      />
    </View>
  );
});

/** Props of {@link LiveCategoryBar}. */
export interface LiveCategoryBarProps {
  readonly categories: readonly DisplayCategory[];
  readonly activeCategoryId: string | null;
  readonly channelCount: number;
  readonly layout: CatalogLayoutMetrics;
  readonly focusedChipIndex?: number | null;
  readonly onSelectCategory: (categoryId: string) => void;
}

/** Horizontal live category `FilterChip` bar with TV auto-scroll and tabular channel count. */
export const LiveCategoryBar = memo(function LiveCategoryBarInner({
  categories,
  activeCategoryId,
  channelCount,
  layout,
  focusedChipIndex = null,
  onSelectCategory,
}: LiveCategoryBarProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const chipXRef = useRef<Map<number, number>>(new Map());
  const recordChipX = useCallback((index: number, x: number) => {
    chipXRef.current.set(index, x);
  }, []);

  useEffect(() => {
    if (!layout.isTv || focusedChipIndex === null) return;
    const x = chipXRef.current.get(focusedChipIndex);
    scrollRef.current?.scrollTo({
      x: Math.max(0, (x ?? focusedChipIndex * 116) - layout.padX),
      animated: !theme.reduceMotion,
    });
  }, [focusedChipIndex, layout.isTv, layout.padX, theme.reduceMotion]);

  return (
    <View
      testID="live-category-chips"
      style={[styles.rowCenter, { paddingHorizontal: layout.padX, gap: 12 }]}
    >
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.flex1}
        contentContainerStyle={[
          styles.rowCenter,
          { paddingVertical: layout.isTv ? 8 : 4, gap: theme.spacing.xs },
        ]}
      >
        {categories.map((cat, idx) => (
          <LiveCategoryChip
            key={cat.row.id}
            category={cat}
            index={idx}
            selected={cat.row.id === activeCategoryId}
            isTv={layout.isTv}
            focused={layout.isTv && focusedChipIndex === idx}
            onSelect={onSelectCategory}
            onMeasureX={recordChipX}
          />
        ))}
      </ScrollView>
      <Text
        testID="live-channel-count"
        numberOfLines={1}
        style={[
          theme.typography.caption,
          TABULAR_NUMS_STYLE,
          styles.noShrink,
          { color: theme.colors.textMuted },
        ]}
      >
        {i18n.t('live.channelsCount', { count: channelCount })}
      </Text>
    </View>
  );
});

const SKELETON_CHIPS = [0, 1, 2, 3] as const;
const SKELETON_CARDS = [0, 1, 2, 3, 4, 5] as const;

/** TV key interpreter bridge mounted only when `LiveScreen` owns the active 10-ft focus scope. */
export function LiveTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => void;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="live-tv-focus-anchor" />;
}

/** Tonal zero-CLS loading skeleton displayed while initial Live TV categories load. */
export function LiveLoadingSkeleton({
  layout,
}: {
  readonly layout: CatalogLayoutMetrics;
}): ReactElement {
  const theme = useTheme();
  return (
    <View testID="live-skeleton" style={[styles.skeletonRoot, { paddingHorizontal: layout.padX }]}>
      <View style={styles.rowCenter}>
        <SkeletonBox width={240} height={38} borderRadius={theme.radius.pill} />
      </View>
      <View style={[styles.rowCenter, { gap: theme.spacing.xs }]}>
        {SKELETON_CHIPS.map((slot) => (
          <SkeletonBox key={slot} width={88} height={32} borderRadius={theme.radius.pill} />
        ))}
      </View>
      <View style={styles.skeletonGrid}>
        {SKELETON_CARDS.map((slot) => (
          <View key={slot} style={styles.skeletonCardWrap}>
            <SkeletonBox width="100%" height={102} borderRadius={theme.radius.card} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** Constructive empty state displayed when no ready sources or live categories exist. */
export function LiveEmptyState({
  layout,
  showOpenSources,
  ctaFocused,
  onOpenSources,
}: {
  readonly layout: CatalogLayoutMetrics;
  readonly showOpenSources: boolean;
  readonly ctaFocused: boolean;
  readonly onOpenSources: () => void;
}): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  return (
    <View testID="live-empty" style={[styles.emptyWrap, { paddingHorizontal: layout.padX }]}>
      <Text style={[theme.typography.h2, styles.centerText, { color: theme.colors.textPrimary }]}>
        {i18n.t('live.emptyTitle')}
      </Text>
      <Text
        style={[
          theme.typography.body,
          styles.centerText,
          styles.emptyDesc,
          { color: theme.colors.textSecondary },
        ]}
      >
        {i18n.t('live.emptyDescription')}
      </Text>
      {showOpenSources ? (
        <CtaButton
          testID="live-open-sources"
          label={i18n.t('browse.openSources')}
          variant="primary"
          focusable={!layout.isTv}
          focused={ctaFocused}
          onPress={onOpenSources}
        />
      ) : null}
    </View>
  );
}

/** Renders loading skeleton when a category has channels pending load, or constructive empty state. */
export function LiveCategoryFallback({
  layout,
  hasPendingItems,
  onOpenSources,
}: {
  readonly layout: CatalogLayoutMetrics;
  readonly hasPendingItems: boolean;
  readonly onOpenSources: () => void;
}): ReactElement {
  return hasPendingItems ? (
    <LiveLoadingSkeleton layout={layout} />
  ) : (
    <LiveEmptyState
      layout={layout}
      showOpenSources={false}
      ctaFocused={false}
      onOpenSources={onOpenSources}
    />
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  noShrink: { flexShrink: 0 },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  modeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    padding: 3,
    gap: 4,
    borderWidth: 1,
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    gap: 6,
  },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyDesc: { maxWidth: 420 },
  centerText: { textAlign: 'center' },
  skeletonRoot: { flex: 1, paddingTop: 14, gap: 14 },
  skeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  skeletonCardWrap: { width: '31%', minWidth: 220, flexGrow: 1 },
});
