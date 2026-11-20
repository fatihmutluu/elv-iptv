import type { KeyEvent } from '@elv/focus-core';
import { GlassBar, TvFocusAnchor, useKeyInterpreter, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PortraitBottomBar, UtilitiesRow } from './NavBars';
import type { AdaptiveNavShellProps } from './types';

interface UnifiedNavItem {
  readonly id: string;
  readonly active: boolean;
  readonly activate: () => void;
}

function NavTvBridge({ onEvent }: { onEvent: (event: KeyEvent) => void }): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="nav-tv-focus-anchor" />;
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
  frosted = true,
  testID = 'app-shell',
  children,
}: AdaptiveNavShellProps<TId>): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();

  const isTv = viewport.formFactor === 'tv';
  const isLandscape =
    viewport.orientation === 'landscape' ||
    viewport.formFactor === 'tv' ||
    viewport.formFactor === 'desktop';

  const unifiedItems = useMemo<readonly UnifiedNavItem[]>(
    () => [
      ...destinations.map((dest) => ({
        id: dest.id,
        active: dest.id === activeId,
        activate: () => onSelectDestination(dest.id),
      })),
      ...utilities.map((util) => ({
        id: util.id,
        active: Boolean(util.active) || util.id === activeId,
        activate: util.onPress,
      })),
    ],
    [destinations, utilities, activeId, onSelectDestination],
  );

  const [fallbackFocusedIndex, setFallbackFocusedIndex] = useState(0);
  const activeUnifiedIndex = unifiedItems.findIndex((item) => item.active);
  const resolvedTvFocusedIndex =
    activeUnifiedIndex >= 0
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
  const pendingNavIndexRef = useRef(resolvedTvFocusedIndex);
  pendingNavIndexRef.current = resolvedTvFocusedIndex;

  const handleTvNavKey = useCallback((event: KeyEvent) => {
    if (event.kind !== 'press' && event.kind !== 'repeat') return;
    if (event.key === 'left' || event.key === 'right') {
      const items = unifiedItemsRef.current;
      if (items.length === 0) return;
      const baseIdx =
        pendingNavIndexRef.current >= 0 && pendingNavIndexRef.current < items.length
          ? pendingNavIndexRef.current
          : 0;
      const delta = event.key === 'right' ? 1 : -1;
      const nextIdx = (baseIdx + delta + items.length) % items.length;
      pendingNavIndexRef.current = nextIdx;
      setFallbackFocusedIndex(nextIdx);
      items[nextIdx]?.activate();
    } else if (event.kind === 'press' && (event.key === 'down' || event.key === 'select')) {
      onExitNavFocusRef.current?.();
    }
  }, []);

  const topInset = isTv
    ? Math.max(viewport.safeArea.top, viewport.overscan.y)
    : viewport.safeArea.top;
  const topHorizontalPadding = isTv
    ? Math.max(theme.spacing.xl, viewport.overscan.x)
    : theme.spacing.md;
  const topBarMinHeight = (isLandscape ? (isTv ? 64 : 56) : 50) + topInset;

  return (
    <View testID={testID} style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && navFocused ? <NavTvBridge onEvent={handleTvNavKey} /> : null}

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
        <View style={[styles.leftCluster, { gap: isTv ? theme.spacing.xl : theme.spacing.lg }]}>
          {showBrand ? (
            <Text
              numberOfLines={1}
              style={[
                isTv ? theme.typography.h2 : theme.typography.title,
                styles.brandTitle,
                { color: theme.colors.textPrimary },
              ]}
            >
              {brandTitle}
            </Text>
          ) : null}

          {isLandscape ? (
            <View
              accessibilityRole="tablist"
              style={[styles.destinationsRow, { gap: isTv ? theme.spacing.lg : theme.spacing.md }]}
            >
              {destinations.map((dest) => {
                const tabTestId = dest.testID ?? `nav-tab-${dest.id}`;
                const selected = dest.id === activeId;
                const tvFocused = focusedItemId === dest.id;
                const fgColor = selected ? theme.colors.textPrimary : theme.colors.textSecondary;

                return (
                  <Pressable
                    key={dest.id}
                    testID={tabTestId}
                    accessibilityRole="tab"
                    accessibilityLabel={dest.label}
                    accessibilityState={{ selected }}
                    {...(isTv ? { focusable: false } : {})}
                    onPress={() => {
                      onSelectDestination(dest.id);
                      onExitNavFocus?.();
                    }}
                    style={[
                      styles.landscapeLink,
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
                          isTv ? theme.typography.h2 : theme.typography.body,
                          styles.navLabel,
                          { color: fgColor },
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
                            style={[theme.typography.micro, { color: theme.colors.accentContrast }]}
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

        <UtilitiesRow
          utilities={utilities}
          activeId={activeId}
          isTv={isTv}
          {...(focusedItemId !== undefined ? { focusedItemId } : {})}
          compactPortrait={!isLandscape}
          {...(onExitNavFocus !== undefined ? { onExitNavFocus } : {})}
        />
      </GlassBar>

      <View style={styles.body}>{children}</View>

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
  brandTitle: {
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  destinationsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  landscapeLink: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 40,
    justifyContent: 'center',
  },
  linkLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  navLabel: {
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  activeUnderline: {
    height: 2,
    width: '100%',
    marginTop: 4,
    borderRadius: 1,
  },
  body: {
    flex: 1,
  },
});
