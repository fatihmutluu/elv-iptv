import { CtaButton, TABULAR_NUMS_STYLE, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  computeImportPercent,
  nextQuoteIndex,
  ONBOARDING_QUOTE_KEYS,
  type OnboardingImportSnapshot,
  onboardingPhaseMessageId,
} from './onboarding-model';

const QUOTE_ROTATE_MS = 6_000;

/** Props of {@link OnboardingWaitingStage}. */
export interface OnboardingWaitingStageProps {
  readonly importState: OnboardingImportSnapshot;
  readonly onRetry: () => void;
  readonly onEditSource: () => void;
  /** Invoked automatically the moment `importState.status` becomes `'ready'`. */
  readonly onAutoEnterApp: () => void;
}

/**
 * Calm centered waiting stage reached if the user finishes Personalization Card 4 while the
 * provider is still importing (`#513`). Rotates cinema quotes gently and enters automatically
 * the instant the import completes.
 */
export function OnboardingWaitingStage({
  importState,
  onRetry,
  onEditSource,
  onAutoEnterApp,
}: OnboardingWaitingStageProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';
  const [quoteIdx, setQuoteIdx] = useState(0);

  useEffect(() => {
    if (importState.status === 'ready') {
      onAutoEnterApp();
    }
  }, [importState.status, onAutoEnterApp]);

  useEffect(() => {
    if (theme.reduceMotion || importState.status !== 'importing') return undefined;
    const timer = setInterval(() => {
      setQuoteIdx((prev) => nextQuoteIndex(prev));
    }, QUOTE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [importState.status, theme.reduceMotion]);

  const percent = computeImportPercent(importState.progress);
  const barWidthPct = percent !== null ? Math.max(10, percent) : 45;
  const phaseLabel =
    importState.progress !== null
      ? i18n.t(onboardingPhaseMessageId(importState.progress.phase))
      : null;
  const quoteKey = ONBOARDING_QUOTE_KEYS[quoteIdx] ?? ONBOARDING_QUOTE_KEYS[0];

  if (importState.status === 'error') {
    return (
      <View testID="onboarding-waiting-stage" style={styles.root}>
        <Text
          accessibilityRole="header"
          style={[theme.typography.h1, styles.center, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('onboarding.import.failed')}
        </Text>
        <Text
          testID="onboarding-waiting-error"
          style={[theme.typography.body, styles.center, { color: theme.colors.liveColor }]}
        >
          {i18n.t(importState.errorMessageId ?? 'onboarding.import.failed')}
        </Text>
        <View style={styles.errorActions}>
          <CtaButton
            testID="onboarding-waiting-retry"
            variant="primary"
            label={i18n.t('onboarding.import.retryAction')}
            hasTVPreferredFocus={isTv}
            onPress={onRetry}
          />
          <CtaButton
            testID="onboarding-waiting-edit"
            variant="secondary"
            label={i18n.t('onboarding.import.editSourceAction')}
            onPress={onEditSource}
          />
        </View>
      </View>
    );
  }

  return (
    <View testID="onboarding-waiting-stage" style={styles.root}>
      <Text
        accessibilityRole="header"
        style={[theme.typography.h1, styles.center, { color: theme.colors.textPrimary }]}
      >
        {i18n.t('onboarding.waiting.title')}
      </Text>
      <Text style={[theme.typography.body, styles.center, { color: theme.colors.textSecondary }]}>
        {i18n.t('onboarding.waiting.subtitle')}
      </Text>

      <View style={styles.progressWrap}>
        <View
          style={[
            styles.track,
            { backgroundColor: theme.colors.bgSurface, borderRadius: theme.radius.pill },
          ]}
        >
          <View
            style={[
              styles.fill,
              {
                width: `${barWidthPct}%`,
                backgroundColor: theme.colors.accent,
                borderRadius: theme.radius.pill,
              },
            ]}
          />
        </View>
        <Text
          testID="onboarding-waiting-phase"
          style={[
            theme.typography.caption,
            TABULAR_NUMS_STYLE,
            styles.center,
            { color: theme.colors.textSecondary },
          ]}
        >
          {phaseLabel !== null && importState.progress !== null
            ? percent !== null
              ? i18n.t('sources.status.importingPercent', {
                  phase: phaseLabel,
                  done: importState.progress.done,
                  percent,
                })
              : i18n.t('sources.status.importing', {
                  phase: phaseLabel,
                  done: importState.progress.done,
                })
            : i18n.t('onboarding.import.loading')}
        </Text>
      </View>

      {quoteKey !== undefined ? (
        <Text
          testID="onboarding-waiting-quote"
          style={[theme.typography.caption, styles.quote, { color: theme.colors.textMuted }]}
        >
          {i18n.t(quoteKey)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', paddingVertical: 28, alignItems: 'center', gap: 16 },
  center: { textAlign: 'center' },
  progressWrap: { width: '100%', maxWidth: 420, gap: 8, marginTop: 4 },
  track: { width: '100%', height: 8, overflow: 'hidden' },
  fill: { height: '100%' },
  quote: { textAlign: 'center', maxWidth: 440, fontStyle: 'italic', marginTop: 8 },
  errorActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 },
});
