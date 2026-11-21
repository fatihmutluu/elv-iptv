import type { ReactElement } from 'react';
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { useUiAdapters } from '../adapters';
import { hexToRgba, useTheme } from '../theme';

/** Direction from which the scrim fades smoothly into `theme.colors.bgCanvas`. */
export type ScrimDirection = 'bottom' | 'top' | 'left' | 'right';

/** Props of {@link Scrim}. */
export interface ScrimProps {
  direction?: ScrimDirection;
  /** Optional strength multiplier (`'default'` or `'strong'` for high-contrast hero readability). */
  intensity?: 'default' | 'strong';
  /** Optional theme surface token override (defaults to `theme.colors.bgCanvas`). */
  color?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const SCRIM_LOCATIONS: readonly number[] = [0, 0.34, 0.72, 1];

const VECTORS: Readonly<
  Record<
    ScrimDirection,
    {
      cssDir: string;
      start: { x: number; y: number };
      end: { x: number; y: number };
      flexDir: ViewStyle['flexDirection'];
    }
  >
> = {
  bottom: {
    cssDir: 'to bottom',
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
    flexDir: 'column',
  },
  top: {
    cssDir: 'to top',
    start: { x: 0.5, y: 1 },
    end: { x: 0.5, y: 0 },
    flexDir: 'column-reverse',
  },
  left: {
    cssDir: 'to left',
    start: { x: 1, y: 0.5 },
    end: { x: 0, y: 0.5 },
    flexDir: 'row-reverse',
  },
  right: {
    cssDir: 'to right',
    start: { x: 0, y: 0.5 },
    end: { x: 1, y: 0.5 },
    flexDir: 'row',
  },
};

/**
 * Cinema gradient scrim dissolving artwork cleanly into `theme.colors.bgCanvas`.
 * Uses CSS `linear-gradient` on web, optional native `renderGradient` adapter when supplied, or
 * smooth multi-stop canvas layers on native with zero hardcoded dark-blue hexes.
 */
export function Scrim({
  direction = 'bottom',
  intensity = 'default',
  color,
  style,
  testID,
}: ScrimProps): ReactElement {
  const theme = useTheme();
  const adapters = useUiAdapters();
  const vec = VECTORS[direction];

  const stops =
    color !== undefined
      ? intensity === 'strong'
        ? [hexToRgba(color, 0), hexToRgba(color, 0.56), hexToRgba(color, 0.88), color]
        : [hexToRgba(color, 0), hexToRgba(color, 0.32), hexToRgba(color, 0.68), color]
      : intensity === 'strong'
        ? [
            theme.colors.scrimTransparent,
            theme.colors.scrimMedium,
            theme.colors.scrimStrong,
            theme.colors.bgCanvas,
          ]
        : [
            theme.colors.scrimTransparent,
            theme.colors.scrimSoft,
            theme.colors.scrimMedium,
            theme.colors.bgCanvas,
          ];

  if (adapters.renderGradient) {
    return (
      <View pointerEvents="none" testID={testID} style={[StyleSheet.absoluteFill, style]}>
        {adapters.renderGradient({
          colors: stops,
          locations: SCRIM_LOCATIONS,
          start: vec.start,
          end: vec.end,
          style: StyleSheet.absoluteFill,
          pointerEvents: 'none',
        })}
      </View>
    );
  }

  if (Platform.OS === 'web') {
    const gradient = `linear-gradient(${vec.cssDir}, ${stops[0]} 0%, ${stops[1]} 34%, ${stops[2]} 72%, ${stops[3]} 100%)`;
    const webStyle = { backgroundImage: gradient } as unknown as ViewStyle;
    return (
      <View
        pointerEvents="none"
        testID={testID}
        style={[StyleSheet.absoluteFill, webStyle, style]}
      />
    );
  }

  return (
    <View
      pointerEvents="none"
      testID={testID}
      style={[StyleSheet.absoluteFill, { flexDirection: vec.flexDir }, style]}
    >
      <View style={{ flex: 34, backgroundColor: stops[0] }} />
      <View style={{ flex: 38, backgroundColor: stops[1] }} />
      <View style={{ flex: 18, backgroundColor: stops[2] }} />
      <View style={{ flex: 10, backgroundColor: stops[3] }} />
    </View>
  );
}
