import type { AppI18n } from '@elv/i18n';
import { Icon, useTheme, webBackdropBlur } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Props of {@link ExternalDisplayCard}. */
export interface ExternalDisplayCardProps {
  readonly i18n: AppI18n;
}

/**
 * Cinema Quietude non-interactive stage card displayed on the handheld screen when video
 * is routed to a connected external display (`#258`). Uses `pointerEvents="none"` so
 * handheld tap/scrub gestures and OSD controls remain fully responsive.
 */
export function ExternalDisplayCard({ i18n }: ExternalDisplayCardProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID="player-external-display-card"
      pointerEvents="none"
      accessibilityRole="text"
      accessibilityLabel={i18n.t('player.externalDisplay.title')}
      style={styles.overlay}
    >
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
            paddingHorizontal: theme.spacing.xl,
            paddingVertical: theme.spacing.lg,
            gap: theme.spacing.sm,
          },
          webBackdropBlur(16),
        ]}
      >
        <View
          style={[
            styles.iconWrap,
            {
              backgroundColor: theme.colors.accentTint,
              borderColor: theme.colors.accent,
              borderRadius: theme.radius.pill,
            },
          ]}
        >
          <Icon name="tv" size={28} color={theme.colors.accent} />
        </View>
        <Text
          testID="player-external-display-title"
          style={[theme.typography.h2, styles.centeredText, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('player.externalDisplay.title')}
        </Text>
        <Text
          testID="player-external-display-subtitle"
          style={[
            theme.typography.body,
            styles.centeredText,
            { color: theme.colors.textSecondary },
          ]}
        >
          {i18n.t('player.externalDisplay.subtitle')}
        </Text>
        <Text
          testID="player-external-display-hint"
          style={[theme.typography.caption, styles.centeredText, { color: theme.colors.textMuted }]}
        >
          {i18n.t('player.externalDisplay.hint')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    maxWidth: 420,
    width: '100%',
    borderWidth: 1,
    alignItems: 'center',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  centeredText: {
    textAlign: 'center',
  },
});
