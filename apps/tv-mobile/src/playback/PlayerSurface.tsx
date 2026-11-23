import type { AccessibilityFontFamily } from '@elv/domain';
import { AetherSurface } from '@elv/engine-aether';
import { Media3Surface } from '@elv/engine-media3';
import type { PlayerEngine } from '@elv/playback';
import type { ReactElement } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

/** Props of {@link PlayerSurface}. */
export interface PlayerSurfaceProps {
  engine: PlayerEngine;
  style?: StyleProp<ViewStyle>;
  resizeMode?: 'fit' | 'fill' | 'stretch';
  subtitleBottomInsetPx?: number;
  subtitleFontFamily?: AccessibilityFontFamily;
  surfaceRecreationToken?: number;
  useTextureView?: boolean;
  osdVisible?: boolean;
  testID?: string;
}

/**
 * Renders the native video surface for the active mobile/TV platform (`AetherSurface` on iOS,
 * iPadOS and tvOS where `Platform.OS === 'ios'`, `Media3Surface` on Android).
 */
export function PlayerSurface({
  engine,
  style,
  resizeMode,
  subtitleBottomInsetPx,
  subtitleFontFamily,
  surfaceRecreationToken,
  useTextureView,
  osdVisible,
  testID,
}: PlayerSurfaceProps): ReactElement | null {
  if (Platform.OS === 'ios') {
    return (
      <AetherSurface
        engine={engine}
        style={style}
        resizeMode={resizeMode}
        subtitleBottomInsetPx={subtitleBottomInsetPx}
        {...(subtitleFontFamily !== undefined ? { subtitleFontFamily } : {})}
        {...(osdVisible !== undefined ? { osdVisible } : {})}
        testID={testID}
      />
    );
  }
  return (
    <Media3Surface
      engine={engine}
      style={style}
      resizeMode={resizeMode}
      subtitleBottomInsetPx={subtitleBottomInsetPx}
      {...(subtitleFontFamily !== undefined ? { subtitleFontFamily } : {})}
      {...(surfaceRecreationToken !== undefined ? { surfaceRecreationToken } : {})}
      {...(useTextureView !== undefined ? { useTextureView } : {})}
      testID={testID}
    />
  );
}
