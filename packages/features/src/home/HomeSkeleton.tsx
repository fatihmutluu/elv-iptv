import {
  CtaButton,
  SkeletonBox,
  type Theme,
  useI18n,
  useTheme,
  type ViewportInfo,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { computePeekCardWidth } from './home-model';

/** Resolved responsive layout metrics shared by {@link HomeScreen}, {@link HomeHero}, and {@link HomeSkeleton}. */
export interface HomeLayoutMetrics {
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly isPortrait: boolean;
  readonly padX: number;
  readonly railGap: number;
  readonly heroTopClearance: number;
  readonly heroHeight: number;
  readonly wideCardWidth: number;
  readonly posterCardWidth: number;
}

/** Computes Cinema Quietude Home geometry from active viewport and theme tokens. */
export function computeHomeLayout(viewport: ViewportInfo, theme: Theme): HomeLayoutMetrics {
  const isTv = viewport.formFactor === 'tv';
  const isTouch = viewport.inputModality === 'touch';
  const isPortrait =
    viewport.orientation === 'portrait' &&
    viewport.formFactor !== 'tv' &&
    viewport.formFactor !== 'desktop';
  const padX = isTv
    ? Math.max(theme.spacing.xl, viewport.overscan.x)
    : isPortrait
      ? theme.spacing.md
      : theme.spacing.lg;
  const railGap = isPortrait ? 8 : 10;
  const topInset = isTv
    ? Math.max(viewport.safeArea.top, viewport.overscan.y)
    : viewport.safeArea.top;
  return {
    isTv,
    isTouch,
    isPortrait,
    padX,
    railGap,
    heroTopClearance: (!isPortrait ? (isTv ? 58 : 56) : 50) + topInset + 24,
    heroHeight: isPortrait ? 300 : isTv ? 440 : 380,
    wideCardWidth: computePeekCardWidth(viewport.width, padX, viewport.columns.wideRail, railGap),
    posterCardWidth: computePeekCardWidth(
      viewport.width,
      padX,
      viewport.columns.posterRail,
      railGap,
    ),
  };
}

/** Props of {@link HomeSkeleton}. */
export interface HomeSkeletonProps {
  readonly heroHeight: number;
  readonly padX: number;
  readonly wideCardWidth: number;
  readonly posterCardWidth: number;
  readonly gap: number;
}

const WIDE_SLOTS = [0, 1, 2, 3] as const;
const POSTER_SLOTS = [0, 1, 2, 3, 4, 5] as const;

/**
 * Zero-CLS tonal Cinema Quietude loading skeleton matching the Home Hero, 16:9 Wide rail, and
 * 2:3 Poster rail dimensions so initial hydration never shifts layout or flashes blank canvas.
 */
export function HomeSkeleton({
  heroHeight,
  padX,
  wideCardWidth,
  posterCardWidth,
  gap,
}: HomeSkeletonProps): ReactElement {
  const theme = useTheme();

  return (
    <View testID="home-skeleton" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      <View
        testID="home-skeleton-hero"
        style={[
          styles.heroBlock,
          {
            minHeight: heroHeight,
            paddingHorizontal: padX,
            paddingBottom: theme.spacing.lg,
            backgroundColor: theme.colors.bgSurface,
          },
        ]}
      >
        <SkeletonBox width={150} height={14} borderRadius={theme.radius.button} />
        <SkeletonBox
          width={300}
          height={34}
          borderRadius={theme.radius.button}
          style={styles.heroGap}
        />
        <SkeletonBox
          width={220}
          height={14}
          borderRadius={theme.radius.button}
          style={styles.heroGapSm}
        />
        <View style={[styles.heroActions, { gap: theme.spacing.sm }]}>
          <SkeletonBox width={128} height={42} borderRadius={theme.radius.button} />
          <SkeletonBox width={42} height={42} borderRadius={theme.radius.pill} />
          <SkeletonBox width={42} height={42} borderRadius={theme.radius.pill} />
        </View>
      </View>

      <View
        testID="home-skeleton-wide-rail"
        style={[styles.railSection, { paddingHorizontal: padX }]}
      >
        <SkeletonBox width={160} height={18} borderRadius={theme.radius.button} />
        <View style={[styles.railRow, { gap }]}>
          {WIDE_SLOTS.map((slot) => (
            <View key={slot} style={{ width: wideCardWidth }}>
              <SkeletonBox width={wideCardWidth} aspectRatio={16 / 9} />
              <SkeletonBox
                width="75%"
                height={13}
                borderRadius={theme.radius.button}
                style={styles.labelBar}
              />
            </View>
          ))}
        </View>
      </View>

      <View
        testID="home-skeleton-poster-rail"
        style={[styles.railSection, { paddingHorizontal: padX }]}
      >
        <SkeletonBox width={148} height={18} borderRadius={theme.radius.button} />
        <View style={[styles.railRow, { gap }]}>
          {POSTER_SLOTS.map((slot) => (
            <View key={slot} style={{ width: posterCardWidth }}>
              <SkeletonBox width={posterCardWidth} aspectRatio={2 / 3} />
              <SkeletonBox
                width="80%"
                height={12}
                borderRadius={theme.radius.button}
                style={styles.labelBar}
              />
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

/** Props of {@link HomeEmptyState}. */
export interface HomeEmptyStateProps {
  readonly topClearance: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onOpenSources: () => void;
}

/** Constructive empty state displayed on Home when no sources or catalog items are ready yet. */
export function HomeEmptyState({
  topClearance,
  padX,
  isTv,
  focused,
  onOpenSources,
}: HomeEmptyStateProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  return (
    <View
      testID="home-empty"
      style={[styles.emptyContainer, { paddingTop: topClearance, paddingHorizontal: padX }]}
    >
      <Text style={[theme.typography.h1, { color: theme.colors.textPrimary, textAlign: 'center' }]}>
        {i18n.t('home.emptyTitle')}
      </Text>
      <Text
        style={[
          theme.typography.body,
          styles.emptyDesc,
          { color: theme.colors.textSecondary, marginTop: theme.spacing.sm },
        ]}
      >
        {i18n.t('home.emptyDescription')}
      </Text>
      <View style={{ marginTop: theme.spacing.lg }}>
        <CtaButton
          testID="home-empty-sources"
          label={i18n.t('home.addSource')}
          icon="sources"
          focusable={!isTv}
          focused={focused}
          onPress={onOpenSources}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyDesc: {
    maxWidth: 420,
    textAlign: 'center',
  },
  heroBlock: {
    justifyContent: 'flex-end',
  },
  heroGap: {
    marginTop: 10,
  },
  heroGapSm: {
    marginTop: 8,
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
  },
  railSection: {
    marginTop: 22,
  },
  railRow: {
    flexDirection: 'row',
    marginTop: 12,
    overflow: 'hidden',
  },
  labelBar: {
    marginTop: 8,
  },
});
