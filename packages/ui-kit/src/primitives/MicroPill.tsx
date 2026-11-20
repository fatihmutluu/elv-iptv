import type { ReactElement } from 'react';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { TABULAR_NUMS_STYLE, useTheme, webBackdropBlur } from '../theme';

/** Semantic color treatment of {@link MicroPill}. */
export type MicroPillTone = 'neutral' | 'live' | 'accent' | 'success';

/** Props of {@link MicroPill}. */
export interface MicroPillProps {
  label: string;
  tone?: MicroPillTone;
  dot?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Compact micro-badge (`4K HDR`, `16+`, `LIVE`, match/rating percentages).
 * Uses dark high-contrast `scrimStrong` / `glassBg` surfaces with semantic broadcast-red
 * `liveColor` dot/border so `10.5px` micro-labels remain >= 7:1 WCAG AAA across every preset.
 */
export function MicroPill({
  label,
  tone = 'neutral',
  dot,
  testID,
  style,
}: MicroPillProps): ReactElement {
  const theme = useTheme();
  const showDot = dot ?? tone === 'live';

  const backgroundColor =
    tone === 'live'
      ? theme.colors.scrimStrong
      : tone === 'accent'
        ? theme.colors.accentTint
        : theme.colors.glassBg;

  const borderColor =
    tone === 'live'
      ? theme.colors.liveColor
      : tone === 'accent'
        ? theme.colors.accent
        : tone === 'success'
          ? theme.colors.successColor
          : theme.colors.glassBorder;

  const textColor = tone === 'success' ? theme.colors.successColor : theme.colors.textPrimary;

  const dotColor =
    tone === 'live'
      ? theme.colors.liveColor
      : tone === 'success'
        ? theme.colors.successColor
        : tone === 'accent'
          ? theme.colors.accent
          : theme.colors.textPrimary;

  const borderRadius = tone === 'live' ? theme.radius.pill : theme.radius.button;

  return (
    <View
      testID={testID}
      style={[
        styles.pill,
        {
          backgroundColor,
          borderColor,
          borderRadius,
        },
        tone === 'neutral' || tone === 'live' ? webBackdropBlur(6) : undefined,
        style,
      ]}
    >
      {showDot ? (
        <View
          testID={testID ? `${testID}-dot` : undefined}
          style={[
            styles.dot,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: dotColor,
            },
          ]}
        />
      ) : null}
      <Text
        numberOfLines={1}
        style={[
          theme.typography.micro,
          TABULAR_NUMS_STYLE,
          { color: textColor },
          tone === 'live' ? styles.liveLabel : undefined,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 4,
    borderWidth: 1,
  },
  dot: {
    width: 5,
    height: 5,
  },
  liveLabel: {
    fontWeight: '800',
  },
});
