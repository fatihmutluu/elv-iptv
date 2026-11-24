import type { AccessibilityFontFamily, SubtitleStyleConfig } from '@elv/domain';
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
  /** User-selected subtitle visual appearance configuration (`#32`). */
  subtitleStyle?: SubtitleStyleConfig;
  surfaceRecreationToken?: number;
  useTextureView?: boolean;
  osdVisible?: boolean;
  testID?: string;
}

function normalizeSubtitleStyleProp(
  style: SubtitleStyleConfig | undefined,
): SubtitleStyleConfig | undefined {
  if (style === undefined) return undefined;
  return {
    fontSize: style.fontSize,
    textColor: style.textColor,
    backgroundColor: style.backgroundColor,
    edgeStyle: style.edgeStyle,
    verticalPosition: style.verticalPosition,
  };
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
  subtitleStyle,
  surfaceRecreationToken,
  useTextureView,
  osdVisible,
  testID,
}: PlayerSurfaceProps): ReactElement | null {
  const cleanSubtitleStyle = normalizeSubtitleStyleProp(subtitleStyle);
  if (Platform.OS === 'ios') {
    return (
      <AetherSurface
        engine={engine}
        style={style}
        resizeMode={resizeMode}
        subtitleBottomInsetPx={subtitleBottomInsetPx}
        {...(subtitleFontFamily !== undefined ? { subtitleFontFamily } : {})}
        {...(cleanSubtitleStyle !== undefined ? { subtitleStyle: cleanSubtitleStyle } : {})}
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
      {...(cleanSubtitleStyle !== undefined ? { subtitleStyle: cleanSubtitleStyle } : {})}
      {...(surfaceRecreationToken !== undefined ? { surfaceRecreationToken } : {})}
      {...(useTextureView !== undefined ? { useTextureView } : {})}
      testID={testID}
    />
  );
}
