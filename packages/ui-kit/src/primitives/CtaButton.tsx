import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Icon, type IconName } from '../icons';
import { useTheme } from '../theme';
import { useViewport } from '../viewport';

/** Visual hierarchy tier of {@link CtaButton}. */
export type CtaButtonVariant = 'primary' | 'secondary' | 'ghost';

/** Props of {@link CtaButton}. */
export interface CtaButtonProps {
  label: string;
  variant?: CtaButtonVariant;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  focused?: boolean;
  hasTVPreferredFocus?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Sharp `4px` Cinema Quietude call-to-action button (`Play`, `Resume`, `Add & Sync`).
 * Primary buttons remain high-contrast neutral (`ctaBg`/`ctaFg`) with surface-aware hover on
 * desktop (never neon hover outlines) and crisp `focusRingColor` + scale on 10-foot TV focus.
 */
export function CtaButton({
  label,
  variant = 'primary',
  icon,
  onPress,
  disabled = false,
  focused,
  hasTVPreferredFocus,
  testID,
  accessibilityLabel,
  style,
}: CtaButtonProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const [nativeFocused, setNativeFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleFocus = useCallback(() => setNativeFocused(true), []);
  const handleBlur = useCallback(() => setNativeFocused(false), []);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const foreground = variant === 'primary' ? theme.colors.ctaFg : theme.colors.textPrimary;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      focusable={!disabled}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={(state) => {
        const activeFocus = focused ?? (nativeFocused || Boolean(state.focused));
        const showTvFocus =
          !disabled && (focused === true || (viewport.inputModality === 'tv' && activeFocus));

        const backgroundColor =
          variant === 'primary'
            ? theme.colors.ctaBg
            : variant === 'secondary'
              ? showTvFocus
                ? theme.colors.focusFill
                : hovered && !disabled
                  ? theme.colors.glassBg
                  : theme.colors.actionGlassBg
              : showTvFocus
                ? theme.colors.focusFill
                : (hovered || state.pressed) && !disabled
                  ? theme.colors.subtleHighlight
                  : 'transparent';

        const borderWidth = variant === 'secondary' ? 1 : 0;
        const borderColor =
          variant === 'secondary' ? theme.colors.actionGlassBorder : 'transparent';

        const pressScale = theme.reduceMotion ? 1 : 0.98;
        const scale = disabled
          ? 1
          : state.pressed
            ? pressScale
            : showTvFocus
              ? theme.focus.buttonScale
              : 1;

        const opacity = disabled
          ? 0.45
          : state.pressed
            ? 0.88
            : variant === 'primary' && hovered && !showTvFocus
              ? 0.92
              : 1;

        return [
          styles.button,
          {
            backgroundColor,
            borderRadius: theme.radius.button,
            borderWidth,
            borderColor,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.xs,
            gap: theme.spacing.xs,
            opacity,
            transform: [{ scale }],
          },
          style,
        ];
      }}
    >
      {({ focused: stateFocused }) => {
        const activeFocus = focused ?? (nativeFocused || Boolean(stateFocused));
        const showTvFocus =
          !disabled && (focused === true || (viewport.inputModality === 'tv' && activeFocus));
        return (
          <>
            {icon !== undefined ? (
              <Icon
                name={icon}
                size={18}
                color={foreground}
                testID={testID ? `${testID}-icon` : undefined}
              />
            ) : null}
            <Text numberOfLines={1} style={[theme.typography.title, { color: foreground }]}>
              {label}
            </Text>
            {showTvFocus ? (
              <View
                pointerEvents="none"
                testID={testID ? `${testID}-focus-ring` : undefined}
                style={[
                  styles.focusRing,
                  {
                    borderRadius: theme.radius.button + 4,
                    borderWidth: theme.focus.ringWidth,
                    borderColor: theme.colors.focusRingColor,
                  },
                ]}
              />
            ) : null}
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'relative',
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  focusRing: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    left: -4,
    right: -4,
  },
});
