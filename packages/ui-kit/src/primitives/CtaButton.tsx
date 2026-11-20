import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Icon, type IconName } from '../icons';
import { useTheme, webBackdropBlur, webCursorPointer, webShadow, webTransition } from '../theme';
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

const TV_FOCUS_NATIVE_SHADOW: ViewStyle = {
  shadowColor: 'rgba(0, 0, 0, 1)',
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.55,
  shadowRadius: 16,
  elevation: 10,
};

/**
 * Sharp `4px` Cinema Quietude call-to-action button (`Play`, `Resume`, `Add & Sync`).
 * Primary buttons remain high-contrast neutral (`ctaBg`/`ctaFg`) with surface-aware hover on
 * desktop (never neon hover outlines) and crisp `focusRingColor` + elevation on 10-foot TV focus.
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
  const secondaryBlur = variant === 'secondary' ? webBackdropBlur(12) : undefined;
  const transition = webTransition(
    theme,
    'transform, background-color, border-color, opacity, box-shadow',
  );
  const cursor = !disabled ? webCursorPointer() : undefined;

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
              ? showTvFocus || (hovered && !disabled)
                ? theme.colors.actionGlassHoverBg
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
            paddingHorizontal: 20,
            paddingVertical: 10,
            gap: 8,
            opacity,
            transform: [{ scale }],
          },
          secondaryBlur,
          transition,
          cursor,
          showTvFocus ? TV_FOCUS_NATIVE_SHADOW : undefined,
          showTvFocus ? webShadow('0 12px 28px rgba(0, 0, 0, 0.65)') : undefined,
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
            <Text
              numberOfLines={1}
              style={[theme.typography.title, styles.label, { color: foreground }]}
            >
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
  label: {
    fontWeight: '700',
  },
  focusRing: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    left: -4,
    right: -4,
  },
});
