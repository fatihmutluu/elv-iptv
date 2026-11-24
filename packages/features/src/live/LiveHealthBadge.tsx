import { hexToRgba, useI18n, useTheme } from '@elv/ui-kit';
import { memo, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useChannelHealthStatus } from '../shared';

/**
 * Subtle Cinema Quietude passive stream health micro-badge (`#167`).
 * Renders strictly when cached status is `'flaky'` or `'dead'`, and never clutters healthy or
 * unknown channels.
 */
export const LiveHealthBadge = memo(function LiveHealthBadgeInner({
  channelKey,
  testID,
}: {
  readonly channelKey: string | undefined;
  readonly testID?: string;
}): ReactElement | null {
  const status = useChannelHealthStatus(channelKey);
  const theme = useTheme();
  const i18n = useI18n();

  if (status !== 'flaky' && status !== 'dead') {
    return null;
  }

  const isDead = status === 'dead';
  const label = isDead ? i18n.t('live.health.dead') : i18n.t('live.health.flaky');
  const toneColor = isDead ? theme.colors.liveColor : theme.colors.accentSecondary;
  const textColor = theme.highContrast
    ? theme.colors.textPrimary
    : isDead
      ? theme.colors.liveColor
      : theme.colors.textSecondary;

  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      style={[
        styles.badge,
        {
          borderRadius: theme.radius.pill,
          borderColor: toneColor,
          backgroundColor: hexToRgba(toneColor, theme.highContrast ? 0.24 : 0.14),
        },
      ]}
    >
      <View
        style={[
          styles.dot,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: toneColor,
          },
        ]}
      />
      <Text numberOfLines={1} style={[theme.typography.micro, styles.label, { color: textColor }]}>
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
    flexShrink: 0,
  },
  dot: {
    width: 5,
    height: 5,
  },
  label: {
    fontWeight: '600',
  },
});
