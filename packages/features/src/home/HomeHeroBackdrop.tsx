import { ArtworkImage, Scrim, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
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

function slideVisualId(slide: BackdropSlideSnapshot): string {
  return `${slide.key}|${slide.uri ?? ''}|${slide.posterUri ?? ''}|${slide.isPortraitFallback ? 1 : 0}`;
}

function needsImageLoad(slide: BackdropSlideSnapshot): boolean {
  const portraitAmbientUri = slide.isPortraitFallback
    ? (slide.posterUri ?? slide.uri)
    : slide.uri === null
      ? slide.posterUri
      : null;
  return portraitAmbientUri === null && slide.uri !== null;
}

function renderSlideBackdrop(
  slide: BackdropSlideSnapshot,
  testIdPrefix: 'home-hero-backdrop' | 'home-hero-backdrop-prev',
  onReady?: () => void,
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
      key={slideVisualId(slide)}
      testID={testIdPrefix}
      uri={slide.uri}
      label={slide.title}
      maxDecodePx={960}
      borderRadius={0}
      decorative
      onLoad={onReady}
      onError={onReady}
      style={StyleSheet.absoluteFill}
    />
  );
}

/**
 * Full-bleed crossfading Hero backdrop (`#399`).
 * Renders genuine landscape backdrops cleanly with `cover`, or switches to a heavily blurred dark
 * ambient backdrop when only a vertical `2:3` poster is available so vertical artwork never stretches.
 * Keeps the previous backdrop layer mounted underneath until the incoming backdrop finishes loading
 * (`onLoad`) so hero switches never flash a dark canvas.
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
  const currentId = slideVisualId(currentSlide);

  const [transition, setTransition] = useState<{
    readonly activeId: string;
    readonly activeSlide: BackdropSlideSnapshot;
    readonly prevBackdrop: BackdropSlideSnapshot | null;
    readonly currentLoaded: boolean;
  }>(() => ({
    activeId: currentId,
    activeSlide: currentSlide,
    prevBackdrop: null,
    currentLoaded: !needsImageLoad(currentSlide),
  }));

  if (transition.activeId !== currentId) {
    const nextPrev = transition.currentLoaded
      ? transition.activeSlide
      : (transition.prevBackdrop ?? transition.activeSlide);
    const hasPrevVisual = nextPrev.uri !== null || nextPrev.posterUri !== null;
    setTransition({
      activeId: currentId,
      activeSlide: currentSlide,
      prevBackdrop: hasPrevVisual ? nextPrev : null,
      currentLoaded: !needsImageLoad(currentSlide),
    });
  }

  const activeIdRef = useRef(currentId);
  activeIdRef.current = currentId;
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const handleCurrentReady = useCallback(() => {
    const id = activeIdRef.current;
    setTransition((prev) =>
      prev.activeId === id && !prev.currentLoaded ? { ...prev, currentLoaded: true } : prev,
    );
  }, []);

  const hasPrevBackdrop = transition.prevBackdrop !== null;

  useEffect(() => {
    if (!hasPrevBackdrop) {
      fadeAnim.setValue(1);
      return undefined;
    }
    if (!transition.currentLoaded) {
      fadeAnim.setValue(0);
      return undefined;
    }
    if (theme.reduceMotion) {
      fadeAnim.setValue(1);
      setTransition((prev) =>
        prev.activeId === currentId && prev.prevBackdrop !== null
          ? { ...prev, prevBackdrop: null }
          : prev,
      );
      return undefined;
    }

    fadeAnim.setValue(0);
    const anim = Animated.timing(fadeAnim, {
      toValue: 1,
      duration: HOME_HERO_CROSSFADE_MS,
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start(({ finished }) => {
      if (finished) {
        setTransition((prev) =>
          prev.activeId === currentId ? { ...prev, prevBackdrop: null } : prev,
        );
      }
    });
    return () => {
      anim.stop();
    };
  }, [currentId, fadeAnim, hasPrevBackdrop, theme.reduceMotion, transition.currentLoaded]);

  const layerOpacity =
    hasPrevBackdrop && !transition.currentLoaded ? 0 : theme.reduceMotion ? 1 : fadeAnim;

  return (
    <>
      {transition.prevBackdrop !== null
        ? renderSlideBackdrop(transition.prevBackdrop, 'home-hero-backdrop-prev')
        : null}
      <Animated.View
        pointerEvents="none"
        testID="home-hero-backdrop-layer"
        style={[StyleSheet.absoluteFill, { opacity: layerOpacity }]}
      >
        {renderSlideBackdrop(currentSlide, 'home-hero-backdrop', handleCurrentReady)}
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
