import type { NowNextEntry } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import { TABULAR_NUMS_STYLE, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatProgrammeWindow } from './player-info-model';

/** Props of {@link ChannelDrawerScheduleBox}. */
export interface ChannelDrawerScheduleBoxProps {
  readonly schedule: NowNextEntry | null | undefined;
  readonly i18n: AppI18n;
}

/** Focused channel EPG Now/Next schedule footer rendered inside {@link PlayerChannelDrawer}. */
export function ChannelDrawerScheduleBox({
  schedule,
  i18n,
}: ChannelDrawerScheduleBoxProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID="player-channel-drawer-schedule"
      style={[
        styles.scheduleBox,
        {
          backgroundColor: theme.colors.bgSurface,
          borderTopColor: theme.colors.surfaceBorder,
        },
      ]}
    >
      {schedule?.now != null ? (
        <>
          <View style={styles.scheduleLine}>
            <Text style={[theme.typography.micro, { color: theme.colors.accent }]}>
              {i18n.t('player.nowPlaying')}
            </Text>
            <Text
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textMuted },
              ]}
            >
              {formatProgrammeWindow(schedule.now.start, schedule.now.stop)}
            </Text>
          </View>
          <Text
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
          >
            {schedule.now.title}
          </Text>
          {schedule.next != null ? (
            <View style={styles.upNextLine}>
              <Text style={[theme.typography.micro, { color: theme.colors.textMuted }]}>
                {i18n.t('player.upNext')}
              </Text>
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  styles.flex1,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {schedule.next.title}
              </Text>
            </View>
          ) : null}
        </>
      ) : (
        <Text
          numberOfLines={1}
          style={[theme.typography.caption, { color: theme.colors.textMuted }]}
        >
          {i18n.t('player.noProgrammeInfo')}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  scheduleBox: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
    borderRadius: 6,
  },
  scheduleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  upNextLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
});
