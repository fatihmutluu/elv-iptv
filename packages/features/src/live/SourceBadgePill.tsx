import { hexToRgba, useTheme } from '@elv/ui-kit';
import { memo, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SourceBadgeInfo } from './source-badge';

/** Compact theme-derived per-source pill differentiating multi-source Live channels (`#126`). */
export const SourceBadgePill = memo(function SourceBadgePillInner({
  badge,
  testID,
}: {
  readonly badge: SourceBadgeInfo | null | undefined;
  readonly testID?: string;
}): ReactElement | null {
  const theme = useTheme();
  if (!badge) return null;
  return (
    <View
      testID={testID}
      style={[
        styles.pill,
        {
          borderRadius: theme.radius.pill,
          borderColor: badge.color,
          backgroundColor: hexToRgba(badge.color, 0.16),
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[theme.typography.micro, styles.label, { color: theme.colors.textPrimary }]}
      >
        {badge.label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  pill: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
    flexShrink: 0,
    maxWidth: 84,
  },
  label: { fontWeight: '600' },
});
