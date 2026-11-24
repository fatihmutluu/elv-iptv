import {
  CtaButton,
  Icon,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ReminderBannerState } from '../app-shell-reminders';

const NOOP_TV_SUBSCRIBER = (): boolean => false;

/** Props of {@link ReminderToastBanner}. */
export interface ReminderToastBannerProps {
  readonly banner: ReminderBannerState | null;
  readonly onTune: () => void;
  readonly onDismiss: () => void;
}

type ReminderBannerAction = 'tune' | 'dismiss';

function ReminderBannerTvKeyTrap({
  onLeft,
  onRight,
  onSelect,
  onBack,
}: {
  readonly onLeft: () => void;
  readonly onRight: () => void;
  readonly onSelect: () => void;
  readonly onBack: () => void;
}): ReactElement {
  const cbRef = useRef({ onLeft, onRight, onSelect, onBack });
  cbRef.current = { onLeft, onRight, onSelect, onBack };

  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    if (input.action !== 'down' && input.action !== 'press') {
      return (
        input.key === 'left' ||
        input.key === 'right' ||
        input.key === 'up' ||
        input.key === 'down' ||
        input.key === 'select' ||
        input.key === 'back'
      );
    }
    if (input.key === 'left') {
      cbRef.current.onLeft();
      return true;
    }
    if (input.key === 'right') {
      cbRef.current.onRight();
      return true;
    }
    if (input.key === 'select') {
      cbRef.current.onSelect();
      return true;
    }
    if (input.key === 'back') {
      cbRef.current.onBack();
      return true;
    }
    if (input.key === 'up' || input.key === 'down') {
      return true;
    }
    return false;
  });

  return <TvFocusAnchor testID="reminder-banner-tv-focus-anchor" hasTVPreferredFocus />;
}

/**
 * Non-blocking Cinema Quietude floating programme reminder banner (`#35`).
 * Anchors top-right inside safe/overscan margins with focusable `"Tune now"` and `"Dismiss"` CTAs,
 * TV D-pad remote interception, zero `<Modal>`, and zero hardcoded colors — never steals active playback.
 */
export function ReminderToastBanner({
  banner,
  onTune,
  onDismiss,
}: ReminderToastBannerProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const [focusedAction, setFocusedAction] = useState<ReminderBannerAction>('tune');
  const focusedActionRef = useRef<ReminderBannerAction>('tune');
  focusedActionRef.current = focusedAction;

  const bannerKey =
    banner !== null ? `${banner.reminder.channelKey}|${banner.reminder.programmeStart}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset default TV focus to Tune now whenever a new reminder banner appears
  useEffect(() => {
    setFocusedAction('tune');
    focusedActionRef.current = 'tune';
  }, [bannerKey]);

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
      {isTv ? (
        <ReminderBannerTvKeyTrap
          onLeft={() => {
            focusedActionRef.current = 'tune';
            setFocusedAction('tune');
          }}
          onRight={() => {
            focusedActionRef.current = 'dismiss';
            setFocusedAction('dismiss');
          }}
          onSelect={() => {
            if (focusedActionRef.current === 'tune') onTune();
            else onDismiss();
          }}
          onBack={onDismiss}
        />
      ) : null}
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
            focusable={!isTv}
            focused={isTv && focusedAction === 'tune'}
            onPress={onTune}
          />
          <CtaButton
            testID="reminder-banner-dismiss"
            variant="secondary"
            label={i18n.t('epg.reminderDismiss')}
            focusable={!isTv}
            focused={isTv && focusedAction === 'dismiss'}
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
