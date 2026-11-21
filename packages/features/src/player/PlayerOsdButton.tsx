import type { AppI18n } from '@elv/i18n';
import {
  Icon,
  type IconName,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

function blurWebTarget(target: unknown): void {
  if ((Platform.OS as string) === 'web') {
    (target as { blur?: () => void } | null | undefined)?.blur?.();
  }
}

/** Props of {@link OsdButton}. */
export interface OsdButtonProps {
  testID: string;
  label?: string;
  accessibilityLabel?: string;
  icon?: IconName;
  variant?: 'default' | 'primary' | 'icon';
  active?: boolean;
  onPress: () => void;
  isTv: boolean;
  tvFocused?: boolean;
}

/** Tokenized Cinema Quietude player OSD button (`default`, high-contrast `primary`, or `icon`). */
export function OsdButton(p: OsdButtonProps): ReactElement {
  const theme = useTheme();
  const isPrimary = p.variant === 'primary';
  const isIconOnly = p.variant === 'icon';
  const focused = p.tvFocused === true;
  const active = p.active === true;

  const backgroundColor = isPrimary
    ? theme.colors.ctaBg
    : active
      ? theme.colors.accentTint
      : focused
        ? theme.colors.focusFill
        : theme.colors.actionGlassBg;
  const borderColor = isPrimary
    ? theme.colors.ctaBg
    : focused
      ? theme.colors.focusRingColor
      : active
        ? theme.colors.accent
        : theme.colors.actionGlassBorder;
  const foreground = isPrimary ? theme.colors.ctaFg : theme.colors.textPrimary;
  const scale = isPrimary && focused && !theme.reduceMotion ? theme.focus.buttonScale : 1;

  return (
    <Pressable
      testID={p.testID}
      {...(p.isTv ? { focusable: false } : {})}
      accessibilityRole="button"
      accessibilityLabel={p.accessibilityLabel ?? p.label ?? p.testID}
      accessibilityState={{ selected: focused }}
      onPress={(e) => {
        blurWebTarget(e.currentTarget);
        p.onPress();
      }}
      style={[
        styles.button,
        isIconOnly ? styles.iconButton : isPrimary ? styles.primaryButton : null,
        {
          backgroundColor,
          borderColor,
          borderWidth: !isPrimary && focused ? theme.focus.ringWidth : 1,
          borderRadius: isIconOnly ? theme.radius.pill : theme.radius.button,
          ...(isPrimary && focused ? { transform: [{ scale }] } : {}),
        },
        !isPrimary ? webBackdropBlur(12) : undefined,
        webTransition(theme, 'background-color, border-color, transform'),
        !p.isTv ? webCursorPointer() : undefined,
      ]}
    >
      {p.icon !== undefined ? <Icon name={p.icon} size={18} color={foreground} /> : null}
      {!isIconOnly && p.label !== undefined ? (
        <Text
          numberOfLines={1}
          style={[
            theme.typography.title,
            { color: foreground, fontWeight: isPrimary ? '700' : '600' },
          ]}
        >
          {p.label}
        </Text>
      ) : null}
      {isPrimary && focused ? (
        <View
          pointerEvents="none"
          testID={`${p.testID}-focus-ring`}
          style={[
            styles.primaryFocusRing,
            {
              borderRadius: theme.radius.button + 4,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
}

/** Touch-only locked overlay hiding all OSD controls behind a single centered unlock pill. */
export function PlayerLockedOverlay({
  i18n,
  onUnlock,
}: {
  i18n: AppI18n;
  onUnlock: () => void;
}): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const unlockLabel = i18n.t('player.unlockControls');

  return (
    <View
      testID="player-locked-overlay"
      pointerEvents="box-none"
      style={[styles.lockedOverlay, { paddingBottom: 24 + viewport.safeArea.bottom }]}
    >
      <Pressable
        testID="player-unlock-button"
        accessibilityRole="button"
        accessibilityLabel={unlockLabel}
        onPress={(e) => {
          blurWebTarget(e.currentTarget);
          onUnlock();
        }}
        style={[
          styles.unlockPill,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.pill,
          },
          webBackdropBlur(20),
          webTransition(theme, 'opacity, transform'),
          webCursorPointer(),
        ]}
      >
        <Icon name="lock" size={16} color={theme.colors.textPrimary} />
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
          {unlockLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  primaryButton: { paddingHorizontal: 18 },
  primaryFocusRing: {
    position: 'absolute',
    top: -4,
    right: -4,
    bottom: -4,
    left: -4,
  },
  iconButton: {
    width: 40,
    height: 40,
    minWidth: 40,
    minHeight: 40,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  lockedOverlay: { alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 16 },
  unlockPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
});
