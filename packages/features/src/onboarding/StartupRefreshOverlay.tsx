import type { ImportProgress } from '@elv/data';
import {
  CtaButton,
  TABULAR_NUMS_STYLE,
  TvFocusGuideRegion,
  useI18n,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { OnboardingBackBridge } from './OnboardingPrimitives';
import {
  computeImportPercent,
  nextQuoteIndex,
  ONBOARDING_QUOTE_KEYS,
  onboardingPhaseMessageId,
} from './onboarding-model';

const QUOTE_ROTATE_MS = 6_000;

/** Props of {@link StartupRefreshOverlay}. */
export interface StartupRefreshOverlayProps {
  readonly visible: boolean;
  readonly activeSourceName: string | null;
  readonly progress: ImportProgress | null;
  readonly completedTasks: number;
  readonly totalTasks: number;
  /** Immediately hides the overlay so the user browses cached data while refresh finishes silently. */
  readonly onCancelContinue: () => void;
}

/**
 * Returning-user cold-startup refresh overlay (`#513` `[5.4]`).
 * Renders strictly in-tree (zero RN `<Modal>`), displays active source progress + rotating cinema
 * quotes, and exposes `Cancel / Continue with old data` which hides the overlay without aborting
 * the background refresh.
 */
export function StartupRefreshOverlay({
  visible,
  activeSourceName,
  progress,
  completedTasks,
  totalTasks,
  onCancelContinue,
}: StartupRefreshOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';
  const [quoteIdx, setQuoteIdx] = useState(0);

  useEffect(() => {
    if (!visible || theme.reduceMotion) return undefined;
    const timer = setInterval(() => {
      setQuoteIdx((prev) => nextQuoteIndex(prev));
    }, QUOTE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [theme.reduceMotion, visible]);

  if (!visible) return null;

  const taskPercent = computeImportPercent(progress);
  const overallPct =
    totalTasks > 0
      ? Math.max(
          8,
          Math.min(
            100,
            Math.round(
              ((completedTasks + (taskPercent !== null ? taskPercent / 100 : 0.35)) / totalTasks) *
                100,
            ),
          ),
        )
      : 40;
  const phaseLabel = progress !== null ? i18n.t(onboardingPhaseMessageId(progress.phase)) : null;
  const quoteKey = ONBOARDING_QUOTE_KEYS[quoteIdx] ?? ONBOARDING_QUOTE_KEYS[0];

  return (
    <TvFocusGuideRegion
      testID="startup-refresh-focus-guide"
      enabled={isTv}
      autoFocus
      trapFocusUp
      trapFocusDown
      trapFocusLeft
      trapFocusRight
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.scrimStrong,
          paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
          paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
        },
      ]}
    >
      <OnboardingBackBridge enabled={visible} isTv={isTv} onBack={onCancelContinue} />
      <View
        testID="startup-refresh-overlay"
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <Text
          accessibilityRole="header"
          style={[theme.typography.h1, styles.center, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('startup.refresh.title')}
        </Text>
        <Text style={[theme.typography.body, styles.center, { color: theme.colors.textSecondary }]}>
          {i18n.t('startup.refresh.subtitle')}
        </Text>

        <View style={styles.progressBlock}>
          {activeSourceName !== null ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.title, styles.center, { color: theme.colors.textPrimary }]}
            >
              {activeSourceName}
            </Text>
          ) : null}

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
                  width: `${overallPct}%`,
                  backgroundColor: theme.colors.accent,
                  borderRadius: theme.radius.pill,
                },
              ]}
            />
          </View>

          {phaseLabel !== null && progress !== null ? (
            <Text
              testID="startup-refresh-phase"
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                styles.center,
                { color: theme.colors.textSecondary },
              ]}
            >
              {taskPercent !== null
                ? i18n.t('sources.status.importingPercent', {
                    phase: phaseLabel,
                    done: progress.done,
                    percent: taskPercent,
                  })
                : i18n.t('sources.status.importing', {
                    phase: phaseLabel,
                    done: progress.done,
                  })}
            </Text>
          ) : null}
        </View>

        {quoteKey !== undefined ? (
          <Text
            testID="startup-refresh-quote"
            style={[theme.typography.caption, styles.quote, { color: theme.colors.textMuted }]}
          >
            {i18n.t(quoteKey)}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <CtaButton
            testID="startup-refresh-cancel"
            variant="secondary"
            label={i18n.t('startup.refresh.cancelContinue')}
            hasTVPreferredFocus={isTv}
            onPress={onCancelContinue}
          />
          <Text style={[theme.typography.micro, styles.center, { color: theme.colors.textMuted }]}>
            {i18n.t('startup.refresh.backgroundNote')}
          </Text>
        </View>
      </View>
    </TvFocusGuideRegion>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '100%',
    maxWidth: 500,
    borderWidth: 1,
    padding: 28,
    alignItems: 'center',
    gap: 14,
  },
  center: { textAlign: 'center' },
  progressBlock: { width: '100%', gap: 8, marginTop: 4 },
  track: { width: '100%', height: 8, overflow: 'hidden' },
  fill: { height: '100%' },
  quote: { textAlign: 'center', fontStyle: 'italic', marginTop: 4 },
  actions: { alignItems: 'center', gap: 8, marginTop: 8 },
});
