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
import { type ReactElement, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePlaybackTicker } from './usePlaybackTicker';
import { formatPlaybackPosition } from './VodProgressBar';

/** Synchronized ARIA `aria-keyshortcuts` descriptors for desktop web player controls (#283). */
export const PLAYER_KEY_SHORTCUTS = {
  playPause: 'Space k',
  seekBack: 'ArrowLeft j',
  seekForward: 'ArrowRight l',
  mute: 'm',
  fullscreen: 'f',
  tracks: 'c',
  back: 'Escape',
} as const;

const readClockText = (anchor: ClockAnchor | undefined, nowMs: number): string =>
  anchor === undefined ? '--:--' : formatPlaybackPosition(positionAt(anchor, nowMs));

const sameText = (a: string, b: string): boolean => a === b;

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
        theme.typography.title,
        TABULAR_NUMS_STYLE,
        styles.clock,
        { color: theme.colors.textPrimary },
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

/** Props of {@link OsdButton}. */
export interface OsdButtonProps {
  testID: string;
  label?: string;
  accessibilityLabel?: string;
  keyShortcuts?: string;
  icon?: IconName;
  iconSize?: number;
  variant?: 'default' | 'primary' | 'icon';
  size?: number;
  circular?: boolean;
  compact?: boolean;
  tabularLabel?: boolean;
  active?: boolean;
  onPress: () => void;
  isTv: boolean;
  tvFocused?: boolean;
}

/** Tokenized Cinema Quietude player OSD button (`default`, high-contrast `primary`, or `icon`). */
export function OsdButton(p: OsdButtonProps): ReactElement {
  const theme = useTheme();
  const isPrimary = p.variant === 'primary';
  const isIconOnly = p.variant === 'icon' || p.circular === true;
  const focused = p.tvFocused === true;
  const active = p.active === true;
  const boxSize = p.size ?? 40;
  const iconSize = p.iconSize ?? 18;

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

  const webShortcutProps =
    (Platform.OS as string) === 'web' && p.keyShortcuts !== undefined
      ? ({ 'aria-keyshortcuts': p.keyShortcuts } as Record<string, unknown>)
      : undefined;

  return (
    <Pressable
      testID={p.testID}
      {...(p.isTv ? { focusable: false } : {})}
      {...webShortcutProps}
      accessibilityRole="button"
      accessibilityLabel={p.accessibilityLabel ?? p.label ?? p.testID}
      accessibilityState={{ selected: focused }}
      onPress={(e) => {
        blurWebTarget(e.currentTarget);
        p.onPress();
      }}
      style={[
        styles.button,
        p.compact === true ? styles.compactButton : null,
        isIconOnly ? styles.iconButton : isPrimary ? styles.primaryButton : null,
        isIconOnly
          ? { width: boxSize, height: boxSize, minWidth: boxSize, minHeight: boxSize }
          : null,
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
      {p.icon !== undefined ? <Icon name={p.icon} size={iconSize} color={foreground} /> : null}
      {!isIconOnly && p.label !== undefined ? (
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
      {isPrimary && focused ? (
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
  canvasTapTarget: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
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

const TAP_DRAG_GUARD_PX = 10;

function readTapPoint(event: unknown): { x: number; y: number } | null {
  if (typeof event !== 'object' || event === null) return null;
  const n = (event as { nativeEvent?: { pageX?: unknown; pageY?: unknown } }).nativeEvent;
  if (
    typeof n?.pageX === 'number' &&
    Number.isFinite(n.pageX) &&
    typeof n?.pageY === 'number' &&
    Number.isFinite(n.pageY)
  ) {
    return { x: n.pageX, y: n.pageY };
  }
  return null;
}

/** Transparent full-canvas touch catcher for phone/tablet tap-to-toggle OSD with 10 px drag guard (`#421`). */
export function PlayerCanvasTapTarget({
  onTouchActivity,
  onToggleOsd,
}: {
  readonly onTouchActivity: () => void;
  readonly onToggleOsd: () => void;
}): ReactElement {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const movedTooFarRef = useRef(false);

  return (
    <Pressable
      testID="player-canvas-tap-target"
      focusable={false}
      accessible={false}
      style={styles.canvasTapTarget}
      onPressIn={(e) => {
        onTouchActivity();
        startRef.current = readTapPoint(e);
        movedTooFarRef.current = false;
      }}
      onTouchMove={(e) => {
        const start = startRef.current;
        const pt = readTapPoint(e);
        if (
          start !== null &&
          pt !== null &&
          Math.hypot(pt.x - start.x, pt.y - start.y) > TAP_DRAG_GUARD_PX
        ) {
          movedTooFarRef.current = true;
        }
      }}
      onPress={(e) => {
        const start = startRef.current;
        const end = readTapPoint(e);
        const tooFar =
          movedTooFarRef.current ||
          (start !== null &&
            end !== null &&
            Math.hypot(end.x - start.x, end.y - start.y) > TAP_DRAG_GUARD_PX);
        startRef.current = null;
        movedTooFarRef.current = false;
        if (!tooFar) onToggleOsd();
      }}
    />
  );
}
