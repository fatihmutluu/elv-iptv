import { ArtworkImage, Scrim, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurredAmbientBackdrop } from '../shared/BlurredAmbientBackdrop';

/** Props of {@link DetailHeroBackdrop}. */
export interface DetailHeroBackdropProps {
  readonly title: string;
  readonly backdropUri: string | null;
  readonly posterUri: string | null;
  readonly isPortraitFallback: boolean;
  /** Optional background trailer preview layered above artwork and below Cinema scrims. */
  readonly trailerPreview?: ReactElement | null;
}

/**
 * Full-bleed Detail Hero backdrop (`UI_UX_PHILOSOPHY.md` §1 & §3).
 * Renders true horizontal `16:9` backdrops cleanly with `cover`, or switches to a heavily blurred
 * dark atmospheric layer (`detail-hero-backdrop-ambient`) when only a `2:3` poster is available so
 * vertical posters are never stretched across widescreen viewports.
 */
export function DetailHeroBackdrop({
  title,
  backdropUri,
  posterUri,
  isPortraitFallback,
  trailerPreview = null,
}: DetailHeroBackdropProps): ReactElement {
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.backdropClip]}>
      {isPortraitFallback && posterUri !== null ? (
        <BlurredAmbientBackdrop testID="detail-hero-backdrop-ambient" uri={posterUri} />
      ) : (
        <ArtworkImage
          testID="detail-hero-backdrop"
          uri={backdropUri}
          label={title}
          maxDecodePx={960}
          borderRadius={0}
          decorative
          style={StyleSheet.absoluteFill}
        />
      )}
      {trailerPreview}
      <Scrim
        direction="top"
        intensity="default"
        testID="detail-hero-scrim-top"
        style={styles.scrimLayer}
      />
      <Scrim
        direction="bottom"
        intensity="strong"
        testID="detail-hero-scrim-bottom"
        style={styles.scrimLayer}
      />
      <Scrim
        direction="left"
        intensity="strong"
        testID="detail-hero-scrim-left"
        style={styles.scrimLayer}
      />
    </View>
  );
}

/** Props of {@link DetailHeroPosterCard}. */
export interface DetailHeroPosterCardProps {
  readonly posterUri: string;
  readonly title: string;
  readonly isPortrait: boolean;
  readonly isTv: boolean;
}

/** Crisp, unstretched `2:3` poster card paired with {@link DetailHero} in portrait fallback mode. */
export function DetailHeroPosterCard({
  posterUri,
  title,
  isPortrait,
  isTv,
}: DetailHeroPosterCardProps): ReactElement {
  const theme = useTheme();
  const width = isPortrait ? 124 : isTv ? 152 : 132;
  return (
    <ArtworkImage
      testID="detail-hero-poster"
      uri={posterUri}
      label={title}
      aspectRatio={2 / 3}
      maxDecodePx={480}
      borderRadius={theme.radius.card}
      style={[
        styles.posterCard,
        {
          width,
          borderColor: theme.colors.surfaceBorder,
          shadowColor: theme.colors.bgCanvas,
        },
        isPortrait ? styles.posterPortrait : styles.posterLandscape,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  backdropClip: { overflow: 'hidden' },
  scrimLayer: { zIndex: 1 },
  posterCard: {
    aspectRatio: 2 / 3,
    borderWidth: 1,
    flexShrink: 0,
    elevation: 10,
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  posterPortrait: {
    alignSelf: 'center',
  },
  posterLandscape: {
    alignSelf: 'flex-end',
  },
});
