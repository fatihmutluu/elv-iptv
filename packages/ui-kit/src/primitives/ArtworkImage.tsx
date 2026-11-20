import { type ReactElement, useCallback, useState } from 'react';
import {
  Image,
  type ImageResizeMode,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useUiAdapters } from '../adapters';
import { useTheme } from '../theme';
import { type DeadHostRegistry, defaultDeadHostRegistry } from './dead-host-registry';

/** Default maximum decode dimension on low-RAM TV targets (`#311`). */
export const DEFAULT_MAX_DECODE_PX = 480;

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

/**
 * Memory-safe poster, backdrop, and channel-logo image primitive (`#126`, `#202`, `#311`).
 * Short-circuits confirmed dead hosts synchronously (safe under pooled `TvList` slot recycling),
 * supports native decode-capped renderers through `UiAdaptersProvider`, and renders a quiet tonal
 * monogram fallback with zero broken-image chrome.
 */
export function ArtworkImage({
  uri,
  label,
  aspectRatio,
  resizeMode = 'cover',
  maxDecodePx = DEFAULT_MAX_DECODE_PX,
  borderRadius,
  logoBackdrop = false,
  deadHosts = defaultDeadHostRegistry,
  style,
  testID,
}: ArtworkImageProps): ReactElement {
  const theme = useTheme();
  const adapters = useUiAdapters();
  const trimmedUri = uri?.trim() ?? '';
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const failed =
    trimmedUri.length === 0 || failedUri === trimmedUri || deadHosts.isDead(trimmedUri);

  const handleLoad = useCallback(() => {
    if (trimmedUri.length > 0) deadHosts.recordSuccess(trimmedUri);
  }, [trimmedUri, deadHosts]);

  const handleError = useCallback(() => {
    if (trimmedUri.length > 0) {
      deadHosts.recordFailure(trimmedUri);
      setFailedUri(trimmedUri);
    }
  }, [trimmedUri, deadHosts]);

  const radius = borderRadius ?? theme.radius.card;
  const containerBg = logoBackdrop ? theme.colors.subtleHighlight : theme.colors.bgCard;

  return (
    <View
      testID={testID}
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
          accessible
          accessibilityLabel={label}
          style={[styles.fallback, { backgroundColor: theme.colors.bgCard }]}
        >
          <Text
            numberOfLines={1}
            style={[theme.typography.title, { color: theme.colors.textMuted, letterSpacing: 1 }]}
          >
            {monogramOf(label)}
          </Text>
        </View>
      ) : adapters.renderImage ? (
        adapters.renderImage({
          uri: trimmedUri,
          resizeMode,
          maxDecodePx,
          style: styles.image,
          accessibilityLabel: label,
          onLoad: handleLoad,
          onError: handleError,
        })
      ) : (
        <Image
          testID={testID ? `${testID}-img` : undefined}
          source={{ uri: trimmedUri }}
          resizeMode={resizeMode}
          accessibilityLabel={label}
          onLoad={handleLoad}
          onError={handleError}
          style={styles.image}
        />
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
