import { ArtworkImage, Scrim, useTheme } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet } from 'react-native';

/** Crossfade duration in milliseconds when transitioning between Home Hero spotlight slides (`#399`). */
const HOME_HERO_CROSSFADE_MS = 320;

/** Auto-rotation interval (ms) for multi-slide Home Hero spotlights when motion is allowed (`#399`). */
export const HOME_HERO_AUTO_ROTATE_MS = 7_500;

/** Props of {@link HomeHeroBackdrop}. */
export interface HomeHeroBackdropProps {
  readonly slideKey: string;
  readonly uri: string | null;
  readonly title: string;
}

/**
 * Full-bleed crossfading Hero backdrop (`#399`).
 * Fades incoming slides smoothly over 320 ms while keeping the outgoing backdrop visible behind
 * them, switching instantaneously with `opacity: 1` whenever `theme.reduceMotion` is enabled.
 */
export function HomeHeroBackdrop({ slideKey, uri, title }: HomeHeroBackdropProps): ReactElement {
  const theme = useTheme();
  const [prevBackdrop, setPrevBackdrop] = useState<{
    readonly key: string;
    readonly uri: string | null;
    readonly title: string;
  } | null>(null);
  const lastSlideRef = useRef<{
    readonly key: string;
    readonly uri: string | null;
    readonly title: string;
  }>({ key: slideKey, uri, title });
  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const prev = lastSlideRef.current;
    const next = { key: slideKey, uri, title };
    lastSlideRef.current = next;

    if (theme.reduceMotion || prev.key === next.key) {
      setPrevBackdrop(null);
      fadeAnim.setValue(1);
      return;
    }

    setPrevBackdrop(prev);
    fadeAnim.setValue(0);
    const anim = Animated.timing(fadeAnim, {
      toValue: 1,
      duration: HOME_HERO_CROSSFADE_MS,
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start(({ finished }) => {
      if (finished) setPrevBackdrop(null);
    });
    return () => {
      anim.stop();
    };
  }, [fadeAnim, slideKey, theme.reduceMotion, title, uri]);

  return (
    <>
      {prevBackdrop !== null && !theme.reduceMotion ? (
        <ArtworkImage
          testID="home-hero-backdrop-prev"
          uri={prevBackdrop.uri}
          label={prevBackdrop.title}
          maxDecodePx={960}
          borderRadius={0}
          decorative
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <Animated.View
        pointerEvents="none"
        testID="home-hero-backdrop-layer"
        style={[StyleSheet.absoluteFill, { opacity: theme.reduceMotion ? 1 : fadeAnim }]}
      >
        <ArtworkImage
          testID="home-hero-backdrop"
          uri={uri}
          label={title}
          maxDecodePx={960}
          borderRadius={0}
          decorative
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <Scrim direction="bottom" intensity="strong" testID="home-hero-scrim-bottom" />
      <Scrim direction="left" intensity="strong" testID="home-hero-scrim-left" />
    </>
  );
}

/**
 * Advances the Home Hero spotlight every {@link HOME_HERO_AUTO_ROTATE_MS} while active,
 * pausing immediately on `reduceMotion`, route blur, pointer hover, or 10-ft TV hero focus (`#399`).
 */
export function useHomeHeroAutoRotate(opts: {
  readonly slideCount: number;
  readonly reduceMotion: boolean;
  readonly routeActive: boolean;
  readonly hovered: boolean;
  readonly tvFocused: boolean;
  readonly onAdvance: () => void;
}): void {
  const { slideCount, reduceMotion, routeActive, hovered, tvFocused, onAdvance } = opts;
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;

  useEffect(() => {
    if (slideCount <= 1 || reduceMotion || !routeActive || hovered || tvFocused) {
      return undefined;
    }
    const timer = setInterval(() => {
      onAdvanceRef.current();
    }, HOME_HERO_AUTO_ROTATE_MS);
    return () => clearInterval(timer);
  }, [hovered, reduceMotion, routeActive, slideCount, tvFocused]);
}
