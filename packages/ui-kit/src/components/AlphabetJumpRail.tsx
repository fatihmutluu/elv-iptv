import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useI18n } from '../i18n';
import {
  TABULAR_NUMS_STYLE,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
  webTransition,
} from '../theme';
import { useViewport } from '../viewport';

/** Canonical 27 alphabetical slots rendered by {@link AlphabetJumpRail}. */
export const ALPHABET_JUMP_LETTERS: readonly string[] = [
  '#',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
] as const;

/** Bucket entry supplied to {@link AlphabetJumpRail}. */
export interface AlphabetJumpBucket {
  readonly letter: string;
  readonly offset: number;
  readonly count: number;
}

/** Props of {@link AlphabetJumpRail}. */
export interface AlphabetJumpRailProps {
  readonly buckets: readonly AlphabetJumpBucket[];
  readonly activeLetter?: string | null;
  readonly focusedLetter?: string | null;
  readonly onSelectLetter: (letter: string, offset: number) => void;
  readonly accessibilityLabel?: string;
  readonly isTv?: boolean;
  readonly testID?: string;
}

interface ResolvedSlot {
  readonly letter: string;
  readonly offset: number;
  readonly count: number;
  readonly available: boolean;
}

function findNearestAvailableSlot(
  slots: readonly ResolvedSlot[],
  targetIndex: number,
): ResolvedSlot | null {
  const clamped = Math.max(0, Math.min(slots.length - 1, targetIndex));
  const exact = slots[clamped];
  if (exact?.available) return exact;

  for (let delta = 1; delta < slots.length; delta++) {
    const lower = slots[clamped - delta];
    if (lower?.available) return lower;
    const upper = slots[clamped + delta];
    if (upper?.available) return upper;
  }
  return null;
}

interface MeasurableRailView {
  measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void;
  getBoundingClientRect?: () => { top: number; height: number };
}

function readWindowScrollY(): number {
  const g = globalThis as { scrollY?: unknown };
  return typeof g.scrollY === 'number' && Number.isFinite(g.scrollY) ? g.scrollY : 0;
}

/**
 * Cinema Quietude v2 trailing vertical A–Z alphabetical jump rail (`#`, `A–Z`).
 * Supports 1-click/tap jumping, vertical touch/pointer drag-scrubbing with an inline
 * floating preview badge, and non-focusable TV D-pad highlight (`focusable={false}` on TV).
 */
export function AlphabetJumpRail({
  buckets,
  activeLetter,
  focusedLetter,
  onSelectLetter,
  accessibilityLabel,
  isTv,
  testID = 'alphabet-jump-rail',
}: AlphabetJumpRailProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const resolvedIsTv = isTv ?? viewport.inputModality === 'tv';

  const slots = useMemo((): readonly ResolvedSlot[] => {
    const byLetter = new Map<string, AlphabetJumpBucket>();
    for (const bucket of buckets) {
      const normalized = bucket.letter.trim().toUpperCase();
      byLetter.set(normalized, bucket);
    }
    return ALPHABET_JUMP_LETTERS.map((letter) => {
      const bucket = byLetter.get(letter);
      const count = bucket ? Math.max(0, bucket.count) : 0;
      const offset = bucket ? Math.max(0, bucket.offset) : 0;
      return {
        letter,
        offset,
        count,
        available: count > 0,
      };
    });
  }, [buckets]);

  const hasAvailable = useMemo(() => slots.some((slot) => slot.available), [slots]);

  const railRef = useRef<ComponentRef<typeof View> | null>(null);
  const railTopYRef = useRef<number | null>(null);
  const railHeightRef = useRef(0);
  const lastScrubLetterRef = useRef<string | null>(null);
  const [scrubLetter, setScrubLetter] = useState<string | null>(null);
  const [hoveredLetter, setHoveredLetter] = useState<string | null>(null);

  const measureRailBounds = useCallback(() => {
    const node = railRef.current as MeasurableRailView | null;
    if (!node) return;
    if (typeof node.getBoundingClientRect === 'function') {
      const rect = node.getBoundingClientRect();
      if (Number.isFinite(rect.top)) {
        railTopYRef.current = rect.top + readWindowScrollY();
      }
      if (Number.isFinite(rect.height) && rect.height > 0) {
        railHeightRef.current = rect.height;
      }
      return;
    }
    if (typeof node.measureInWindow === 'function') {
      node.measureInWindow((_x, y, _w, h) => {
        if (Number.isFinite(y)) railTopYRef.current = y;
        if (Number.isFinite(h) && h > 0) railHeightRef.current = h;
      });
    }
  }, []);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      if (Number.isFinite(height) && height > 0) {
        railHeightRef.current = height;
      }
      if (railTopYRef.current === null && Number.isFinite(y)) {
        railTopYRef.current = y;
      }
      measureRailBounds();
    },
    [measureRailBounds],
  );

  const scrubFromEvent = useCallback(
    (event: GestureResponderEvent) => {
      if (!hasAvailable) return;
      const nativeEvent = event?.nativeEvent;
      if (!nativeEvent) return;
      const { pageY, locationY } = nativeEvent;
      let relativeY: number | undefined;
      if (typeof pageY === 'number' && Number.isFinite(pageY)) {
        const topY = railTopYRef.current ?? 0;
        relativeY = pageY - topY;
      } else if (typeof locationY === 'number' && Number.isFinite(locationY)) {
        relativeY = locationY;
      }
      if (relativeY === undefined || !Number.isFinite(relativeY)) return;
      const height = railHeightRef.current > 0 ? railHeightRef.current : slots.length * 16;
      const ratio = Math.max(0, Math.min(0.9999, relativeY / height));
      const index = Math.floor(ratio * slots.length);
      const nearest = findNearestAvailableSlot(slots, index);
      if (!nearest) return;
      setScrubLetter(nearest.letter);
      if (lastScrubLetterRef.current !== nearest.letter) {
        lastScrubLetterRef.current = nearest.letter;
        onSelectLetter(nearest.letter, nearest.offset);
      }
    },
    [hasAvailable, onSelectLetter, slots],
  );

  const handleResponderGrant = useCallback(
    (event: GestureResponderEvent) => {
      lastScrubLetterRef.current = null;
      measureRailBounds();
      scrubFromEvent(event);
    },
    [measureRailBounds, scrubFromEvent],
  );

  const handleResponderMove = useCallback(
    (event: GestureResponderEvent) => {
      scrubFromEvent(event);
    },
    [scrubFromEvent],
  );

  const handleResponderRelease = useCallback(() => {
    lastScrubLetterRef.current = null;
    setScrubLetter(null);
  }, []);

  const canScrub = !resolvedIsTv && hasAvailable;
  const shouldSetResponder = useCallback(() => canScrub, [canScrub]);

  const transition = webTransition(theme, 'color, background-color, border-color, opacity');
  const cursor = webCursorPointer();
  const railBlur = webBackdropBlur(12);
  const previewLetter = scrubLetter;

  return (
    <View
      ref={railRef}
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? i18n.t('catalog.alphabetJumpLabel')}
      onLayout={handleLayout}
      onStartShouldSetResponder={shouldSetResponder}
      onMoveShouldSetResponderCapture={shouldSetResponder}
      onMoveShouldSetResponder={shouldSetResponder}
      onResponderGrant={handleResponderGrant}
      onResponderMove={handleResponderMove}
      onResponderRelease={handleResponderRelease}
      onResponderTerminate={handleResponderRelease}
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.glassBg,
          borderColor: theme.colors.surfaceBorder,
          borderRadius: theme.radius.pill,
          paddingVertical: theme.spacing.xxs,
          paddingHorizontal: 2,
        },
        railBlur,
      ]}
    >
      {previewLetter ? (
        <View
          pointerEvents="none"
          testID={`${testID}-scrub-preview`}
          style={[
            styles.previewBadge,
            {
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.glassBorder,
              borderRadius: theme.radius.card,
              right: 34,
            },
            railBlur,
            webShadow('0 8px 24px rgba(0, 0, 0, 0.52)'),
          ]}
        >
          <Text
            testID={`${testID}-scrub-preview-text`}
            style={[
              theme.typography.h2,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textPrimary, fontWeight: '700' },
            ]}
          >
            {previewLetter}
          </Text>
        </View>
      ) : null}

      {slots.map((slot) => {
        const isActive =
          activeLetter !== undefined &&
          activeLetter !== null &&
          activeLetter.toUpperCase() === slot.letter;
        const isFocused =
          focusedLetter !== undefined &&
          focusedLetter !== null &&
          focusedLetter.toUpperCase() === slot.letter;
        const isScrubbed = scrubLetter === slot.letter;
        const isHovered = hoveredLetter === slot.letter;
        const itemTestId = `${testID}-letter-${slot.letter}`;

        return (
          <Pressable
            key={slot.letter}
            testID={itemTestId}
            disabled={!slot.available}
            focusable={!resolvedIsTv && slot.available}
            accessibilityRole="button"
            accessibilityLabel={i18n.t('catalog.alphabetJumpToLetter', { letter: slot.letter })}
            accessibilityState={{
              disabled: !slot.available,
              selected: isActive,
            }}
            onPress={() => {
              if (slot.available) {
                onSelectLetter(slot.letter, slot.offset);
              }
            }}
            onHoverIn={() => {
              if (slot.available) setHoveredLetter(slot.letter);
            }}
            onHoverOut={() => setHoveredLetter((prev) => (prev === slot.letter ? null : prev))}
            style={[
              styles.slot,
              {
                borderRadius: theme.radius.button,
                opacity: slot.available ? 1 : 0.28,
                backgroundColor: isFocused
                  ? theme.colors.focusFill
                  : isActive || isScrubbed
                    ? theme.colors.accentTint
                    : isHovered && slot.available
                      ? theme.colors.subtleHighlight
                      : 'transparent',
              },
              transition,
              slot.available ? cursor : undefined,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                theme.typography.micro,
                TABULAR_NUMS_STYLE,
                {
                  color:
                    isFocused || isActive || isScrubbed
                      ? theme.colors.textPrimary
                      : slot.available
                        ? theme.colors.textSecondary
                        : theme.colors.textMuted,
                  fontWeight: isActive || isFocused || isScrubbed ? '700' : '600',
                },
              ]}
            >
              {slot.letter}
            </Text>
            {isActive && !isFocused ? (
              <View
                pointerEvents="none"
                testID={`${itemTestId}-active-dot`}
                style={[styles.activeIndicator, { backgroundColor: theme.colors.accent }]}
              />
            ) : null}
            {isFocused ? (
              <View
                pointerEvents="none"
                testID={`${itemTestId}-focus-ring`}
                style={[
                  styles.focusRing,
                  {
                    borderRadius: theme.radius.button,
                    borderWidth: theme.focus.ringWidth,
                    borderColor: theme.colors.focusRingColor,
                  },
                ]}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    width: 24,
    userSelect: 'none',
  },
  slot: {
    position: 'relative',
    width: 20,
    minHeight: 15,
    paddingVertical: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeIndicator: {
    position: 'absolute',
    left: 1,
    top: 3,
    bottom: 3,
    width: 2,
    borderRadius: 1,
  },
  focusRing: {
    position: 'absolute',
    top: -1,
    bottom: -1,
    left: -1,
    right: -1,
  },
  previewBadge: {
    position: 'absolute',
    top: '42%',
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 25,
  },
});
