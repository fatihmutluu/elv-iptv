import { type ReactElement, useCallback, useState } from 'react';
import {
  Image,
  type ImageResizeMode,
  Platform,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useUiAdapters } from '../adapters';
import { useTheme, webTransition } from '../theme';
import {
  type DeadHostRegistry,
  defaultDeadHostRegistry,
  extractNativeImageError,
  type ImageErrorInfo,
} from './dead-host-registry';

/** Default maximum decode dimension on low-RAM TV targets (`#311`). */
export const DEFAULT_MAX_DECODE_PX = 480;
const MIN_DECODE_PX = 32;

/** Props of {@link ArtworkImage}. */
export interface ArtworkImageProps {
  uri?: string | null;
  /** Human-readable title used for accessibility and clean monogram fallback when image is absent/dead. */
  label: string;
  aspectRatio?: number;
  resizeMode?: ImageResizeMode;
  /** Caps decoded image dimensions on native targets via `UiAdapters.renderImage` (`#311`). */
  maxDecodePx?: number;
  /** Optional rounded corner radius override (defaults to `theme.radius.card`). */
  borderRadius?: number;
  /** Subtle neutral plate improving readability of dark transparent channel logos (`#126`). */
  logoBackdrop?: boolean;
  /** Smoothly zooms artwork (`scale(1.05)`) on pointer hover; disabled when `theme.reduceMotion` is true. */
  zoomed?: boolean;
  /**
   * Marks artwork as purely decorative backdrop art: sets `pointerEvents="none"` and hides
   * containers from assistive/tvOS focus hit-testing (`#186`).
   */
  decorative?: boolean;
  /** Injectable dead-host circuit breaker (defaults to {@link defaultDeadHostRegistry}, `#202`). */
  deadHosts?: DeadHostRegistry;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function monogramOf(label: string): string {
  const words = label.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return 'ELV';
  if (words.length === 1) {
    return Array.from(words[0] ?? '')
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const second = Array.from(words[1] ?? '')[0] ?? '';
  return `${first}${second}`.toUpperCase();
}

function clampDecodePx(maxDecodePx: number): number {
  const safe = Number.isFinite(maxDecodePx) ? maxDecodePx : DEFAULT_MAX_DECODE_PX;
  return Math.max(MIN_DECODE_PX, Math.round(safe));
}

/**
 * Memory-safe poster, backdrop, and channel-logo image primitive (`#126`, `#202`, `#311`).
 * Short-circuits confirmed dead hosts synchronously (safe under pooled `TvList` slot recycling),
 * supports native decode-capped renderers through `UiAdaptersProvider`, renders an atmospheric
 * tonal fallback tile with zero broken-image chrome, and supports smooth hover zoom.
 */
export function ArtworkImage({
  uri,
  label,
  aspectRatio,
  resizeMode = 'cover',
  maxDecodePx = DEFAULT_MAX_DECODE_PX,
  borderRadius,
  logoBackdrop = false,
  zoomed = false,
  decorative = false,
  deadHosts = defaultDeadHostRegistry,
  style,
  testID,
}: ArtworkImageProps): ReactElement {
  const theme = useTheme();
  const adapters = useUiAdapters();
  const trimmedUri = uri?.trim() ?? '';
  const cappedPx = clampDecodePx(maxDecodePx);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const failed =
    trimmedUri.length === 0 || failedUri === trimmedUri || deadHosts.isDead(trimmedUri);

  const handleLoad = useCallback(() => {
    setFailedUri(null);
    if (trimmedUri.length > 0) deadHosts.recordSuccess(trimmedUri);
  }, [trimmedUri, deadHosts]);

  const handleError = useCallback(
    (error?: ImageErrorInfo) => {
      if (trimmedUri.length > 0) {
        deadHosts.recordFailure(trimmedUri, error);
        setFailedUri(trimmedUri);
      }
    },
    [trimmedUri, deadHosts],
  );

  const handleNativeError = useCallback(
    (event: unknown) => {
      handleError(extractNativeImageError(event));
    },
    [handleError],
  );

  const radius = borderRadius ?? theme.radius.card;
  const containerBg = logoBackdrop ? theme.colors.subtleHighlight : theme.colors.bgCard;
  const shouldZoom = zoomed && !theme.reduceMotion;
  const zoomStyle: StyleProp<ViewStyle> = [
    styles.image,
    shouldZoom ? { transform: [{ scale: 1.05 }] } : undefined,
    webTransition(theme, 'transform', 350),
  ];

  const fallbackSheen: ViewStyle | undefined =
    Platform.OS === 'web'
      ? ({
          backgroundImage: `linear-gradient(145deg, ${theme.colors.bgElevated} 0%, ${theme.colors.bgCard} 68%, ${theme.colors.bgSurface} 100%)`,
        } as unknown as ViewStyle)
      : undefined;

  const isWeb = Platform.OS === 'web';
  const decorativeViewProps = decorative
    ? ({
        pointerEvents: 'none',
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no',
      } as const)
    : undefined;

  return (
    <View
      testID={testID}
      {...decorativeViewProps}
      style={[
        styles.frame,
        {
          backgroundColor: containerBg,
          borderRadius: radius,
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        },
        style,
      ]}
    >
      {failed ? (
        <View
          testID={testID ? `${testID}-fallback` : undefined}
          accessible={!decorative}
          {...(decorative ? {} : { accessibilityLabel: label })}
          {...decorativeViewProps}
          style={[styles.fallback, { backgroundColor: theme.colors.bgCard }, fallbackSheen]}
        >
          <Text
            numberOfLines={1}
            style={[theme.typography.title, { color: theme.colors.textMuted, letterSpacing: 1 }]}
          >
            {monogramOf(label)}
          </Text>
        </View>
      ) : (
        <View
          testID={testID ? `${testID}-zoom` : undefined}
          {...decorativeViewProps}
          style={zoomStyle}
        >
          {adapters.renderImage ? (
            adapters.renderImage({
              uri: trimmedUri,
              resizeMode,
              maxDecodePx: cappedPx,
              style: styles.image,
              ...(decorative ? {} : { accessibilityLabel: label }),
              onLoad: handleLoad,
              onError: handleError,
            })
          ) : (
            <Image
              testID={testID ? `${testID}-img` : undefined}
              source={
                isWeb ? { uri: trimmedUri } : { uri: trimmedUri, width: cappedPx, height: cappedPx }
              }
              resizeMode={resizeMode}
              resizeMethod="resize"
              fadeDuration={0}
              {...(decorative ? { accessible: false } : { accessibilityLabel: label })}
              onLoad={handleLoad}
              onError={handleNativeError}
              style={styles.image}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    position: 'relative',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
