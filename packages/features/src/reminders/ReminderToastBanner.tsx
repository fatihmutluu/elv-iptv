import {
  CtaButton,
  Icon,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ReminderBannerState } from '../app-shell-reminders';

/** Props of {@link ReminderToastBanner}. */
export interface ReminderToastBannerProps {
  readonly banner: ReminderBannerState | null;
  readonly onTune: () => void;
  readonly onDismiss: () => void;
}

/**
 * Non-blocking Cinema Quietude floating programme reminder banner (`#35`).
 * Anchors top-right inside safe/overscan margins with focusable `"Tune now"` and `"Dismiss"` CTAs,
 * zero `<Modal>`, and zero hardcoded colors — never steals active playback.
 */
export function ReminderToastBanner({
  banner,
  onTune,
  onDismiss,
}: ReminderToastBannerProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();

  if (banner === null) return null;

  const { reminder, startsInMinutes } = banner;
  const timingText =
    startsInMinutes <= 0
      ? i18n.t('epg.reminderStartingNow')
      : i18n.t('epg.reminderStartsIn', { minutes: startsInMinutes });

  return (
    <View
      testID="reminder-toast-container"
      pointerEvents="box-none"
      style={[
        styles.anchor,
        {
          top: 16 + viewport.safeArea.top + viewport.overscan.y,
          right: 16 + viewport.safeArea.right + viewport.overscan.x,
          left: 16 + viewport.safeArea.left + viewport.overscan.x,
        },
      ]}
    >
      <View
        testID="reminder-toast-banner"
        accessibilityLiveRegion="polite"
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.headerRow}>
          <View
            style={[
              styles.iconBadge,
              {
                backgroundColor: theme.colors.accentTint,
                borderRadius: theme.radius.pill,
              },
            ]}
          >
            <Icon name="bell" size={16} color={theme.colors.accent} />
          </View>
          <View style={styles.textCol}>
            <Text
              testID="reminder-banner-heading"
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.accent, fontWeight: '700' }]}
            >
              {i18n.t('epg.reminderBannerTitle')}
            </Text>
            <Text
              testID="reminder-banner-programme"
              numberOfLines={1}
              style={[theme.typography.title, { color: theme.colors.textPrimary }]}
            >
              {reminder.programmeTitle}
            </Text>
            <Text
              testID="reminder-banner-meta"
              numberOfLines={1}
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textSecondary },
              ]}
            >
              {`${reminder.channelName} · ${timingText}`}
            </Text>
          </View>
        </View>

        <View style={styles.actionsRow}>
          <CtaButton
            testID="reminder-banner-tune"
            variant="primary"
            icon="play"
            label={i18n.t('epg.reminderTuneNow')}
            onPress={onTune}
          />
          <CtaButton
            testID="reminder-banner-dismiss"
            variant="secondary"
            label={i18n.t('epg.reminderDismiss')}
            onPress={onDismiss}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    zIndex: 60,
    alignItems: 'flex-end',
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBadge: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  textCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
});
