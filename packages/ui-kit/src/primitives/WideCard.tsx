import { memo, type ReactElement, useCallback, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useI18n } from '../i18n';
import { Icon } from '../icons';
import { TABULAR_NUMS_STYLE, useTheme, webCursorPointer, webShadow, webTransition } from '../theme';
import { useViewport } from '../viewport';
import { ArtworkImage } from './ArtworkImage';
import type { DeadHostRegistry } from './dead-host-registry';
import { MicroPill } from './MicroPill';
import { Scrim } from './Scrim';

/** Props of {@link WideCard}. */
export interface WideCardProps {
  title: string;
  subtitle?: string;
  imageUri?: string | null;
  live?: boolean;
  liveLabel?: string;
  progress?: number;
  badge?: string;
  logoBackdrop?: boolean;
  /** Renders the circular play pill at bottom-left over artwork (defaults to `progress !== undefined && !live`). */
  showPlayBadge?: boolean;
  onPress?: () => void;
  onFocus?: () => void;
  focusable?: boolean;
  focused?: boolean;
  width?: number;
  /** Caps decoded backdrop dimensions on native targets via `ArtworkImage` (defaults to `480`). */
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
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function scaleFont(size: number, fontScale: number): number {
  return Math.round(size * fontScale * 2) / 2;
}

function WideCardInner({
  title,
  subtitle,
  imageUri,
  live = false,
  liveLabel,
  progress,
  badge,
  logoBackdrop = false,
  showPlayBadge,
  onPress,
  onFocus,
  focusable = true,
  focused,
  width,
  maxDecodePx = 480,
  deadHosts,
  testID,
  style,
}: WideCardProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const resolvedLiveLabel = liveLabel ?? i18n.t('ui.liveBadge');
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
  const hasPills = live || trimmedBadge.length > 0;
  const showBottomScrim = clamped !== undefined || live;
  const resolvedShowPlayBadge = showPlayBadge ?? (clamped !== undefined && !live);
  const cardTransition = webTransition(theme, 'transform, opacity');
  const shadowTransition = webTransition(theme, 'box-shadow');
  const cursor = webCursorPointer();
  const fontFamilyStyle =
    theme.typography.title.fontFamily !== undefined
      ? { fontFamily: theme.typography.title.fontFamily }
      : undefined;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      focusable={focusable}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={(state) => {
        const activeFocus = focused ?? (nativeFocused || Boolean(state.focused));
        const showTvFocus = focused === true || (viewport.inputModality === 'tv' && activeFocus);
        const scale = state.pressed
          ? theme.reduceMotion
            ? 1
            : 0.98
          : showTvFocus
            ? theme.focus.cardScale
            : 1;

        return [
          {
            ...(width !== undefined ? { width } : {}),
            opacity: state.pressed ? 0.92 : 1,
            transform: [{ scale }],
          },
          cardTransition,
          cursor,
          style,
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
                  aspectRatio={16 / 9}
                  maxDecodePx={maxDecodePx}
                  borderRadius={theme.radius.card}
                  logoBackdrop={logoBackdrop}
                  zoomed={showPointerHover}
                  {...(deadHosts !== undefined ? { deadHosts } : {})}
                  testID={testID ? `${testID}-image` : undefined}
                />
                {showBottomScrim ? (
                  <Scrim
                    direction="bottom"
                    style={styles.bottomScrim}
                    testID={testID ? `${testID}-scrim` : undefined}
                  />
                ) : null}
                {hasPills ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.pillCluster,
                      { top: theme.spacing.xs, left: theme.spacing.xs, gap: theme.spacing.xxs },
                    ]}
                  >
                    {live ? (
                      <MicroPill
                        label={resolvedLiveLabel}
                        tone="live"
                        testID={testID ? `${testID}-live-pill` : undefined}
                      />
                    ) : null}
                    {trimmedBadge.length > 0 ? (
                      <MicroPill
                        label={trimmedBadge}
                        testID={testID ? `${testID}-badge` : undefined}
                      />
                    ) : null}
                  </View>
                ) : null}
                {resolvedShowPlayBadge ? (
                  <View
                    pointerEvents="none"
                    testID={testID ? `${testID}-play-badge` : undefined}
                    style={[
                      styles.playBadge,
                      {
                        borderRadius: theme.radius.pill,
                        backgroundColor: theme.colors.ctaBg,
                      },
                      webShadow('0 4px 12px rgba(0, 0, 0, 0.55)'),
                    ]}
                  >
                    <Icon name="play" size={13} color={theme.colors.ctaFg} />
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
                    fontSize: scaleFont(13, theme.fontScale),
                    lineHeight: Math.round(18 * theme.fontScale),
                    fontWeight: '600',
                    letterSpacing: -0.1,
                    color: theme.colors.textPrimary,
                  },
                ]}
              >
                {title}
              </Text>
              {subtitle ? (
                <Text
                  numberOfLines={1}
                  testID={testID ? `${testID}-subtitle` : undefined}
                  style={[
                    fontFamilyStyle,
                    TABULAR_NUMS_STYLE,
                    {
                      fontSize: scaleFont(11, theme.fontScale),
                      lineHeight: Math.round(15 * theme.fontScale),
                      fontWeight: '500',
                      color: theme.colors.textSecondary,
                      marginTop: 2,
                    },
                  ]}
                >
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </>
        );
      }}
    </Pressable>
  );
}

/**
 * Pure-artwork `16:9` card reserved exclusively for Continue Watching and Live Broadcast rails
 * (`UI_UX_PHILOSOPHY.md` §1). Supports an optional top-left `LIVE`/metadata pill, bottom gradient
 * scrim, circular resume play pill, clamped `3px` bottom accent progress bar, and zero boxed chrome.
 */
export const WideCard = memo(WideCardInner);
WideCard.displayName = 'WideCard';

const styles = StyleSheet.create({
  artworkShadow: { position: 'relative' },
  artworkClip: { overflow: 'hidden', position: 'relative' },
  outerRing: { position: 'absolute' },
  bottomScrim: { top: '35%' },
  pillCluster: { position: 'absolute', flexDirection: 'row', alignItems: 'center' },
  playBadge: {
    position: 'absolute',
    left: 10,
    bottom: 11,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  progressFill: { height: '100%' },
  info: { paddingTop: 7, paddingHorizontal: 2 },
});
