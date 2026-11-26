import { memo, type ReactElement, useCallback, useRef, useState } from 'react';
import {
  type GestureResponderEvent,
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { Icon } from '../icons';
import {
  type ContextMenuAnchor,
  TABULAR_NUMS_STYLE,
  useTheme,
  webCursorPointer,
  webShadow,
  webTransition,
} from '../theme';
import { useViewport } from '../viewport';
import { ArtworkImage } from './ArtworkImage';
import type { DeadHostRegistry } from './dead-host-registry';
import { MicroPill } from './MicroPill';
import { Tooltip } from './Tooltip';

/** Desktop pointer-only hover quick-action handlers for {@link PosterCard} (`#409`). */
export interface PosterCardQuickActions {
  readonly onPlay?: () => void;
  readonly playLabel?: string;
  readonly isFavorite?: boolean;
  readonly onToggleFavorite?: () => void;
  readonly favoriteLabel?: string;
  readonly isWatched?: boolean;
  readonly onToggleWatched?: () => void;
  readonly watchedLabel?: string;
}

/** Props of {@link PosterCard}. */
export interface PosterCardProps {
  title: string;
  meta?: string;
  imageUri?: string | null;
  aspectRatio?: number;
  progress?: number;
  badge?: string;
  /** Shows a restrained watched checkmark pill when `true` (`#409`, `#502`). */
  readonly allWatched?: boolean;
  /** Pointer-only hover quick-actions (`#409`). Never rendered on touch or TV. */
  readonly quickActions?: PosterCardQuickActions;
  onPress?: () => void;
  /** Invoked on desktop web right-click (with pointer anchor) or touch/TV long-press (centered). */
  readonly onContextMenu?: (anchor?: ContextMenuAnchor) => void;
  onFocus?: () => void;
  focusable?: boolean;
  focused?: boolean;
  width?: number;
  /** Caps decoded poster dimensions on native targets via `ArtworkImage` (defaults to `320`). */
  maxDecodePx?: number;
  deadHosts?: DeadHostRegistry;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const NATIVE_SHADOW_REST: ViewStyle = {
  shadowColor: 'rgba(0, 0, 0, 1)',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.36,
  shadowRadius: 12,
  elevation: 6,
};

const NATIVE_SHADOW_HOVER: ViewStyle = {
  shadowColor: 'rgba(0, 0, 0, 1)',
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.48,
  shadowRadius: 18,
  elevation: 10,
};

const NATIVE_SHADOW_FOCUS: ViewStyle = {
  shadowColor: 'rgba(0, 0, 0, 1)',
  shadowOffset: { width: 0, height: 14 },
  shadowOpacity: 0.56,
  shadowRadius: 22,
  elevation: 14,
};

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scaleFont(size: number, fontScale: number): number {
  return Math.round(size * fontScale * 2) / 2;
}

function stopQuickActionEvent(event: GestureResponderEvent | undefined): void {
  const evt = event as { stopPropagation?: () => void; preventDefault?: () => void } | undefined;
  evt?.stopPropagation?.();
  evt?.preventDefault?.();
}

interface WebContextMenuEventLike {
  preventDefault?: () => void;
  stopPropagation?: () => void;
  clientX?: number;
  clientY?: number;
  nativeEvent?: { clientX?: number; clientY?: number };
}

function readContextMenuAnchor(
  event: WebContextMenuEventLike | undefined,
): ContextMenuAnchor | undefined {
  const x = event?.nativeEvent?.clientX ?? event?.clientX;
  const y = event?.nativeEvent?.clientY ?? event?.clientY;
  if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
    return { x, y };
  }
  return undefined;
}

function PosterCardInner({
  title,
  meta,
  imageUri,
  aspectRatio = 2 / 3,
  progress,
  badge,
  allWatched,
  quickActions,
  onPress,
  onContextMenu,
  onFocus,
  focusable = true,
  focused,
  width,
  maxDecodePx = 320,
  deadHosts,
  testID,
  style,
}: PosterCardProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const [nativeFocused, setNativeFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const pointerHoverActiveRef = useRef(false);

  const handleFocus = useCallback(() => {
    setNativeFocused(true);
    onFocus?.();
  }, [onFocus]);
  const handleBlur = useCallback(() => setNativeFocused(false), []);
  const handlePointerEnter = useCallback(() => {
    pointerHoverActiveRef.current = true;
    setHovered(true);
  }, []);
  const handlePointerLeave = useCallback(() => {
    pointerHoverActiveRef.current = false;
    setHovered(false);
  }, []);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => {
    if (pointerHoverActiveRef.current) return;
    setHovered(false);
  }, []);
  const handleLongPress = useCallback(() => {
    onContextMenu?.();
  }, [onContextMenu]);
  const handleWebContextMenu = useCallback(
    (event: WebContextMenuEventLike | undefined) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const anchor = readContextMenuAnchor(event);
      if (anchor !== undefined) {
        onContextMenu?.(anchor);
      } else {
        onContextMenu?.();
      }
    },
    [onContextMenu],
  );
  const webContextMenuProps =
    Platform.OS === 'web' && onContextMenu !== undefined
      ? ({ onContextMenu: handleWebContextMenu } as Record<string, unknown>)
      : {};

  const trimmedBadge = badge?.trim() ?? '';
  const showAllWatched = allWatched === true;
  const hasQuickActions =
    quickActions !== undefined &&
    (quickActions.onPlay !== undefined ||
      quickActions.onToggleFavorite !== undefined ||
      quickActions.onToggleWatched !== undefined);
  const clamped = progress !== undefined ? clampProgress(progress) : undefined;
  const cardTransition = webTransition(theme, 'transform, opacity');
  const shadowTransition = webTransition(theme, 'box-shadow');
  const cursor = webCursorPointer();
  const fontFamilyStyle =
    theme.typography.title.fontFamily !== undefined
      ? { fontFamily: theme.typography.title.fontFamily }
      : undefined;

  return (
    <View
      testID={testID ? `${testID}-hover-container` : undefined}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      style={[width !== undefined ? { width } : undefined, style]}
    >
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={meta ? `${title}, ${meta}` : title}
        focusable={focusable}
        onPress={onPress}
        {...(onContextMenu !== undefined
          ? { onLongPress: handleLongPress, delayLongPress: 450 }
          : {})}
        {...webContextMenuProps}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={(state) => {
          const activeFocus = focused ?? (nativeFocused || Boolean(state.focused));
          const showTvFocus = focused === true || (viewport.inputModality === 'tv' && activeFocus);
          const pressScale = theme.reduceMotion ? 1 : 0.98;
          const scale = state.pressed ? pressScale : showTvFocus ? theme.focus.cardScale : 1;

          return [
            {
              width: '100%',
              opacity: state.pressed ? 0.92 : 1,
              transform: [{ scale }],
            },
            cardTransition,
            cursor,
          ];
        }}
      >
        {({ focused: stateFocused }) => {
          const activeFocus = focused ?? (nativeFocused || Boolean(stateFocused));
          const showTvFocus = focused === true || (viewport.inputModality === 'tv' && activeFocus);
          const showPointerHover = !showTvFocus && viewport.inputModality === 'pointer' && hovered;

          const frameShadow = showTvFocus
            ? [NATIVE_SHADOW_FOCUS, webShadow('0 18px 36px rgba(0, 0, 0, 0.72)')]
            : showPointerHover
              ? [NATIVE_SHADOW_HOVER, webShadow('0 14px 32px rgba(0, 0, 0, 0.65)')]
              : [NATIVE_SHADOW_REST, webShadow('0 8px 22px rgba(0, 0, 0, 0.44)')];

          return (
            <>
              <View
                testID={testID ? `${testID}-artwork-frame` : undefined}
                style={[
                  styles.artworkShadow,
                  {
                    borderRadius: theme.radius.card,
                    backgroundColor: theme.colors.bgCard,
                  },
                  frameShadow,
                  shadowTransition,
                ]}
              >
                <View style={[styles.artworkClip, { borderRadius: theme.radius.card }]}>
                  <ArtworkImage
                    uri={imageUri}
                    label={title}
                    aspectRatio={aspectRatio}
                    maxDecodePx={maxDecodePx}
                    borderRadius={theme.radius.card}
                    zoomed={showPointerHover}
                    {...(deadHosts !== undefined ? { deadHosts } : {})}
                    testID={testID ? `${testID}-image` : undefined}
                  />
                  {trimmedBadge.length > 0 ? (
                    <View
                      pointerEvents="none"
                      style={[styles.badgeSlot, { top: theme.spacing.xs, left: theme.spacing.xs }]}
                    >
                      <MicroPill
                        label={trimmedBadge}
                        testID={testID ? `${testID}-badge` : undefined}
                      />
                    </View>
                  ) : null}
                  {showAllWatched ? (
                    <View
                      pointerEvents="none"
                      style={[styles.badgeSlot, { top: theme.spacing.xs, right: theme.spacing.xs }]}
                    >
                      <MicroPill
                        icon="check"
                        tone="success"
                        testID={testID ? `${testID}-watched-badge` : undefined}
                      />
                    </View>
                  ) : null}
                  {showPointerHover && hasQuickActions && quickActions !== undefined ? (
                    <View
                      pointerEvents="box-none"
                      style={[
                        styles.quickActionsOverlay,
                        { backgroundColor: theme.colors.scrimSoft },
                      ]}
                    >
                      {quickActions.onPlay !== undefined ? (
                        <Tooltip
                          content={quickActions.playLabel ?? title}
                          testID={testID ? `${testID}-quick-play-tooltip` : undefined}
                        >
                          <Pressable
                            testID={testID ? `${testID}-quick-play` : undefined}
                            accessibilityRole="button"
                            accessibilityLabel={quickActions.playLabel ?? title}
                            focusable={false}
                            onPress={(e) => {
                              stopQuickActionEvent(e);
                              quickActions.onPlay?.();
                            }}
                            style={({ pressed }) => [
                              styles.quickPlayButton,
                              {
                                borderRadius: theme.radius.pill,
                                backgroundColor: theme.colors.ctaBg,
                                opacity: pressed ? 0.88 : 1,
                              },
                              cursor,
                            ]}
                          >
                            <Icon name="play" size={18} color={theme.colors.ctaFg} />
                          </Pressable>
                        </Tooltip>
                      ) : null}
                      {quickActions.onToggleFavorite !== undefined ||
                      quickActions.onToggleWatched !== undefined ? (
                        <View
                          pointerEvents="box-none"
                          style={[
                            styles.quickCornerRow,
                            {
                              bottom: theme.spacing.xs + (clamped !== undefined ? 4 : 0),
                              right: theme.spacing.xs,
                            },
                          ]}
                        >
                          {quickActions.onToggleFavorite !== undefined ? (
                            <Tooltip
                              content={quickActions.favoriteLabel}
                              testID={testID ? `${testID}-quick-favorite-tooltip` : undefined}
                            >
                              <Pressable
                                testID={testID ? `${testID}-quick-favorite` : undefined}
                                accessibilityRole="button"
                                accessibilityLabel={quickActions.favoriteLabel}
                                accessibilityState={{ selected: Boolean(quickActions.isFavorite) }}
                                focusable={false}
                                onPress={(e) => {
                                  stopQuickActionEvent(e);
                                  quickActions.onToggleFavorite?.();
                                }}
                                style={({ pressed }) => [
                                  styles.quickCornerButton,
                                  {
                                    borderRadius: theme.radius.pill,
                                    backgroundColor: quickActions.isFavorite
                                      ? theme.colors.accentTint
                                      : theme.colors.scrimStrong,
                                    borderColor: quickActions.isFavorite
                                      ? theme.colors.accent
                                      : theme.colors.actionGlassBorder,
                                    opacity: pressed ? 0.85 : 1,
                                  },
                                  cursor,
                                ]}
                              >
                                <Icon
                                  name={quickActions.isFavorite ? 'starFilled' : 'star'}
                                  size={13}
                                  color={
                                    quickActions.isFavorite
                                      ? theme.colors.accent
                                      : theme.colors.textPrimary
                                  }
                                />
                              </Pressable>
                            </Tooltip>
                          ) : null}
                          {quickActions.onToggleWatched !== undefined ? (
                            <Tooltip
                              content={quickActions.watchedLabel}
                              testID={testID ? `${testID}-quick-watched-tooltip` : undefined}
                            >
                              <Pressable
                                testID={testID ? `${testID}-quick-watched` : undefined}
                                accessibilityRole="button"
                                accessibilityLabel={quickActions.watchedLabel}
                                accessibilityState={{ selected: Boolean(quickActions.isWatched) }}
                                focusable={false}
                                onPress={(e) => {
                                  stopQuickActionEvent(e);
                                  quickActions.onToggleWatched?.();
                                }}
                                style={({ pressed }) => [
                                  styles.quickCornerButton,
                                  {
                                    borderRadius: theme.radius.pill,
                                    backgroundColor: theme.colors.scrimStrong,
                                    borderColor: quickActions.isWatched
                                      ? theme.colors.successColor
                                      : theme.colors.actionGlassBorder,
                                    opacity: pressed ? 0.85 : 1,
                                  },
                                  cursor,
                                ]}
                              >
                                <Icon
                                  name="check"
                                  size={13}
                                  color={
                                    quickActions.isWatched
                                      ? theme.colors.successColor
                                      : theme.colors.textPrimary
                                  }
                                />
                              </Pressable>
                            </Tooltip>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                  {clamped !== undefined ? (
                    <View
                      pointerEvents="none"
                      testID={testID ? `${testID}-progress` : undefined}
                      style={[
                        styles.progressTrack,
                        { backgroundColor: theme.colors.actionGlassHoverBg },
                      ]}
                    >
                      <View
                        testID={testID ? `${testID}-progress-fill` : undefined}
                        style={[
                          styles.progressFill,
                          {
                            width: `${Math.round(clamped * 1000) / 10}%`,
                            backgroundColor: theme.colors.accent,
                          },
                        ]}
                      />
                    </View>
                  ) : null}
                </View>
                {showTvFocus || showPointerHover ? (
                  <View
                    pointerEvents="none"
                    testID={testID ? `${testID}-focus-ring` : undefined}
                    style={[
                      styles.outerRing,
                      showTvFocus
                        ? {
                            top: -3,
                            bottom: -3,
                            left: -3,
                            right: -3,
                            borderRadius: theme.radius.card + 3,
                            borderWidth: theme.focus.ringWidth,
                            borderColor: theme.colors.focusRingColor,
                          }
                        : {
                            top: -1.5,
                            bottom: -1.5,
                            left: -1.5,
                            right: -1.5,
                            borderRadius: theme.radius.card + 1.5,
                            borderWidth: 1.5,
                            borderColor: theme.colors.hoverRingBorder,
                          },
                    ]}
                  />
                ) : null}
              </View>
              <View style={styles.info}>
                <Text
                  numberOfLines={1}
                  style={[
                    fontFamilyStyle,
                    {
                      fontSize: scaleFont(12.5, theme.fontScale),
                      lineHeight: Math.round(17 * theme.fontScale),
                      fontWeight: '600',
                      letterSpacing: -0.1,
                      color: theme.colors.textPrimary,
                    },
                  ]}
                >
                  {title}
                </Text>
                {meta ? (
                  <Text
                    numberOfLines={1}
                    testID={testID ? `${testID}-meta` : undefined}
                    style={[
                      fontFamilyStyle,
                      TABULAR_NUMS_STYLE,
                      {
                        fontSize: scaleFont(11, theme.fontScale),
                        lineHeight: Math.round(15 * theme.fontScale),
                        fontWeight: '500',
                        color: theme.colors.textMuted,
                        marginTop: 2,
                      },
                    ]}
                  >
                    {meta}
                  </Text>
                ) : null}
              </View>
            </>
          );
        }}
      </Pressable>
    </View>
  );
}

/**
 * Pure-artwork vertical catalog card (`2:3` default) for Movies, Series, My List, and More Like
 * This rails (`UI_UX_PHILOSOPHY.md` §1). Never wraps poster + title in a boxed container and never
 * duplicates title copy over the artwork.
 */
export const PosterCard = memo(PosterCardInner);
PosterCard.displayName = 'PosterCard';

const styles = StyleSheet.create({
  artworkShadow: {
    position: 'relative',
  },
  artworkClip: {
    overflow: 'hidden',
    position: 'relative',
  },
  outerRing: {
    position: 'absolute',
  },
  badgeSlot: {
    position: 'absolute',
  },
  quickActionsOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickPlayButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickCornerRow: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  quickCornerButton: {
    width: 28,
    height: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
  },
  progressFill: {
    height: '100%',
  },
  info: {
    paddingTop: 7,
    paddingHorizontal: 2,
  },
});
