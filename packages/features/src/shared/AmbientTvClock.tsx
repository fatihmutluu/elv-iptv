import type { TvClockMode } from '@elv/domain';
import { TABULAR_NUMS_STYLE, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import {
  type AmbientClockSurface,
  formatAmbientClockTime,
  msUntilNextMinuteBoundary,
  shouldShowAmbientClock,
} from './ambient-clock';

/** Props of {@link AmbientTvClock}. */
export interface AmbientTvClockProps {
  readonly surface: AmbientClockSurface;
  readonly mode?: TvClockMode | undefined;
  /** Optional clock provider in epoch milliseconds (defaults to `Date.now`). */
  readonly now?: (() => number) | undefined;
  readonly testID?: string | undefined;
}

/**
 * Quiet Cinema Quietude v2 ambient local clock for 10-foot TV surfaces (`#416`).
 * Renders strictly on `viewport.formFactor === 'tv'` when `mode` allows `surface`, aligns
 * updates to exact minute boundaries with chained `setTimeout` (zero 1s `setInterval` churn),
 * and cleans up timers immediately on unmount or hide.
 */
export function AmbientTvClock({
  surface,
  mode = 'always',
  now = Date.now,
  testID = `ambient-tv-clock-${surface}`,
}: AmbientTvClockProps): ReactElement | null {
  const viewport = useViewport();
  const theme = useTheme();
  const i18n = useI18n();
  const visible = viewport.formFactor === 'tv' && shouldShowAmbientClock(mode, surface);

  const [nowMs, setNowMs] = useState<number>(() => now());

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tickAndSchedule = (): void => {
      if (cancelled) return;
      const current = now();
      setNowMs(current);
      timer = setTimeout(tickAndSchedule, msUntilNextMinuteBoundary(current));
    };

    const current = now();
    setNowMs(current);
    timer = setTimeout(tickAndSchedule, msUntilNextMinuteBoundary(current));

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [now, visible]);

  if (!visible) return null;

  const formatted = formatAmbientClockTime(nowMs, i18n.locale);

  return (
    <Text
      testID={testID}
      numberOfLines={1}
      accessibilityLabel={formatted}
      style={[
        theme.typography.caption,
        TABULAR_NUMS_STYLE,
        styles.clockText,
        { color: theme.colors.textSecondary },
      ]}
    >
      {formatted}
    </Text>
  );
}

const styles = StyleSheet.create({
  clockText: {
    fontWeight: '600',
    flexShrink: 0,
  },
});
