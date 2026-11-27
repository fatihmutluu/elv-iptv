import { ArtworkImage, Scrim, useTheme, useUiAdapters } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { BlurredAmbientBackdrop } from './BlurredAmbientBackdrop';

/** Debounce window (ms) before committing a newly focused card's ambient backdrop (`#414`). */
export const AMBIENT_BACKDROP_DEBOUNCE_MS = 500;

/** Crossfade duration (ms) when transitioning between committed ambient backdrops (`#414`). */
export const AMBIENT_BACKDROP_CROSSFADE_MS = 320;

const AMBIENT_WASH_OPACITY = 0.56;
const STANDARD_DECODE_PX = 960;
const LOW_POWER_DECODE_PX = 640;

interface BackdropEntry {
  readonly key: string;
  readonly uri: string;
  readonly title: string;
  readonly portrait: boolean;
}

/** Props of {@link AmbientBackdrop}. */
export interface AmbientBackdropProps {
  /** Stable identifier of the focused item whose artwork should tint the background, or `null` to clear. */
  readonly backdropKey: string | null;
  /** Artwork URI to display behind browse rails, or `null` when unavailable. */
  readonly uri: string | null;
  /** Optional accessible title passed to decorative `ArtworkImage`. */
  readonly title?: string;
  /** True when `uri` is a vertical portrait poster rather than a 16:9 landscape backdrop. */
  readonly portrait?: boolean;
  /** Enables single-layer low-decode mode (640 px, no dual-layer crossfade) for 3 GB Apple TV tier (`#414`). */
  readonly lowPowerTier?: boolean;
  readonly testID?: string;
}

/**
 * 500ms-debounced full-bleed ambient artwork backdrop for 10-foot TV browse screens (`#414`).
 * Cancels pending timers during rapid D-pad navigation so intermediate cards never trigger image loads,
 * softly crossfades committed artwork over 320 ms behind Cinema Quietude v2 scrims, and falls back to
 * a single-layer instant swap when `theme.reduceMotion` or `lowPowerTier` is active.
 */
export function AmbientBackdrop({
  backdropKey,
  uri,
  title = '',
  portrait = false,
  lowPowerTier,
  testID = 'ambient-backdrop',
}: AmbientBackdropProps): ReactElement | null {
  const theme = useTheme();
  const adapters = useUiAdapters();
  const effectiveLowPower = lowPowerTier ?? adapters.lowPowerTier ?? false;
  const singleLayer = theme.reduceMotion || effectiveLowPower;
  const decodePx = effectiveLowPower ? LOW_POWER_DECODE_PX : STANDARD_DECODE_PX;
  const normalizedUri = uri !== null && uri.trim().length > 0 ? uri.trim() : null;
  const hasTarget = backdropKey !== null && normalizedUri !== null;

  const [committed, setCommitted] = useState<BackdropEntry | null>(null);
  const [prevBackdrop, setPrevBackdrop] = useState<BackdropEntry | null>(null);
  const committedRef = useRef<BackdropEntry | null>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const visibilityAnim = useRef(new Animated.Value(0)).current;
  const activeAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (singleLayer) {
      activeAnimRef.current?.stop();
      activeAnimRef.current = null;
      setPrevBackdrop(null);
      fadeAnim.setValue(1);
      visibilityAnim.setValue(committedRef.current !== null ? 1 : 0);
    }
  }, [fadeAnim, singleLayer, visibilityAnim]);

  useEffect(() => {
    const stopActiveAnim = () => {
      activeAnimRef.current?.stop();
      activeAnimRef.current = null;
    };

    if (!hasTarget || backdropKey === null || normalizedUri === null) {
      if (committedRef.current === null) return undefined;
      stopActiveAnim();
      if (singleLayer) {
        committedRef.current = null;
        setPrevBackdrop(null);
        setCommitted(null);
        visibilityAnim.setValue(0);
        fadeAnim.setValue(1);
        return undefined;
      }
      const fadeOut = Animated.timing(visibilityAnim, {
        toValue: 0,
        duration: AMBIENT_BACKDROP_CROSSFADE_MS,
        useNativeDriver: Platform.OS !== 'web',
      });
      activeAnimRef.current = fadeOut;
      fadeOut.start(({ finished }) => {
        if (finished) {
          activeAnimRef.current = null;
          committedRef.current = null;
          setPrevBackdrop(null);
          setCommitted(null);
        }
      });
      return stopActiveAnim;
    }

    const nextEntry: BackdropEntry = { key: backdropKey, uri: normalizedUri, title, portrait };
    const current = committedRef.current;
    if (
      current !== null &&
      current.key === nextEntry.key &&
      current.uri === nextEntry.uri &&
      current.portrait === nextEntry.portrait
    ) {
      stopActiveAnim();
      visibilityAnim.setValue(1);
      return undefined;
    }

    const timer = setTimeout(() => {
      stopActiveAnim();
      const prev = committedRef.current;
      committedRef.current = nextEntry;
      setCommitted(nextEntry);

      if (singleLayer) {
        setPrevBackdrop(null);
        fadeAnim.setValue(1);
        visibilityAnim.setValue(1);
        return;
      }

      visibilityAnim.setValue(1);
      setPrevBackdrop(prev);
      fadeAnim.setValue(0);
      const crossfade = Animated.timing(fadeAnim, {
        toValue: 1,
        duration: AMBIENT_BACKDROP_CROSSFADE_MS,
        useNativeDriver: Platform.OS !== 'web',
      });
      activeAnimRef.current = crossfade;
      crossfade.start(({ finished }) => {
        if (finished) {
          activeAnimRef.current = null;
          setPrevBackdrop(null);
        }
      });
    }, AMBIENT_BACKDROP_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [
    backdropKey,
    fadeAnim,
    hasTarget,
    normalizedUri,
    portrait,
    singleLayer,
    title,
    visibilityAnim,
  ]);

  useEffect(() => {
    return () => {
      activeAnimRef.current?.stop();
      activeAnimRef.current = null;
    };
  }, []);

  if (committed === null) return null;

  return (
    <Animated.View
      pointerEvents="none"
      testID={testID}
      style={[
        StyleSheet.absoluteFill,
        styles.container,
        {
          backgroundColor: theme.colors.bgCanvas,
          opacity: singleLayer ? 1 : visibilityAnim,
        },
      ]}
    >
      {prevBackdrop !== null && !singleLayer ? (
        prevBackdrop.portrait ? (
          <BlurredAmbientBackdrop uri={prevBackdrop.uri} testID={`${testID}-prev`} />
        ) : (
          <ArtworkImage
            testID={`${testID}-prev`}
            uri={prevBackdrop.uri}
            label={prevBackdrop.title}
            maxDecodePx={decodePx}
            borderRadius={0}
            decorative
            style={StyleSheet.absoluteFill}
          />
        )
      ) : null}
      <Animated.View
        pointerEvents="none"
        testID={`${testID}-layer`}
        style={[StyleSheet.absoluteFill, { opacity: singleLayer ? 1 : fadeAnim }]}
      >
        {committed.portrait ? (
          <BlurredAmbientBackdrop uri={committed.uri} testID={`${testID}-image`} />
        ) : (
          <ArtworkImage
            testID={`${testID}-image`}
            uri={committed.uri}
            label={committed.title}
            maxDecodePx={decodePx}
            borderRadius={0}
            decorative
            style={StyleSheet.absoluteFill}
          />
        )}
      </Animated.View>
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.bgCanvas, opacity: AMBIENT_WASH_OPACITY },
        ]}
      />
      <Scrim direction="top" intensity="default" testID={`${testID}-scrim-top`} />
      <Scrim direction="bottom" intensity="strong" testID={`${testID}-scrim-bottom`} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});
