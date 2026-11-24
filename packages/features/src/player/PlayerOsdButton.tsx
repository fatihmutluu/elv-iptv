import type { AppI18n } from '@elv/i18n';
import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  positionAt,
} from '@elv/playback';
import {
  Icon,
  type IconName,
  TABULAR_NUMS_STYLE,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { shouldShowLiveJumpToLive } from './live-timeshift-model';
import { usePlaybackTicker } from './usePlaybackTicker';
import { formatPlaybackPosition } from './vod-progress-math';

/** Synchronized ARIA `aria-keyshortcuts` descriptors for desktop web player controls (#283). */
export const PLAYER_KEY_SHORTCUTS = {
  playPause: 'Space k',
  seekBack: 'ArrowLeft j',
  seekForward: 'ArrowRight l',
  mute: 'm',
  fullscreen: 'f',
  alwaysOnTop: 't',
  tracks: 'c',
  info: 'i',
  channelList: 'g',
  back: 'Escape',
} as const;

const readClockText = (anchor: ClockAnchor | undefined, nowMs: number): string =>
  anchor === undefined ? '--:--' : formatPlaybackPosition(positionAt(anchor, nowMs));

const sameText = (a: string, b: string): boolean => a === b;
const sameBool = (a: boolean, b: boolean): boolean => a === b;

/**
 * Compact Cinema Quietude `"Jump to live"` button rendered when a live stream is behind the live
 * edge or paused with bounded time-shift (`#28`) or lagging > 4 s on raw MPEG-TS (`#141`).
 */
export function JumpToLiveButton(p: {
  isVod: boolean;
  isPaused?: boolean;
  service: PlaybackService | null;
  clock: PlaybackClock;
  i18n: AppI18n;
  isTv: boolean;
  tvFocused?: boolean;
  compact?: boolean;
  onPress?: () => void;
}): ReactElement | null {
  const isPaused = p.isPaused === true;
  const derive = useCallback(
    (anchor: ClockAnchor | undefined, nowMs: number) =>
      shouldShowLiveJumpToLive(anchor, nowMs, isPaused),
    [isPaused],
  );
  const show = usePlaybackTicker({
    service: p.isVod ? null : p.service,
    clock: p.clock,
    mode: 'second',
    active: !p.isVod && p.onPress !== undefined,
    derive,
    isEqual: sameBool,
  });
  if (p.isVod || p.service === null || p.onPress === undefined || !show) return null;
  return (
    <OsdButton
      testID="player-jump-to-live"
      variant="pill-cta"
      icon="play"
      iconSize={14}
      label={p.i18n.t('player.jumpToLive')}
      accessibilityLabel={p.i18n.t('player.jumpToLive')}
      compact={p.compact === true}
      onPress={p.onPress}
      isTv={p.isTv}
      {...(p.tvFocused !== undefined ? { tvFocused: p.tvFocused } : {})}
    />
  );
}

/** Live-ticking tabular playback clock displayed in the player OSD. */
export function OsdClock(p: {
  service: PlaybackService | null;
  clock: PlaybackClock;
  previewPositionMs: number | undefined;
}): ReactElement {
  const theme = useTheme();
  const text = usePlaybackTicker({
    service: p.service,
    clock: p.clock,
    mode: 'second',
    derive: readClockText,
    isEqual: sameText,
  });
  return (
    <Text
      testID="osd-clock"
      style={[
        theme.typography.caption,
        TABULAR_NUMS_STYLE,
        styles.clock,
        { color: theme.colors.textSecondary },
      ]}
    >
      {p.previewPositionMs === undefined ? text : formatPlaybackPosition(p.previewPositionMs)}
    </Text>
  );
}

function blurWebTarget(target: unknown): void {
  if ((Platform.OS as string) === 'web') {
    (target as { blur?: () => void } | null | undefined)?.blur?.();
  }
}

/** Supported visual variants for {@link OsdButton}. */
type OsdButtonVariant = 'default' | 'primary' | 'icon' | 'bare' | 'glass-primary' | 'pill-cta';

/** Props of {@link OsdButton}. */
export interface OsdButtonProps {
  testID: string;
  label?: string;
  accessibilityLabel?: string;
  keyShortcuts?: string;
  icon?: IconName;
  iconSize?: number;
  variant?: OsdButtonVariant;
  size?: number;
  circular?: boolean;
  compact?: boolean;
  tabularLabel?: boolean;
  active?: boolean;
  loading?: boolean;
  onPress: () => void;
  onHoverIn?: () => void;
  onHoverOut?: () => void;
  isTv: boolean;
  tvFocused?: boolean;
}

/**
 * Tokenized Cinema Quietude player OSD button supporting borderless `bare`, translucent circular
 * `glass-primary`, dark-glass `pill-cta`, and legacy `default` / `primary` / `icon` variants.
 */
export function OsdButton(p: OsdButtonProps): ReactElement {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const variant: OsdButtonVariant = p.variant ?? 'default';
  const isBare = variant === 'bare';
  const isGlassPrimary = variant === 'glass-primary';
  const isPillCta = variant === 'pill-cta';
  const isPrimary = variant === 'primary';
  const hasLabel = p.label !== undefined && p.label.length > 0;
  const isIconOnly =
    variant === 'icon' || isGlassPrimary || p.circular === true || (isBare && !hasLabel);
  const focused = p.tvFocused === true;
  const active = p.active === true;
  const boxSize = p.size ?? (isGlassPrimary ? 48 : 40);
  const iconSize = p.iconSize ?? (isGlassPrimary ? 22 : 20);

  let backgroundColor: string;
  let borderColor: string;
  let borderWidth: number;
  let borderRadius: number;
  let foreground = theme.colors.textPrimary;

  if (isBare) {
    backgroundColor = focused
      ? theme.colors.focusFill
      : active
        ? theme.colors.accentTint
        : hovered || pressed
          ? theme.colors.actionGlassBg
          : 'transparent';
    borderColor = focused ? theme.colors.focusRingColor : 'transparent';
    borderWidth = focused ? theme.focus.ringWidth : 0;
    borderRadius = isIconOnly ? theme.radius.pill : theme.radius.button;
  } else if (isGlassPrimary) {
    backgroundColor = focused
      ? theme.colors.focusFill
      : hovered || pressed
        ? theme.colors.glassBg
        : theme.colors.actionGlassBg;
    borderColor = focused ? theme.colors.focusRingColor : theme.colors.actionGlassBorder;
    borderWidth = focused ? theme.focus.ringWidth : 1;
    borderRadius = theme.radius.pill;
  } else if (isPillCta) {
    backgroundColor = focused
      ? theme.colors.focusFill
      : active
        ? theme.colors.accentTint
        : hovered || pressed
          ? theme.colors.glassBg
          : theme.colors.actionGlassBg;
    borderColor = focused
      ? theme.colors.focusRingColor
      : active
        ? theme.colors.accent
        : theme.colors.surfaceBorder;
    borderWidth = focused ? theme.focus.ringWidth : StyleSheet.hairlineWidth;
    borderRadius = theme.radius.pill;
  } else if (isPrimary) {
    backgroundColor = theme.colors.ctaBg;
    borderColor = theme.colors.ctaBg;
    borderWidth = 1;
    borderRadius = isIconOnly ? theme.radius.pill : theme.radius.button;
    foreground = theme.colors.ctaFg;
  } else {
    backgroundColor = active
      ? theme.colors.accentTint
      : focused
        ? theme.colors.focusFill
        : theme.colors.actionGlassBg;
    borderColor = focused
      ? theme.colors.focusRingColor
      : active
        ? theme.colors.accent
        : theme.colors.actionGlassBorder;
    borderWidth = focused ? theme.focus.ringWidth : 1;
    borderRadius = isIconOnly ? theme.radius.pill : theme.radius.button;
  }

  const shouldScale = (isPrimary || isGlassPrimary) && focused && !theme.reduceMotion;
  const scale = shouldScale ? theme.focus.buttonScale : 1;

  const webShortcutProps =
    (Platform.OS as string) === 'web' && p.keyShortcuts !== undefined
      ? ({ 'aria-keyshortcuts': p.keyShortcuts } as Record<string, unknown>)
      : undefined;

  const useBlur = isGlassPrimary || isPillCta || (!isPrimary && !isBare);

  return (
    <Pressable
      testID={p.testID}
      {...(p.isTv ? { focusable: false } : {})}
      {...webShortcutProps}
      accessibilityRole="button"
      accessibilityLabel={p.accessibilityLabel ?? p.label ?? p.testID}
      accessibilityState={{ selected: focused }}
      onHoverIn={() => {
        setHovered(true);
        p.onHoverIn?.();
      }}
      onHoverOut={() => {
        setHovered(false);
        p.onHoverOut?.();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={(e) => {
        blurWebTarget(e.currentTarget);
        p.onPress();
      }}
      style={[
        styles.button,
        p.compact === true ? styles.compactButton : null,
        isPillCta ? styles.pillCtaButton : null,
        isBare && hasLabel ? styles.bareLabelButton : null,
        isIconOnly ? styles.iconButton : isPrimary ? styles.primaryButton : null,
        isIconOnly
          ? { width: boxSize, height: boxSize, minWidth: boxSize, minHeight: boxSize }
          : null,
        {
          backgroundColor,
          borderColor,
          borderWidth,
          borderRadius,
          ...(shouldScale ? { transform: [{ scale }] } : {}),
        },
        useBlur ? webBackdropBlur(12) : undefined,
        webTransition(theme, 'background-color, border-color, transform'),
        !p.isTv ? webCursorPointer() : undefined,
      ]}
    >
      {p.loading === true ? (
        <ActivityIndicator testID={`${p.testID}-loading`} size="small" color={foreground} />
      ) : p.icon !== undefined ? (
        <Icon name={p.icon} size={iconSize} color={foreground} />
      ) : null}
      {!isIconOnly && hasLabel ? (
        <Text
          numberOfLines={1}
          style={[
            p.compact === true ? theme.typography.caption : theme.typography.title,
            p.tabularLabel === true ? TABULAR_NUMS_STYLE : undefined,
            { color: foreground, fontWeight: isPrimary ? '700' : '600' },
          ]}
        >
          {p.label}
        </Text>
      ) : null}
      {(isPrimary || isGlassPrimary) && focused ? (
        <View
          pointerEvents="none"
          testID={`${p.testID}-focus-ring`}
          style={[
            styles.primaryFocusRing,
            {
              borderRadius: isIconOnly ? theme.radius.pill : theme.radius.button + 4,
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
  clock: { fontWeight: '600' },
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
  compactButton: { minHeight: 34, paddingHorizontal: 10, paddingVertical: 5 },
  bareLabelButton: { minHeight: 36, paddingHorizontal: 10, paddingVertical: 6 },
  pillCtaButton: { minHeight: 36, paddingHorizontal: 16, paddingVertical: 9 },
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
