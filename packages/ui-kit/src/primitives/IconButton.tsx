import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { Icon, type IconName } from '../icons';
import { useTheme, webBackdropBlur, webCursorPointer, webShadow, webTransition } from '../theme';
import { useViewport } from '../viewport';

/** Props of {@link IconButton}. */
export interface IconButtonProps {
  icon: IconName;
  accessibilityLabel: string;
  active?: boolean;
  size?: number;
  onPress?: () => void;
  disabled?: boolean;
  focused?: boolean;
  testID?: string;
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
 * Circular frosted-glass secondary action button (`+`, `like`, `info`, player top-right controls).
 * Enforces a `40x40` minimum touch target and renders an accent-tinted active state or crisp
 * 10-foot TV focus ring from `useTheme()`.
 */
export function IconButton({
  icon,
  accessibilityLabel,
  active = false,
  size = 40,
  onPress,
  disabled = false,
  focused,
  testID,
  style,
}: IconButtonProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const [nativeFocused, setNativeFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleFocus = useCallback(() => setNativeFocused(true), []);
  const handleBlur = useCallback(() => setNativeFocused(false), []);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const resolvedSize = Math.max(40, size);
  const iconSize = Math.round(resolvedSize * 0.45);
  const glassBlur = webBackdropBlur(12);
  const transition = webTransition(
    theme,
    'transform, background-color, border-color, opacity, box-shadow',
  );
  const cursor = !disabled ? webCursorPointer() : undefined;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      focusable={!disabled}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={(state) => {
        const activeFocus = focused ?? (nativeFocused || Boolean(state.focused));
        const showTvFocus =
          !disabled && (focused === true || (viewport.inputModality === 'tv' && activeFocus));

        const backgroundColor = active
          ? theme.colors.accentTint
          : showTvFocus
            ? theme.colors.focusFill
            : hovered && !disabled
              ? theme.colors.actionGlassHoverBg
              : theme.colors.actionGlassBg;

        const borderColor = active
          ? theme.colors.accent
          : hovered && !disabled && !showTvFocus
            ? theme.colors.hoverRingBorder
            : theme.colors.actionGlassBorder;

        const pressScale = theme.reduceMotion ? 1 : 0.98;
        const scale = disabled
          ? 1
          : state.pressed
            ? pressScale
            : showTvFocus
              ? theme.focus.buttonScale
              : 1;

        return [
          styles.button,
          {
            width: resolvedSize,
            height: resolvedSize,
            borderRadius: theme.radius.pill,
            backgroundColor,
            borderColor,
            borderWidth: 1,
            opacity: disabled ? 0.45 : state.pressed ? 0.88 : 1,
            transform: [{ scale }],
          },
          glassBlur,
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
            <Icon
              name={icon}
              size={iconSize}
              color={theme.colors.textPrimary}
              testID={testID ? `${testID}-icon` : undefined}
            />
            {showTvFocus ? (
              <View
                pointerEvents="none"
                testID={testID ? `${testID}-focus-ring` : undefined}
                style={[
                  styles.focusRing,
                  {
                    borderRadius: theme.radius.pill,
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
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  focusRing: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    left: -4,
    right: -4,
  },
});
