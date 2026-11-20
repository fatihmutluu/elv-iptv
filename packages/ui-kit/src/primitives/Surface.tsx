import type { ReactElement, ReactNode } from 'react';
import { type StyleProp, View, type ViewProps, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

/** Semantic Cinema Quietude elevation tone backed by `useTheme()`. */
export type SurfaceTone = 'canvas' | 'rail' | 'surface' | 'card' | 'elevated';

/** Props of {@link Surface}. */
export interface SurfaceProps extends Omit<ViewProps, 'style'> {
  tone?: SurfaceTone;
  bordered?: boolean;
  rounded?: 'none' | 'button' | 'card' | 'modal' | 'pill';
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/** Theme-driven surface container mapping semantic tones onto `theme.colors` without hardcoded hexes. */
export function Surface({
  tone = 'surface',
  bordered = false,
  rounded = 'none',
  style,
  children,
  ...rest
}: SurfaceProps): ReactElement {
  const theme = useTheme();

  const backgroundColor =
    tone === 'canvas'
      ? theme.colors.bgCanvas
      : tone === 'rail'
        ? theme.colors.bgRail
        : tone === 'card'
          ? theme.colors.bgCard
          : tone === 'elevated'
            ? theme.colors.bgElevated
            : theme.colors.bgSurface;

  const borderRadius =
    rounded === 'none'
      ? 0
      : rounded === 'button'
        ? theme.radius.button
        : rounded === 'card'
          ? theme.radius.card
          : rounded === 'modal'
            ? theme.radius.modal
            : theme.radius.pill;

  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor,
          borderRadius,
          ...(bordered ? { borderWidth: 1, borderColor: theme.colors.surfaceBorder } : {}),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
