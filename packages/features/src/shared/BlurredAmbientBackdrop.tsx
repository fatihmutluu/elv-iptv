import { defaultDeadHostRegistry, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useState } from 'react';
import { Image, type ImageStyle, Platform, StyleSheet, View } from 'react-native';

/** Props of {@link BlurredAmbientBackdrop}. */
export interface BlurredAmbientBackdropProps {
  /** Image URI rendered as a heavily blurred dark ambient hero background. */
  readonly uri: string | null | undefined;
  readonly testID?: string;
}

const WEB_AMBIENT_FILTER = {
  filter: 'blur(32px) saturate(1.2) brightness(0.45)',
} as unknown as ImageStyle;

/**
 * Soft heavily blurred atmospheric backdrop used when a VOD or Home Hero item has only a
 * vertical `2:3` poster instead of a genuine horizontal `16:9` backdrop (`UI_UX_PHILOSOPHY.md`).
 * Never stretches vertical posters cleanly; marks itself decorative and non-interactive.
 */
export function BlurredAmbientBackdrop({
  uri,
  testID,
}: BlurredAmbientBackdropProps): ReactElement | null {
  const theme = useTheme();
  const trimmedUri = uri?.trim() ?? '';
  const [failedUri, setFailedUri] = useState<string | null>(null);

  const handleError = useCallback(() => {
    if (trimmedUri.length > 0) setFailedUri(trimmedUri);
  }, [trimmedUri]);

  if (trimmedUri.length === 0) return null;

  const isFailed = failedUri === trimmedUri || defaultDeadHostRegistry.isDead(trimmedUri);

  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[StyleSheet.absoluteFill, styles.clip]}
    >
      {isFailed ? null : Platform.OS === 'web' ? (
        <Image
          source={{ uri: trimmedUri }}
          resizeMode="cover"
          fadeDuration={0}
          accessible={false}
          onError={handleError}
          style={[StyleSheet.absoluteFill, styles.ambientScale, WEB_AMBIENT_FILTER]}
        />
      ) : (
        <>
          <Image
            source={{ uri: trimmedUri }}
            blurRadius={28}
            resizeMode="cover"
            fadeDuration={0}
            accessible={false}
            onError={handleError}
            style={[StyleSheet.absoluteFill, styles.ambientScale, styles.nativeDim]}
          />
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.scrimSoft }]}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  ambientScale: {
    transform: [{ scale: 1.15 }],
  },
  nativeDim: {
    opacity: 0.55,
  },
});
