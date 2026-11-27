import { ArtworkImage, Scrim, useTheme } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet } from 'react-native';
import { BlurredAmbientBackdrop } from '../shared/BlurredAmbientBackdrop';

/** Crossfade duration in milliseconds when transitioning between Home Hero spotlight slides (`#399`). */
const HOME_HERO_CROSSFADE_MS = 320;

/** Auto-rotation interval (ms) for multi-slide Home Hero spotlights when motion is allowed (`#399`). */
export const HOME_HERO_AUTO_ROTATE_MS = 7_500;

/** Props of {@link HomeHeroBackdrop}. */
export interface HomeHeroBackdropProps {
  readonly slideKey: string;
  readonly uri: string | null;
  readonly posterUri?: string | null;
  readonly isPortraitFallback?: boolean;
  readonly title: string;
}

interface BackdropSlideSnapshot {
  readonly key: string;
  readonly uri: string | null;
  readonly posterUri: string | null;
  readonly isPortraitFallback: boolean;
  readonly title: string;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function renderSlideBackdrop(
  slide: BackdropSlideSnapshot,
  testIdPrefix: 'home-hero-backdrop' | 'home-hero-backdrop-prev',
): ReactElement {
  const portraitAmbientUri = slide.isPortraitFallback
    ? (slide.posterUri ?? slide.uri)
    : slide.uri === null
      ? slide.posterUri
      : null;

  if (portraitAmbientUri !== null) {
    return (
      <BlurredAmbientBackdrop
        testID={
          testIdPrefix === 'home-hero-backdrop'
            ? 'home-hero-backdrop-ambient'
            : `${testIdPrefix}-ambient`
        }
        uri={portraitAmbientUri}
      />
    );
  }

  return (
    <ArtworkImage
      testID={testIdPrefix}
      uri={slide.uri}
      label={slide.title}
      maxDecodePx={960}
      borderRadius={0}
      decorative
      style={StyleSheet.absoluteFill}
    />
  );
}

/**
 * Full-bleed crossfading Hero backdrop (`#399`).
 * Renders genuine landscape backdrops cleanly with `cover`, or switches to a heavily blurred dark
 * ambient backdrop when only a vertical `2:3` poster is available so vertical artwork never stretches.
 */
export function HomeHeroBackdrop({
  slideKey,
  uri,
  posterUri = null,
  isPortraitFallback = false,
  title,
}: HomeHeroBackdropProps): ReactElement {
  const theme = useTheme();
  const normalizedUri = normalizeUrl(uri);
  const normalizedPoster = normalizeUrl(posterUri);
  const currentSlide: BackdropSlideSnapshot = {
    key: slideKey,
    uri: normalizedUri,
    posterUri: normalizedPoster,
    isPortraitFallback,
    title,
  };

  const [prevBackdrop, setPrevBackdrop] = useState<BackdropSlideSnapshot | null>(null);
  const lastSlideRef = useRef<BackdropSlideSnapshot>(currentSlide);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const prev = lastSlideRef.current;
    const next: BackdropSlideSnapshot = {
      key: slideKey,
      uri: normalizedUri,
      posterUri: normalizedPoster,
      isPortraitFallback,
      title,
    };
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
  }, [
    fadeAnim,
    isPortraitFallback,
    normalizedPoster,
    normalizedUri,
    slideKey,
    theme.reduceMotion,
    title,
  ]);

  return (
    <>
      {prevBackdrop !== null && !theme.reduceMotion
        ? renderSlideBackdrop(prevBackdrop, 'home-hero-backdrop-prev')
        : null}
      <Animated.View
        pointerEvents="none"
        testID="home-hero-backdrop-layer"
        style={[StyleSheet.absoluteFill, { opacity: theme.reduceMotion ? 1 : fadeAnim }]}
      >
        {renderSlideBackdrop(currentSlide, 'home-hero-backdrop')}
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
