import { GlassBar, Icon, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NavDestination, NavUtility } from './types';

/** Props of {@link UtilitiesRow}. */
export interface UtilitiesRowProps {
  readonly utilities: readonly NavUtility[];
  readonly activeId: string;
  readonly isTv: boolean;
  readonly focusedItemId?: string;
  readonly compactPortrait: boolean;
  readonly onExitNavFocus?: () => void;
}

/** Right-aligned utility cluster rendered inside the top {@link GlassBar}. */
export function UtilitiesRow({
  utilities,
  activeId,
  isTv,
  focusedItemId,
  compactPortrait,
  onExitNavFocus,
}: UtilitiesRowProps): ReactElement | null {
  const theme = useTheme();
  if (utilities.length === 0) return null;

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.utilitiesRow,
        { gap: isTv ? theme.spacing.md : compactPortrait ? theme.spacing.xs : theme.spacing.sm },
      ]}
    >
      {utilities.map((util) => {
        const utilTestId = util.testID ?? `nav-utility-${util.id}`;
        const selected = Boolean(util.active) || util.id === activeId;
        const tvFocused = focusedItemId === util.id;
        const showLabel = compactPortrait ? util.showLabel === true : util.showLabel !== false;
        const fgColor = selected ? theme.colors.textPrimary : theme.colors.textSecondary;

        return (
          <Pressable
            key={util.id}
            testID={utilTestId}
            accessibilityRole="tab"
            accessibilityLabel={util.label}
            accessibilityState={{ selected }}
            {...(isTv ? { focusable: false } : {})}
            onPress={() => {
              util.onPress();
              onExitNavFocus?.();
            }}
            style={[
              styles.utilityItem,
              compactPortrait ? styles.touchTarget : null,
              {
                borderRadius: theme.radius.button,
                borderWidth: isTv ? theme.focus.ringWidth : 0,
                borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
                backgroundColor: tvFocused ? theme.colors.focusFill : 'transparent',
              },
            ]}
          >
            <View style={styles.utilityContent}>
              <Icon name={util.icon} size={isTv ? 20 : 18} color={fgColor} />
              {showLabel ? (
                <Text
                  numberOfLines={1}
                  style={[
                    isTv ? theme.typography.h2 : theme.typography.body,
                    styles.navLabel,
                    { color: fgColor },
                  ]}
                >
                  {util.label}
                </Text>
              ) : null}
            </View>
            <View
              testID={`${utilTestId}-underline`}
              style={[
                styles.activeUnderline,
                { backgroundColor: selected ? theme.colors.accent : 'transparent' },
              ]}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** Props of {@link PortraitBottomBar}. */
export interface PortraitBottomBarProps<TId extends string = string> {
  readonly destinations: readonly NavDestination<TId>[];
  readonly activeId: string;
  readonly safeBottom: number;
  readonly onSelectDestination: (id: TId) => void;
  readonly onExitNavFocus?: () => void;
}

/** Fixed bottom frosted tab bar rendering all primary destinations on Portrait devices. */
export function PortraitBottomBar<TId extends string = string>({
  destinations,
  activeId,
  safeBottom,
  onSelectDestination,
  onExitNavFocus,
}: PortraitBottomBarProps<TId>): ReactElement | null {
  const theme = useTheme();
  if (destinations.length === 0) return null;

  return (
    <GlassBar
      testID="app-bottom-nav"
      scrolled
      hairlineEdge="top"
      style={{
        minHeight: 58 + safeBottom,
        paddingBottom: safeBottom,
        paddingHorizontal: theme.spacing.xs,
      }}
      contentStyle={styles.bottomNavContent}
    >
      <View accessibilityRole="tablist" style={styles.bottomTabList}>
        {destinations.map((dest) => {
          const tabTestId = dest.testID ?? `nav-tab-${dest.id}`;
          const selected = dest.id === activeId;
          return (
            <Pressable
              key={dest.id}
              testID={tabTestId}
              accessibilityRole="tab"
              accessibilityLabel={dest.label}
              accessibilityState={{ selected }}
              onPress={() => {
                onSelectDestination(dest.id);
                onExitNavFocus?.();
              }}
              style={styles.bottomTab}
            >
              <View
                testID={`${tabTestId}-underline`}
                style={[
                  styles.bottomActiveBar,
                  { backgroundColor: selected ? theme.colors.accent : 'transparent' },
                ]}
              />
              <View style={styles.bottomIconWrap}>
                <Icon
                  name={dest.icon}
                  size={20}
                  color={selected ? theme.colors.accent : theme.colors.textSecondary}
                />
                {dest.badge !== undefined ? (
                  <View
                    style={[
                      styles.portraitBadge,
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
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.micro,
                  styles.bottomTabLabel,
                  { color: selected ? theme.colors.textPrimary : theme.colors.textSecondary },
                ]}
              >
                {dest.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </GlassBar>
  );
}

const styles = StyleSheet.create({
  utilitiesRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  utilityItem: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 40,
    justifyContent: 'center',
  },
  touchTarget: {
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
  },
  utilityContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  navLabel: {
    fontWeight: '600',
  },
  activeUnderline: {
    height: 2,
    width: '100%',
    marginTop: 4,
    borderRadius: 1,
  },
  bottomNavContent: {
    justifyContent: 'space-around',
    alignItems: 'stretch',
  },
  bottomTabList: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-around',
  },
  bottomIconWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  portraitBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  bottomTab: {
    flex: 1,
    minWidth: 40,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    gap: 3,
  },
  bottomActiveBar: {
    height: 2,
    width: 24,
    borderRadius: 1,
    marginBottom: 2,
  },
  bottomTabLabel: {
    textAlign: 'center',
  },
});
