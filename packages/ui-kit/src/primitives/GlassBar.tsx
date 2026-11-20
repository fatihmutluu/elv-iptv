import type { ReactElement, ReactNode } from 'react';
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { useUiAdapters } from '../adapters';
import { useTheme } from '../theme';
import { Scrim } from './Scrim';

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
 * Derives its frosted fill and border dynamically from `theme.colors`.
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

  if (!scrolled) {
    return (
      <View testID={testID} style={[styles.container, style]}>
        <Scrim direction="top" />
        <View style={[styles.content, contentStyle]}>{children}</View>
      </View>
    );
  }

  if (adapters.renderBlur) {
    return (
      <View testID={testID} style={[styles.container, hairlineStyle, style]}>
        {adapters.renderBlur({
          intensity: 20,
          tintColor: theme.colors.glassBg,
          style: [styles.content, contentStyle],
          children,
        })}
      </View>
    );
  }

  const webGlass =
    Platform.OS === 'web'
      ? ({
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          transitionProperty: theme.reduceMotion ? 'none' : 'background-color, border-color',
          transitionDuration: `${theme.motion.normalMs}ms`,
        } as unknown as ViewStyle)
      : undefined;

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        { backgroundColor: theme.colors.glassBg },
        hairlineStyle,
        webGlass,
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
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
  },
});
