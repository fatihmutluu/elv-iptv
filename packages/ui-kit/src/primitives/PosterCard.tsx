import {
  type ComponentRef,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
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

/** Viewport-relative bounding rect emitted by {@link PosterCard} on Desktop web hover. */
export interface PosterCardHoverRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
  /** Desktop pointer-only hover preview entry callback with measured viewport rect (Wave R3). */
  readonly onHoverPreviewStart?: (rect: PosterCardHoverRect) => void;
  /** Desktop pointer-only hover preview exit callback fired on leave, press, or unmount (Wave R3). */
  readonly onHoverPreviewEnd?: () => void;
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

const DEFAULT_FALLBACK_CARD_WIDTH = 168;

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scaleFont(size: number, fontScale: number): number {
  return Math.round(size * fontScale * 2) / 2;
}

function extractDomRect(candidate: unknown): PosterCardHoverRect | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const node = candidate as { getBoundingClientRect?: () => Record<string, unknown> };
  if (typeof node.getBoundingClientRect !== 'function') return null;
  const rect = node.getBoundingClientRect();
  const x =
    typeof rect.left === 'number' && Number.isFinite(rect.left)
      ? rect.left
      : typeof rect.x === 'number' && Number.isFinite(rect.x)
        ? rect.x
        : null;
  const y =
    typeof rect.top === 'number' && Number.isFinite(rect.top)
      ? rect.top
      : typeof rect.y === 'number' && Number.isFinite(rect.y)
        ? rect.y
        : null;
  const w = typeof rect.width === 'number' && Number.isFinite(rect.width) ? rect.width : null;
  const h = typeof rect.height === 'number' && Number.isFinite(rect.height) ? rect.height : null;
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function readCardBoundingRect(
  containerNode: unknown,
  event: unknown,
  fallbackWidth: number | undefined,
  aspectRatio: number,
): PosterCardHoverRect {
  const fromNode = extractDomRect(containerNode);
  if (fromNode !== null) return fromNode;
  const evt = event as { currentTarget?: unknown; target?: unknown } | undefined;
  const fromCurrentTarget = extractDomRect(evt?.currentTarget);
  if (fromCurrentTarget !== null) return fromCurrentTarget;
  const fromTarget = extractDomRect(evt?.target);
  if (fromTarget !== null) return fromTarget;
  const safeWidth =
    typeof fallbackWidth === 'number' && Number.isFinite(fallbackWidth) && fallbackWidth > 0
      ? fallbackWidth
      : DEFAULT_FALLBACK_CARD_WIDTH;
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 2 / 3;
  return {
    x: 0,
    y: 0,
    width: safeWidth,
    height: Math.round(safeWidth / safeRatio),
  };
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
  onHoverPreviewStart,
  onHoverPreviewEnd,
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
  const containerRef = useRef<ComponentRef<typeof View>>(null);
  const pointerHoverActiveRef = useRef(false);
  const hoverPreviewActiveRef = useRef(false);
  const onHoverPreviewStartRef = useRef(onHoverPreviewStart);
  const onHoverPreviewEndRef = useRef(onHoverPreviewEnd);
  onHoverPreviewStartRef.current = onHoverPreviewStart;
  onHoverPreviewEndRef.current = onHoverPreviewEnd;

  const canHoverPreview =
    Platform.OS === 'web' &&
    viewport.formFactor === 'desktop' &&
    viewport.inputModality === 'pointer' &&
    onHoverPreviewStart !== undefined;

  const startHoverPreview = useCallback(
    (event?: unknown) => {
      if (!canHoverPreview || onHoverPreviewStartRef.current === undefined) return;
      if (hoverPreviewActiveRef.current) return;
      hoverPreviewActiveRef.current = true;
      const rect = readCardBoundingRect(containerRef.current, event, width, aspectRatio);
      onHoverPreviewStartRef.current(rect);
    },
    [aspectRatio, canHoverPreview, width],
  );

  const endHoverPreview = useCallback(() => {
    if (!hoverPreviewActiveRef.current) return;
    hoverPreviewActiveRef.current = false;
    onHoverPreviewEndRef.current?.();
  }, []);

  useEffect(() => {
    if (!canHoverPreview) {
      endHoverPreview();
    }
  }, [canHoverPreview, endHoverPreview]);

  useEffect(() => {
    return () => {
      endHoverPreview();
    };
  }, [endHoverPreview]);

  const handleFocus = useCallback(() => {
    setNativeFocused(true);
    onFocus?.();
  }, [onFocus]);
  const handleBlur = useCallback(() => setNativeFocused(false), []);
  const handlePointerEnter = useCallback(
    (event?: unknown) => {
      pointerHoverActiveRef.current = true;
      setHovered(true);
      startHoverPreview(event);
    },
    [startHoverPreview],
  );
  const handlePointerLeave = useCallback(() => {
    pointerHoverActiveRef.current = false;
    setHovered(false);
    endHoverPreview();
  }, [endHoverPreview]);
  const handleHoverIn = useCallback(
    (event?: unknown) => {
      setHovered(true);
      startHoverPreview(event);
    },
    [startHoverPreview],
  );
  const handleHoverOut = useCallback(() => {
    if (pointerHoverActiveRef.current) return;
    setHovered(false);
    endHoverPreview();
  }, [endHoverPreview]);
  const handlePress = useCallback(() => {
    endHoverPreview();
    onPress?.();
  }, [endHoverPreview, onPress]);
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
  const clamped = progress !== undefined ? clampProgress(progress) : undefined;
  const cardTransition = webTransition(theme, 'transform, opacity');
  const restShadow = webShadow('0 8px 22px rgba(0, 0, 0, 0.44)');
  const cursor = webCursorPointer();
  const fontFamilyStyle =
    theme.typography.title.fontFamily !== undefined
      ? { fontFamily: theme.typography.title.fontFamily }
      : undefined;

  return (
    <View
      ref={containerRef}
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
        onPress={onPress !== undefined ? handlePress : undefined}
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
                  NATIVE_SHADOW_REST,
                  restShadow,
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
