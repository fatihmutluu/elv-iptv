import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useI18n } from '../i18n';
import { TABULAR_NUMS_STYLE, useTheme } from '../theme';
import { useViewport } from '../viewport';
import { ArtworkImage } from './ArtworkImage';
import type { DeadHostRegistry } from './dead-host-registry';
import { MicroPill } from './MicroPill';

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
  onPress?: () => void;
  onFocus?: () => void;
  focused?: boolean;
  width?: number;
  deadHosts?: DeadHostRegistry;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/**
 * Pure-artwork `16:9` card reserved exclusively for Continue Watching and Live Broadcast rails
 * (`UI_UX_PHILOSOPHY.md` §1). Supports an optional top-left `LIVE`/metadata pill, clamped `3px`
 * bottom accent progress bar, and zero boxed wrapper chrome.
 */
export function WideCard({
  title,
  subtitle,
  imageUri,
  live = false,
  liveLabel,
  progress,
  badge,
  logoBackdrop = false,
  onPress,
  onFocus,
  focused,
  width,
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

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
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
        const scale = state.pressed
          ? theme.reduceMotion
            ? 1
            : 0.98
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
                aspectRatio={16 / 9}
                borderRadius={theme.radius.card}
                logoBackdrop={logoBackdrop}
                {...(deadHosts !== undefined ? { deadHosts } : {})}
                testID={testID ? `${testID}-image` : undefined}
              />
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
            {subtitle ? (
              <Text
                numberOfLines={1}
                testID={testID ? `${testID}-subtitle` : undefined}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textSecondary, marginTop: 2 },
                ]}
              >
                {subtitle}
              </Text>
            ) : null}
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  artworkFrame: { overflow: 'hidden', position: 'relative' },
  pillCluster: { position: 'absolute', flexDirection: 'row', alignItems: 'center' },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  progressFill: { height: '100%' },
});
