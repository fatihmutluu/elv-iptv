import {
  MAX_REFRESH_RATE_AUDIO_DELAY_MS,
  MIN_REFRESH_RATE_AUDIO_DELAY_MS,
  REFRESH_RATE_BUCKETS,
  type RefreshRateBucket,
} from '@elv/domain';
import { CtaButton, FilterChip, TABULAR_NUMS_STYLE, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  formatRefreshRateDelayMs,
  REFRESH_RATE_DELAY_STEP_MS,
  resetRefreshRateAudioDelay,
  stepRefreshRateAudioDelay,
} from './playback-controls';
import type { PlaybackFocusId } from './useTvSettingsNavigation';

/** Props of {@link RefreshRateDelayEditor}. */
export interface RefreshRateDelayEditorProps {
  readonly delays: Readonly<Partial<Record<RefreshRateBucket, number>>>;
  readonly selectedBucket: RefreshRateBucket;
  readonly focusedControlId: PlaybackFocusId | null;
  readonly isTv: boolean;
  readonly onSelectBucket: (bucket: RefreshRateBucket) => void;
  readonly onChangeDelays: (next: Readonly<Partial<Record<RefreshRateBucket, number>>>) => void;
}

/**
 * Compact Cinema Quietude per-refresh-rate A/V delay bucket selector and `±25 ms` stepper (`#115`).
 * Supports pointer/touch buttons as well as 10-ft TV D-pad left/right adjustment on `delay-stepper`.
 */
export function RefreshRateDelayEditor({
  delays,
  selectedBucket,
  focusedControlId,
  isTv,
  onSelectBucket,
  onChangeDelays,
}: RefreshRateDelayEditorProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const currentDelayMs = delays[selectedBucket] ?? 0;
  const atMin = currentDelayMs <= MIN_REFRESH_RATE_AUDIO_DELAY_MS;
  const atMax = currentDelayMs >= MAX_REFRESH_RATE_AUDIO_DELAY_MS;
  const stepperFocused = focusedControlId === 'delay-stepper';
  const title = i18n.t('settings.playback.refreshRateAudioDelayTitle');

  return (
    <View testID="settings-playback-refresh-rate-delay" style={styles.container}>
      <View style={styles.headerText}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>{title}</Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('settings.playback.refreshRateAudioDelayDescription')}
        </Text>
      </View>

      <View style={[styles.bucketRow, { gap: theme.spacing.xs }]}>
        {REFRESH_RATE_BUCKETS.map((bucket) => {
          const offset = delays[bucket] ?? 0;
          const label =
            offset !== 0 ? `${bucket} Hz (${formatRefreshRateDelayMs(offset)})` : `${bucket} Hz`;
          return (
            <FilterChip
              key={bucket}
              testID={`settings-playback-delay-bucket-${bucket}`}
              label={label}
              selected={selectedBucket === bucket}
              focused={focusedControlId === `delay-bucket-${bucket}`}
              focusable={!isTv}
              onPress={() => onSelectBucket(bucket)}
            />
          );
        })}
      </View>

      <View
        testID="settings-playback-delay-stepper"
        accessibilityLabel={`${title}: ${selectedBucket} Hz ${formatRefreshRateDelayMs(currentDelayMs)}`}
        style={[
          styles.stepperBar,
          {
            gap: theme.spacing.xs,
            borderRadius: theme.radius.card,
            backgroundColor: stepperFocused ? theme.colors.focusFill : theme.colors.bgCard,
            borderWidth: stepperFocused ? theme.focus.ringWidth : 1,
            borderColor: stepperFocused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
          },
        ]}
      >
        <CtaButton
          testID="settings-playback-delay-dec"
          variant="secondary"
          label={`-${REFRESH_RATE_DELAY_STEP_MS} ms`}
          accessibilityLabel={`${selectedBucket} Hz -${REFRESH_RATE_DELAY_STEP_MS} ms`}
          disabled={atMin}
          focusable={!isTv}
          onPress={() => onChangeDelays(stepRefreshRateAudioDelay(delays, selectedBucket, -1))}
          style={styles.stepButton}
        />

        <Text
          testID="settings-playback-delay-value"
          style={[
            theme.typography.title,
            TABULAR_NUMS_STYLE,
            styles.valueText,
            { color: theme.colors.textPrimary },
          ]}
        >
          {`${selectedBucket} Hz · ${formatRefreshRateDelayMs(currentDelayMs)}`}
        </Text>

        <CtaButton
          testID="settings-playback-delay-inc"
          variant="secondary"
          label={`+${REFRESH_RATE_DELAY_STEP_MS} ms`}
          accessibilityLabel={`${selectedBucket} Hz +${REFRESH_RATE_DELAY_STEP_MS} ms`}
          disabled={atMax}
          focusable={!isTv}
          onPress={() => onChangeDelays(stepRefreshRateAudioDelay(delays, selectedBucket, 1))}
          style={styles.stepButton}
        />

        <CtaButton
          testID="settings-playback-delay-reset"
          variant="secondary"
          label={i18n.t('player.delayReset')}
          accessibilityLabel={`${selectedBucket} Hz ${i18n.t('player.delayReset')}`}
          disabled={currentDelayMs === 0}
          focusable={!isTv}
          onPress={() => onChangeDelays(resetRefreshRateAudioDelay(delays, selectedBucket))}
          style={styles.resetButton}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  headerText: { gap: 2 },
  bucketRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  stepperBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  stepButton: { minWidth: 74, minHeight: 38, paddingHorizontal: 12 },
  resetButton: { minHeight: 38, paddingHorizontal: 12 },
  valueText: { flexGrow: 1, minWidth: 120, textAlign: 'center', fontWeight: '700' },
});
