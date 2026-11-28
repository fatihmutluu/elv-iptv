import type { ReactElement, ReactNode } from 'react';
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { useUiAdapters } from '../adapters';
import { useTheme, webBackdropBlur, webTransition } from '../theme';

/** Props of {@link GlassBar}. */
export interface GlassBarProps {
  /** When false, sits transparently over hero artwork with a soft top-down scrim and zero border; when true, transitions to frosted glass with a 1px hairline border. */
  scrolled?: boolean;
  /** Edge where the 1px hairline border appears when `scrolled` is true. */
  hairlineEdge?: 'bottom' | 'top' | 'none';
  style?: StyleProp<ViewStyle>;
  /** Optional style applied to the inner horizontal flex row holding children. */
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
  children?: ReactNode;
}

/**
 * Transparent-to-frosted navigation/toolbar surface (`UI_UX_PHILOSOPHY.md` §1 & §3).
 * Renders a top-down gradient scrim at scroll `0` (zero border) and transitions smoothly into
 * frosted glass derived dynamically from `theme.colors` when scrolled.
 */
export function GlassBar({
  scrolled = false,
  hairlineEdge = 'bottom',
  style,
  contentStyle,
  testID,
  children,
}: GlassBarProps): ReactElement {
  const theme = useTheme();
  const adapters = useUiAdapters();

  const hairlineStyle: ViewStyle =
    !scrolled || hairlineEdge === 'none'
      ? {}
      : hairlineEdge === 'top'
        ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.glassBorder }
        : {
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.glassBorder,
          };

  const transitionStyle = webTransition(
    theme,
    'background-color, border-color',
    theme.motion.normalMs,
  );

  if (!scrolled) {
    const gradientStops = [
      theme.colors.topBarScrimStart,
      theme.colors.topBarScrimMid,
      theme.colors.scrimTransparent,
    ];

    const scrimLayer = adapters.renderGradient ? (
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {adapters.renderGradient({
          colors: gradientStops,
          locations: [0, 0.68, 1],
          start: { x: 0.5, y: 0 },
          end: { x: 0.5, y: 1 },
          style: StyleSheet.absoluteFill,
          pointerEvents: 'none',
        })}
      </View>
    ) : Platform.OS === 'web' ? (
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundImage: `linear-gradient(180deg, ${gradientStops[0]} 0%, ${gradientStops[1]} 68%, ${gradientStops[2]} 100%)`,
          } as unknown as ViewStyle,
        ]}
      />
    ) : (
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.nativeScrim]}>
        <View style={{ flex: 68, backgroundColor: gradientStops[0] }} />
        <View style={{ flex: 22, backgroundColor: gradientStops[1] }} />
        <View style={{ flex: 10, backgroundColor: gradientStops[2] }} />
      </View>
    );

    return (
      <View testID={testID} style={[styles.container, transitionStyle, style]}>
        {scrimLayer}
        <View style={[styles.content, contentStyle]}>{children}</View>
      </View>
    );
  }

  if (adapters.renderBlur) {
    return (
      <View testID={testID} style={[styles.container, styles.nativeClip, hairlineStyle, style]}>
        {adapters.renderBlur({
          intensity: 20,
          tintColor: theme.colors.glassBg,
          style: [styles.content, contentStyle],
          children,
        })}
      </View>
    );
  }

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        { backgroundColor: theme.colors.glassBg },
        hairlineStyle,
        webBackdropBlur(20),
        transitionStyle,
        style,
      ]}
    >
      <View style={[styles.content, contentStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  nativeClip: {
    overflow: 'hidden',
  },
  nativeScrim: {
    flexDirection: 'column',
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
  },
});
