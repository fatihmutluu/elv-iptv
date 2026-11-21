import type { ReactElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Scrim } from '../primitives/Scrim';

const DEFAULT_EDGE_FADE_HEIGHT = 28;

/** Props of {@link TvScrollEdgeFade}. */
export interface TvScrollEdgeFadeProps {
  /** Renders the top fade mask when scrolled past the start of the list. */
  showTop: boolean;
  /** Renders the bottom fade mask when additional rows remain below the viewport. */
  showBottom: boolean;
  /** Height of each edge fade band in logical pixels (default `28`). */
  height?: number;
  /** Overrides platform auto-detection (defaults to `Platform.OS === 'ios' && Platform.isTV`). */
  enabled?: boolean;
  /** Optional theme surface color override (defaults to `theme.colors.bgCanvas`). */
  surfaceColor?: string;
  testID?: string;
}

function isTvOs(): boolean {
  return Platform.OS === 'ios' && Boolean((Platform as { isTV?: boolean }).isTV);
}

/**
 * Non-interactive top/bottom edge fade mask softening hard vertical viewport clips on tvOS lists
 * (`#230`). Derives 100% of its gradient stops from `theme.colors.bgCanvas` (or `surfaceColor`)
 * via {@link Scrim}.
 */
export function TvScrollEdgeFade({
  showTop,
  showBottom,
  height = DEFAULT_EDGE_FADE_HEIGHT,
  enabled,
  surfaceColor,
  testID,
}: TvScrollEdgeFadeProps): ReactElement | null {
  const isEnabled = enabled ?? isTvOs();
  if (!isEnabled || (!showTop && !showBottom)) return null;

  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no"
      testID={testID}
      style={StyleSheet.absoluteFill}
    >
      {showTop ? (
        <View
          pointerEvents="none"
          testID={testID ? `${testID}-top` : undefined}
          style={[styles.edge, styles.topEdge, { height }]}
        >
          <Scrim direction="top" color={surfaceColor} />
        </View>
      ) : null}
      {showBottom ? (
        <View
          pointerEvents="none"
          testID={testID ? `${testID}-bottom` : undefined}
          style={[styles.edge, styles.bottomEdge, { height }]}
        >
          <Scrim direction="bottom" color={surfaceColor} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  edge: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  topEdge: {
    top: 0,
  },
  bottomEdge: {
    bottom: 0,
  },
});
