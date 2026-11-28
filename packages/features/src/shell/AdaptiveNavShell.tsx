import type { KeyEvent } from '@elv/focus-core';
import {
  GlassBar,
  scaleTv,
  TvFocusAnchor,
  TvFocusGuideRegion,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, type TextStyle, View } from 'react-native';
import { useRouteActive } from '../shared';
import { AmbientTvClock } from '../shared/AmbientTvClock';
import { PortraitBottomBar, UtilitiesRow } from './NavBars';
import type { AdaptiveNavShellProps } from './types';

interface UnifiedNavItem {
  readonly id: string;
  readonly active: boolean;
  readonly activateOnSelectOnly: boolean;
  readonly activate: () => void;
}

function NavTvBridge({
  onEvent,
  preferredFocus,
}: {
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
  readonly preferredFocus: boolean;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="nav-tv-focus-anchor" hasTVPreferredFocus={preferredFocus} />;
}

/**
 * Config-driven adaptive navigation shell (`UI_UX_PHILOSOPHY.md` §2 & §3).
 *
 * - **Landscape / TV / Desktop:** Frosted top `GlassBar` with brand title and borderless destination links
 *   (`2px` accent active underline, `overscan.x` horizontal padding and crisp TV focus ring) plus right-aligned utilities.
 * - **Portrait (Phone / Tablet):** Compact top `GlassBar` (`brand` + `utilities`) paired with a fixed bottom frosted
 *   tab bar rendering all `destinations` evenly with safe-area padding and `>= 40x40` touch targets.
 * - **TV 10-ft D-pad:** Cycles seamlessly across `[...destinations, ...utilities]` on `left`/`right` and exits nav
 *   focus on `down`/`select`.
 */
export function AdaptiveNavShell<TId extends string = string>({
  brandTitle,
  showBrand = true,
  destinations,
  utilities = [],
  activeId,
  onSelectDestination,
  navFocused = false,
  onExitNavFocus,
  onBack,
  frosted = true,
  overlay = false,
  tvClockMode = 'always',
  testID = 'app-shell',
  children,
}: AdaptiveNavShellProps<TId>): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const routeActive = useRouteActive();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const isTv = viewport.formFactor === 'tv';
  const isTouch = viewport.inputModality === 'touch';
  const isLandscape =
    viewport.orientation === 'landscape' ||
    viewport.formFactor === 'tv' ||
    viewport.formFactor === 'desktop';

  const unifiedItems = useMemo<readonly UnifiedNavItem[]>(
    () => [
      ...destinations.map((dest) => ({
        id: dest.id,
        active: dest.id === activeId,
        activateOnSelectOnly: false,
        activate: () => onSelectDestination(dest.id),
      })),
      ...utilities.map((util) => ({
        id: util.id,
        active: Boolean(util.active) || util.id === activeId,
        activateOnSelectOnly: Boolean(util.activateOnSelectOnly),
        activate: util.onPress,
      })),
    ],
    [destinations, utilities, activeId, onSelectDestination],
  );

  const [fallbackFocusedIndex, setFallbackFocusedIndex] = useState(0);
  const [selectOnlyHighlightIndex, setSelectOnlyHighlightIndex] = useState<number | null>(null);
  const activeUnifiedIndex = unifiedItems.findIndex((item) => item.active);
  useEffect(() => {
    if (!navFocused) setSelectOnlyHighlightIndex(null);
  }, [navFocused]);
  const resolvedTvFocusedIndex =
    selectOnlyHighlightIndex !== null && selectOnlyHighlightIndex < unifiedItems.length
      ? selectOnlyHighlightIndex
      : activeUnifiedIndex >= 0
        ? activeUnifiedIndex
        : unifiedItems.length > 0
          ? Math.min(fallbackFocusedIndex, unifiedItems.length - 1)
          : -1;
  const focusedItemId =
    isTv && navFocused && resolvedTvFocusedIndex >= 0
      ? unifiedItems[resolvedTvFocusedIndex]?.id
      : undefined;

  const unifiedItemsRef = useRef(unifiedItems);
  unifiedItemsRef.current = unifiedItems;
  const onExitNavFocusRef = useRef(onExitNavFocus);
  onExitNavFocusRef.current = onExitNavFocus;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const pendingNavIndexRef = useRef(resolvedTvFocusedIndex);
  pendingNavIndexRef.current = resolvedTvFocusedIndex;

  const handleTvNavKey = useCallback((event: KeyEvent): boolean => {
    if (event.kind === 'press' && event.key === 'back') {
      return onBackRef.current ? onBackRef.current() : false;
    }
    if (event.kind !== 'press' && event.kind !== 'repeat') return false;
    if (event.key === 'left' || event.key === 'right') {
      const items = unifiedItemsRef.current;
      if (items.length === 0) return false;
      const baseIdx =
        pendingNavIndexRef.current >= 0 && pendingNavIndexRef.current < items.length
          ? pendingNavIndexRef.current
          : 0;
      const delta = event.key === 'right' ? 1 : -1;
      const nextIdx = (baseIdx + delta + items.length) % items.length;
      pendingNavIndexRef.current = nextIdx;
      const target = items[nextIdx];
      if (target?.activateOnSelectOnly) {
        setSelectOnlyHighlightIndex(nextIdx);
      } else {
        setSelectOnlyHighlightIndex(null);
        setFallbackFocusedIndex(nextIdx);
        target?.activate();
      }
      return true;
    }
    if (event.kind === 'press' && event.key === 'down') {
      setSelectOnlyHighlightIndex(null);
      onExitNavFocusRef.current?.();
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      const focused = unifiedItemsRef.current[pendingNavIndexRef.current];
      if (focused?.activateOnSelectOnly) {
        focused.activate();
        return true;
      }
      onExitNavFocusRef.current?.();
      return true;
    }
    return false;
  }, []);

  const topInset = isTv
    ? Math.max(viewport.safeArea.top, viewport.overscan.y)
    : viewport.safeArea.top;
  const topHorizontalPadding = isTv
    ? Math.max(scaleTv(theme.spacing.xl, viewport), viewport.overscan.x)
    : theme.spacing.md;
  const tvTopBarBase = isTv ? Math.max(44, scaleTv(58, viewport)) : 56;
  const topBarMinHeight = (isLandscape ? tvTopBarBase : 50) + topInset;
  const brandSpaceIdx = brandTitle.indexOf(' ');
  const brandBase = isTv ? Math.max(14, scaleTv(18, viewport)) : 16;
  const navBase = isTv ? Math.max(12, scaleTv(15, viewport)) : 13.5;
  const brandFontSize = Math.round(brandBase * theme.fontScale);
  const navFontSize = Math.round(navBase * theme.fontScale);
  const leftClusterGap = isTv
    ? Math.max(16, scaleTv(theme.spacing.xl, viewport))
    : theme.spacing.lg;
  const destinationsGap = isTv ? Math.max(12, scaleTv(18, viewport)) : 18;
  const bodyFontFamily = theme.typography.body.fontFamily;
  const linkWebTransition = webTransition(theme, 'color, background-color, border-color');
  const linkWebCursor = webCursorPointer();
  const brandFontStyle: TextStyle = {
    ...(bodyFontFamily ? { fontFamily: bodyFontFamily } : {}),
    fontSize: brandFontSize,
    lineHeight: Math.round(brandFontSize * 1.25),
    color: theme.colors.textPrimary,
  };
  const navFontBase: TextStyle = {
    ...(bodyFontFamily ? { fontFamily: bodyFontFamily } : {}),
    fontSize: navFontSize,
    lineHeight: Math.round(navFontSize * 1.3),
  };
  const labelWebTransition = webTransition(theme, 'color') as TextStyle | undefined;

  return (
    <View testID={testID} style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && navFocused ? (
        <NavTvBridge onEvent={handleTvNavKey} preferredFocus={routeActive && navFocused} />
      ) : null}

      <TvFocusGuideRegion
        testID="nav-focus-guide-top"
        enabled={isTv && routeActive}
        autoFocus
        style={overlay ? styles.topNavOverlay : undefined}
      >
        <GlassBar
          testID="app-top-nav"
          scrolled={frosted}
          hairlineEdge="bottom"
          style={{
            minHeight: topBarMinHeight,
            paddingTop: topInset,
            paddingHorizontal: topHorizontalPadding,
          }}
          contentStyle={styles.topNavContent}
        >
          <View style={[styles.leftCluster, { gap: leftClusterGap }]}>
            {showBrand ? (
              <Text numberOfLines={1} style={[styles.brandTitle, brandFontStyle]}>
                {brandSpaceIdx > 0 ? (
                  <>
                    <Text testID="app-brand-accent" style={{ color: theme.colors.accent }}>
                      {brandTitle.slice(0, brandSpaceIdx)}
                    </Text>
                    {brandTitle.slice(brandSpaceIdx)}
                  </>
                ) : (
                  brandTitle
                )}
              </Text>
            ) : null}

            {isLandscape ? (
              <View
                accessibilityRole="tablist"
                style={[styles.destinationsRow, { gap: destinationsGap }]}
              >
                {destinations.map((dest) => {
                  const tabTestId = dest.testID ?? `nav-tab-${dest.id}`;
                  const selected = dest.id === activeId;
                  const tvFocused = focusedItemId === dest.id;
                  const hovered = hoveredId === dest.id;
                  const fgColor =
                    selected || hovered ? theme.colors.textPrimary : theme.colors.textSecondary;

                  return (
                    <Pressable
                      key={dest.id}
                      testID={tabTestId}
                      accessibilityRole="tab"
                      accessibilityLabel={dest.label}
                      accessibilityState={{ selected }}
                      {...(isTv ? { focusable: false } : {})}
                      onHoverIn={() => setHoveredId(dest.id)}
                      onHoverOut={() => setHoveredId((prev) => (prev === dest.id ? null : prev))}
                      onPress={() => {
                        onSelectDestination(dest.id);
                        onExitNavFocus?.();
                      }}
                      style={[
                        styles.landscapeLink,
                        isTouch ? styles.touchTarget : null,
                        linkWebTransition,
                        linkWebCursor,
                        {
                          borderRadius: theme.radius.button,
                          borderWidth: isTv ? theme.focus.ringWidth : 0,
                          borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
                          backgroundColor: tvFocused ? theme.colors.focusFill : 'transparent',
                        },
                      ]}
                    >
                      <View style={styles.linkLabelRow}>
                        <Text
                          numberOfLines={1}
                          style={[
                            navFontBase,
                            labelWebTransition,
                            {
                              fontWeight: selected ? '700' : '500',
                              color: fgColor,
                            },
                          ]}
                        >
                          {dest.label}
                        </Text>
                        {dest.badge !== undefined ? (
                          <View
                            style={[
                              styles.badge,
                              {
                                backgroundColor: theme.colors.accent,
                                borderRadius: theme.radius.pill,
                              },
                            ]}
                          >
                            <Text
                              numberOfLines={1}
                              style={[
                                theme.typography.micro,
                                { color: theme.colors.accentContrast },
                              ]}
                            >
                              {dest.badge}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <View
                        testID={`${tabTestId}-underline`}
                        style={[
                          styles.activeUnderline,
                          { backgroundColor: selected ? theme.colors.accent : 'transparent' },
                        ]}
                      />
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>

          <View style={[styles.rightCluster, { gap: isTv ? theme.spacing.md : theme.spacing.sm }]}>
            <UtilitiesRow
              utilities={utilities}
              activeId={activeId}
              isTv={isTv}
              isTouch={isTouch}
              {...(focusedItemId !== undefined ? { focusedItemId } : {})}
              compactPortrait={!isLandscape}
              {...(onExitNavFocus !== undefined ? { onExitNavFocus } : {})}
            />
            <AmbientTvClock surface="menus" mode={tvClockMode} testID="nav-ambient-clock" />
          </View>
        </GlassBar>
      </TvFocusGuideRegion>

      <View testID="app-shell-body" style={styles.body}>
        {children}
      </View>

      {!isLandscape ? (
        <PortraitBottomBar
          destinations={destinations}
          activeId={activeId}
          safeBottom={viewport.safeArea.bottom}
          onSelectDestination={onSelectDestination}
          {...(onExitNavFocus !== undefined ? { onExitNavFocus } : {})}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    position: 'relative',
  },
  topNavOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 35,
  },
  topNavContent: {
    justifyContent: 'space-between',
    gap: 12,
  },
  leftCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  rightCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  brandTitle: {
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  destinationsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 18,
  },
  landscapeLink: {
    position: 'relative',
    paddingHorizontal: 6,
    paddingVertical: 8,
    minHeight: 38,
    justifyContent: 'center',
  },
  touchTarget: {
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
  },
  linkLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  activeUnderline: {
    position: 'absolute',
    left: 4,
    right: 4,
    bottom: 2,
    height: 2,
    borderRadius: 2,
  },
  body: {
    flex: 1,
  },
});
