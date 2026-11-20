import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { TABULAR_NUMS_STYLE, useTheme } from '../theme';
import { useViewport } from '../viewport';
import { ArtworkImage } from './ArtworkImage';
import type { DeadHostRegistry } from './dead-host-registry';
import { MicroPill } from './MicroPill';

/** Props of {@link PosterCard}. */
export interface PosterCardProps {
  title: string;
  meta?: string;
  imageUri?: string | null;
  aspectRatio?: number;
  progress?: number;
  badge?: string;
  onPress?: () => void;
  onFocus?: () => void;
  focused?: boolean;
  width?: number;
  deadHosts?: DeadHostRegistry;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Pure-artwork vertical catalog card (`2:3` default) for Movies, Series, My List, and More Like
 * This rails (`UI_UX_PHILOSOPHY.md` §1). Never wraps poster + title in a boxed container and never
 * duplicates title copy over the artwork.
 */
export function PosterCard({
  title,
  meta,
  imageUri,
  aspectRatio = 2 / 3,
  progress,
  badge,
  onPress,
  onFocus,
  focused,
  width,
  deadHosts,
  testID,
  style,
}: PosterCardProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const [nativeFocused, setNativeFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleFocus = useCallback(() => {
    setNativeFocused(true);
    onFocus?.();
  }, [onFocus]);
  const handleBlur = useCallback(() => setNativeFocused(false), []);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const trimmedBadge = badge?.trim() ?? '';
  const clamped = progress !== undefined ? clampProgress(progress) : undefined;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={meta ? `${title}, ${meta}` : title}
      focusable
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={(state) => {
        const activeFocus = focused ?? (nativeFocused || Boolean(state.focused));
        const showTvFocus = focused === true || (viewport.inputModality === 'tv' && activeFocus);
        const showPointerHover = !showTvFocus && viewport.inputModality === 'pointer' && hovered;
        const pressScale = theme.reduceMotion ? 1 : 0.98;
        const scale = state.pressed
          ? pressScale
          : showTvFocus || showPointerHover
            ? theme.focus.cardScale
            : 1;

        return [
          {
            ...(width !== undefined ? { width } : {}),
            opacity: state.pressed ? 0.92 : 1,
            transform: [{ scale }],
          },
          style,
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
              style={[styles.artworkFrame, { borderRadius: theme.radius.card }]}
            >
              <ArtworkImage
                uri={imageUri}
                label={title}
                aspectRatio={aspectRatio}
                borderRadius={theme.radius.card}
                {...(deadHosts !== undefined ? { deadHosts } : {})}
                testID={testID ? `${testID}-image` : undefined}
              />
              {trimmedBadge.length > 0 ? (
                <View
                  pointerEvents="none"
                  style={[styles.badgeSlot, { top: theme.spacing.xs, left: theme.spacing.xs }]}
                >
                  <MicroPill label={trimmedBadge} testID={testID ? `${testID}-badge` : undefined} />
                </View>
              ) : null}
              {clamped !== undefined ? (
                <View
                  pointerEvents="none"
                  testID={testID ? `${testID}-progress` : undefined}
                  style={[styles.progressTrack, { backgroundColor: theme.colors.scrimStrong }]}
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
              {showTvFocus || showPointerHover ? (
                <View
                  pointerEvents="none"
                  testID={testID ? `${testID}-focus-ring` : undefined}
                  style={[
                    StyleSheet.absoluteFill,
                    {
                      borderRadius: theme.radius.card,
                      borderWidth: showTvFocus ? theme.focus.ringWidth : 1.5,
                      borderColor: showTvFocus
                        ? theme.colors.focusRingColor
                        : theme.colors.glassBorder,
                    },
                  ]}
                />
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={[
                theme.typography.title,
                { color: theme.colors.textPrimary, marginTop: theme.spacing.xs },
              ]}
            >
              {title}
            </Text>
            {meta ? (
              <Text
                numberOfLines={1}
                testID={testID ? `${testID}-meta` : undefined}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textSecondary, marginTop: 2 },
                ]}
              >
                {meta}
              </Text>
            ) : null}
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  artworkFrame: {
    overflow: 'hidden',
    position: 'relative',
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
});
