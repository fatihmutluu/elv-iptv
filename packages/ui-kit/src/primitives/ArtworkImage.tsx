import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { defaultLoadedArtworkUris, type LoadedUriCache } from './artwork-cache';
import {
  type DeadHostRegistry,
  defaultDeadHostRegistry,
  extractNativeImageError,
  type ImageErrorInfo,
} from './dead-host-registry';

/** Default maximum decode dimension on low-RAM TV targets (`#311`). */
export const DEFAULT_MAX_DECODE_PX = 480;
const MIN_DECODE_PX = 32;
const REVEAL_DURATION_MS = 180;

/** Channel-logo dark-mode readability treatment (`#126`). */
export type LogoBackdropMode = 'plate' | 'invert' | 'off';

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
  /**
   * Explicit channel-logo readability treatment (`#126`). Takes precedence over `logoBackdrop`:
   * `'plate'` renders a light-tinted neutral plate, `'invert'` applies a CSS invert filter on web
   * and a light-neutral backing plate on native, and `'off'` renders raw artwork on `bgCard`.
   */
  logoBackdropMode?: LogoBackdropMode;
  /** Smoothly zooms artwork (`scale(1.05)`) on pointer hover; disabled when `theme.reduceMotion` is true. */
  zoomed?: boolean;
  /**
   * Marks artwork as purely decorative backdrop art: sets `pointerEvents="none"` and hides
   * containers from assistive/tvOS focus hit-testing (`#186`).
   */
  decorative?: boolean;
  /** Injectable dead-host circuit breaker (defaults to {@link defaultDeadHostRegistry}, `#202`). */
  deadHosts?: DeadHostRegistry;
  /** Injectable loaded-URI session cache for zero-flicker revisits (defaults to {@link defaultLoadedArtworkUris}, `#405`). */
  loadedUris?: LoadedUriCache;
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

const DECORATIVE_VIEW_PROPS = {
  pointerEvents: 'none',
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no',
} as const;

const MAX_REMEMBERED_LOCAL_URIS = 1_000;
const resolvedUrisByCache = new WeakMap<LoadedUriCache, Map<string, string>>();

function getRememberedLocalUri(cache: LoadedUriCache, sourceUri: string): string | null {
  if (!cache.has(sourceUri)) return null;
  return resolvedUrisByCache.get(cache)?.get(sourceUri) ?? null;
}

function rememberLocalUri(cache: LoadedUriCache, sourceUri: string, localUri: string): void {
  let map = resolvedUrisByCache.get(cache);
  if (!map) {
    map = new Map<string, string>();
    resolvedUrisByCache.set(cache, map);
  }
  if (map.has(sourceUri)) {
    map.delete(sourceUri);
  } else if (map.size >= MAX_REMEMBERED_LOCAL_URIS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(sourceUri, localUri);
}

function forgetLocalUri(cache: LoadedUriCache, sourceUri: string): void {
  resolvedUrisByCache.get(cache)?.delete(sourceUri);
}

/**
 * Memory-safe poster, backdrop, and channel-logo image primitive (`#126`, `#202`, `#311`, `#405`).
 * Short-circuits confirmed dead hosts synchronously (safe under pooled `TvList` slot recycling),
 * resolves optional bounded disk-cache URIs before issuing an image request (preventing duplicate
 * downloads), guards late load/error callbacks against recycled-slot URI swaps, renders an ambient
 * placeholder fading smoothly into loaded artwork (with zero flicker on revisited URIs), supports
 * dark-mode logo readability modes, and renders an atmospheric monogram fallback on error.
 */
export function ArtworkImage({
  uri,
  label,
  aspectRatio,
  resizeMode = 'cover',
  maxDecodePx = DEFAULT_MAX_DECODE_PX,
  borderRadius,
  logoBackdrop = false,
  logoBackdropMode,
  zoomed = false,
  decorative = false,
  deadHosts = defaultDeadHostRegistry,
  loadedUris = defaultLoadedArtworkUris,
  style,
  testID,
}: ArtworkImageProps): ReactElement {
  const theme = useTheme();
  const adapters = useUiAdapters();
  const trimmedUri = uri?.trim() ?? '';
  const cappedPx = clampDecodePx(maxDecodePx);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const cachedOnRender = trimmedUri.length > 0 && loadedUris.has(trimmedUri);
  const [loadedUri, setLoadedUri] = useState<string | null>(() =>
    cachedOnRender ? trimmedUri : null,
  );
  const [resolvedState, setResolvedState] = useState<{
    readonly source: string;
    readonly local: string | null;
  } | null>(null);
  const [rejectedLocalUri, setRejectedLocalUri] = useState<string | null>(null);

  const failed =
    trimmedUri.length === 0 || failedUri === trimmedUri || deadHosts.isDead(trimmedUri);
  const isLoaded = trimmedUri.length > 0 && (loadedUri === trimmedUri || cachedOnRender);
  const resolveUriFn = adapters.artworkCache?.resolveUri;

  useEffect(() => {
    if (!resolveUriFn || trimmedUri.length === 0 || failed || cachedOnRender) return;
    let cancelled = false;
    let pending: Promise<string | null>;
    try {
      pending = Promise.resolve(resolveUriFn(trimmedUri, cappedPx));
    } catch {
      setResolvedState({ source: trimmedUri, local: null });
      return;
    }
    void pending
      .then((localUri) => {
        if (cancelled) return;
        const usableLocal = localUri && localUri !== trimmedUri ? localUri : null;
        setResolvedState((prev) =>
          prev && prev.source === trimmedUri && prev.local === usableLocal
            ? prev
            : { source: trimmedUri, local: usableLocal },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setResolvedState((prev) =>
          prev && prev.source === trimmedUri && prev.local === null
            ? prev
            : { source: trimmedUri, local: null },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [resolveUriFn, trimmedUri, cappedPx, failed, cachedOnRender]);

  const resolutionReady =
    !resolveUriFn ||
    cachedOnRender ||
    (resolvedState !== null && resolvedState.source === trimmedUri);

  const rawLocalCandidate = cachedOnRender
    ? getRememberedLocalUri(loadedUris, trimmedUri)
    : resolvedState !== null && resolvedState.source === trimmedUri
      ? resolvedState.local
      : null;
  const localCandidate =
    rawLocalCandidate !== null && rawLocalCandidate !== rejectedLocalUri ? rawLocalCandidate : null;
  const effectiveUri = localCandidate ?? trimmedUri;

  const activeUriRef = useRef(trimmedUri);
  const activeRenderUriRef = useRef(effectiveUri);
  activeUriRef.current = trimmedUri;
  activeRenderUriRef.current = effectiveUri;

  useEffect(() => {
    activeUriRef.current = trimmedUri;
    activeRenderUriRef.current = effectiveUri;
    return () => {
      activeUriRef.current = '';
      activeRenderUriRef.current = '';
    };
  }, [trimmedUri, effectiveUri]);

  const handleLoadFor = useCallback(
    (sourceUri: string, renderUri: string) => () => {
      if (
        sourceUri.length === 0 ||
        sourceUri !== activeUriRef.current ||
        renderUri !== activeRenderUriRef.current
      ) {
        return;
      }
      setFailedUri(null);
      deadHosts.recordSuccess(sourceUri);
      loadedUris.markLoaded(sourceUri);
      if (renderUri !== sourceUri) {
        rememberLocalUri(loadedUris, sourceUri, renderUri);
      }
      setLoadedUri(sourceUri);
    },
    [deadHosts, loadedUris],
  );

  const handleErrorFor = useCallback(
    (sourceUri: string, renderUri: string) => (error?: ImageErrorInfo) => {
      if (
        sourceUri.length === 0 ||
        sourceUri !== activeUriRef.current ||
        renderUri !== activeRenderUriRef.current
      ) {
        return;
      }
      if (renderUri !== sourceUri) {
        forgetLocalUri(loadedUris, sourceUri);
        setRejectedLocalUri(renderUri);
        return;
      }
      deadHosts.recordFailure(sourceUri, error);
      setFailedUri(sourceUri);
    },
    [deadHosts, loadedUris],
  );

  const handleLoad = useMemo(
    () => handleLoadFor(trimmedUri, effectiveUri),
    [handleLoadFor, trimmedUri, effectiveUri],
  );

  const handleError = useMemo(
    () => handleErrorFor(trimmedUri, effectiveUri),
    [handleErrorFor, trimmedUri, effectiveUri],
  );

  const handleNativeError = useCallback(
    (event: unknown) => {
      handleError(extractNativeImageError(event));
    },
    [handleError],
  );

  const isWeb = Platform.OS === 'web';
  const radius = borderRadius ?? theme.radius.card;
  const resolvedLogoMode: LogoBackdropMode = logoBackdropMode ?? (logoBackdrop ? 'plate' : 'off');
  const usesPlate = resolvedLogoMode === 'plate' || (resolvedLogoMode === 'invert' && !isWeb);
  const showPlate = !failed && usesPlate;
  const usesWebInvert = resolvedLogoMode === 'invert' && isWeb;

  const containerBg =
    !failed && resolvedLogoMode === 'plate'
      ? theme.colors.subtleHighlight
      : !failed && resolvedLogoMode === 'invert' && !isWeb
        ? theme.colors.actionGlassHoverBg
        : theme.colors.bgCard;
  const logoPlateBorderStyle: ViewStyle | undefined =
    showPlate && theme.highContrast
      ? { borderWidth: 1, borderColor: theme.colors.surfaceBorder }
      : undefined;
  const logoPlatePaddingStyle: ViewStyle | undefined =
    showPlate && resizeMode === 'contain' ? { padding: theme.spacing.xxs } : undefined;
  const webInvertStyle: ViewStyle | undefined = usesWebInvert
    ? ({ filter: 'invert(1) brightness(1.15)' } as unknown as ViewStyle)
    : undefined;

  const shouldZoom = zoomed && !theme.reduceMotion;
  const zoomStyle: StyleProp<ViewStyle> = [
    styles.image,
    shouldZoom ? { transform: [{ scale: 1.05 }] } : undefined,
    webTransition(theme, 'transform', 350),
  ];

  const revealOpaque = isLoaded || theme.reduceMotion;
  const revealStyle: StyleProp<ViewStyle> = [
    styles.image,
    { opacity: revealOpaque ? 1 : 0 },
    cachedOnRender ? undefined : webTransition(theme, 'opacity', REVEAL_DURATION_MS),
    webInvertStyle,
  ];

  const fallbackSheen: ViewStyle | undefined = isWeb
    ? ({
        backgroundImage: `linear-gradient(145deg, ${theme.colors.bgElevated} 0%, ${theme.colors.bgCard} 68%, ${theme.colors.bgSurface} 100%)`,
      } as unknown as ViewStyle)
    : undefined;

  const placeholderSheen: ViewStyle | undefined = isWeb
    ? ({
        backgroundImage: `linear-gradient(135deg, ${theme.colors.bgElevated} 0%, ${theme.colors.bgCard} 55%, ${theme.colors.bgElevated} 100%)`,
      } as unknown as ViewStyle)
    : undefined;

  const decorativeViewProps = decorative ? DECORATIVE_VIEW_PROPS : undefined;

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
        logoPlateBorderStyle,
        logoPlatePaddingStyle,
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
        <>
          {!isLoaded && !showPlate ? (
            <View
              testID={testID ? `${testID}-placeholder` : undefined}
              {...DECORATIVE_VIEW_PROPS}
              style={[
                styles.placeholder,
                { backgroundColor: theme.colors.bgElevated },
                placeholderSheen,
              ]}
            />
          ) : null}
          {resolutionReady ? (
            <View
              testID={testID ? `${testID}-zoom` : undefined}
              {...decorativeViewProps}
              style={zoomStyle}
            >
              <View
                testID={testID ? `${testID}-reveal` : undefined}
                {...decorativeViewProps}
                style={revealStyle}
              >
                {adapters.renderImage ? (
                  adapters.renderImage({
                    uri: effectiveUri,
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
                      isWeb
                        ? { uri: effectiveUri }
                        : { uri: effectiveUri, width: cappedPx, height: cappedPx }
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
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    position: 'relative',
  },
  placeholder: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
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
