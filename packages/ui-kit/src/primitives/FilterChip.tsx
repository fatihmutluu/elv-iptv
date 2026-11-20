import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme, webCursorPointer, webShadow, webTransition } from '../theme';
import { useViewport } from '../viewport';

/** Props of {@link FilterChip}. */
export interface FilterChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  focusable?: boolean;
  focused?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const TV_FOCUS_NATIVE_SHADOW: ViewStyle = {
  shadowColor: 'rgba(0, 0, 0, 1)',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.5,
  shadowRadius: 12,
  elevation: 8,
};

/**
 * Pill-shaped genre, category, or search-scope filter chip.
 * Active selection uses neutral high-contrast `ctaBg`/`ctaFg` with bold `'700'` weight, while
 * touch viewports expand to a `40px` minimum target height.
 */
export function FilterChip({
  label,
  selected = false,
  onPress,
  disabled = false,
  focusable,
  focused,
  testID,
  style,
}: FilterChipProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const [nativeFocused, setNativeFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleFocus = useCallback(() => setNativeFocused(true), []);
  const handleBlur = useCallback(() => setNativeFocused(false), []);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const minHeight = viewport.inputModality === 'touch' ? 40 : 32;
  const transition = webTransition(
    theme,
    'transform, background-color, border-color, opacity, box-shadow',
  );
  const cursor = !disabled ? webCursorPointer() : undefined;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      focusable={focusable ?? !disabled}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={(state) => {
        const activeFocus = focused ?? (nativeFocused || Boolean(state.focused));
        const showTvFocus =
          !disabled && (focused === true || (viewport.inputModality === 'tv' && activeFocus));

        const backgroundColor = selected
          ? theme.colors.ctaBg
          : showTvFocus
            ? theme.colors.focusFill
            : hovered && !disabled
              ? theme.colors.chipHoverBg
              : theme.colors.chipBg;

        const borderColor = selected ? theme.colors.ctaBg : theme.colors.chipBorder;
        const pressScale = theme.reduceMotion ? 1 : 0.98;
        const scale = disabled
          ? 1
          : state.pressed
            ? pressScale
            : showTvFocus
              ? theme.focus.buttonScale
              : 1;

        return [
          styles.chip,
          {
            minHeight,
            borderRadius: theme.radius.pill,
            backgroundColor,
            borderColor,
            borderWidth: 1,
            paddingHorizontal: 14,
            opacity: disabled ? 0.45 : state.pressed ? 0.88 : 1,
            transform: [{ scale }],
          },
          transition,
          cursor,
          showTvFocus ? TV_FOCUS_NATIVE_SHADOW : undefined,
          showTvFocus ? webShadow('0 10px 24px rgba(0, 0, 0, 0.6)') : undefined,
          style,
        ];
      }}
    >
      {({ focused: stateFocused }) => {
        const activeFocus = focused ?? (nativeFocused || Boolean(stateFocused));
        const showTvFocus =
          !disabled && (focused === true || (viewport.inputModality === 'tv' && activeFocus));
        const textColor = selected
          ? theme.colors.ctaFg
          : showTvFocus || (hovered && !disabled)
            ? theme.colors.textPrimary
            : theme.colors.textSecondary;
        return (
          <>
            <Text
              numberOfLines={1}
              style={[
                theme.typography.caption,
                { color: textColor, fontWeight: selected ? '700' : '600' },
              ]}
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
  chip: {
    position: 'relative',
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
