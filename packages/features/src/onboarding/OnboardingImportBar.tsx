import {
  CtaButton,
  hexToRgba,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  computeImportPercent,
  type OnboardingImportSnapshot,
  onboardingPhaseMessageId,
} from './onboarding-model';

/** Props of {@link OnboardingImportBar}. */
export interface OnboardingImportBarProps {
  readonly importState: OnboardingImportSnapshot;
  readonly onRetry: () => void;
  readonly onEditSource: () => void;
}

/**
 * Slim persistent top import progress & status strip mounted across Screen 3 (ELV Mode)
 * and Personalization Cards 1–4 while the lifted background import runs (`#513`).
 */
export function OnboardingImportBar({
  importState,
  onRetry,
  onEditSource,
}: OnboardingImportBarProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();

  if (importState.status === 'idle') return null;

  const percent = computeImportPercent(importState.progress);
  const phaseLabel =
    importState.progress !== null
      ? i18n.t(onboardingPhaseMessageId(importState.progress.phase))
      : null;

  if (importState.status === 'ready') {
    return (
      <View
        testID="onboarding-import-bar"
        accessibilityLiveRegion="polite"
        style={[
          styles.bar,
          {
            backgroundColor: hexToRgba(theme.colors.successColor, theme.highContrast ? 0.25 : 0.14),
            borderColor: hexToRgba(theme.colors.successColor, 0.55),
            borderRadius: theme.radius.card,
          },
        ]}
      >
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: theme.colors.successColor }]} />
          <Text
            testID="onboarding-import-status-text"
            style={[
              theme.typography.caption,
              { color: theme.colors.successColor, fontWeight: '700' },
            ]}
          >
            {i18n.t('onboarding.import.ready')}
          </Text>
        </View>
      </View>
    );
  }

  if (importState.status === 'error') {
    return (
      <View
        testID="onboarding-import-bar"
        accessibilityLiveRegion="polite"
        style={[
          styles.bar,
          {
            backgroundColor: hexToRgba(theme.colors.dangerBg, 0.45),
            borderColor: theme.colors.dangerBorder,
            borderRadius: theme.radius.card,
          },
        ]}
      >
        <View style={styles.errorRow}>
          <Text
            testID="onboarding-import-status-text"
            style={[theme.typography.caption, styles.flex1, { color: theme.colors.liveColor }]}
          >
            {i18n.t(importState.errorMessageId ?? 'onboarding.import.failed')}
          </Text>
          <View style={styles.errorActions}>
            <CtaButton
              testID="onboarding-import-retry"
              variant="secondary"
              label={i18n.t('onboarding.import.retryAction')}
              onPress={onRetry}
            />
            <CtaButton
              testID="onboarding-import-edit"
              variant="ghost"
              label={i18n.t('onboarding.import.editSourceAction')}
              onPress={onEditSource}
            />
          </View>
        </View>
      </View>
    );
  }

  const barWidthPct = percent !== null ? Math.max(8, percent) : 38;
  const progressText =
    phaseLabel !== null && importState.progress !== null
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
      : i18n.t('onboarding.import.loading');

  return (
    <View
      testID="onboarding-import-bar"
      accessibilityLiveRegion="polite"
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.bgCard,
          borderColor: theme.colors.surfaceBorder,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <View style={styles.statusRow}>
        <Text
          testID="onboarding-import-status-text"
          numberOfLines={1}
          style={[
            theme.typography.caption,
            TABULAR_NUMS_STYLE,
            styles.flex1,
            { color: theme.colors.textPrimary },
          ]}
        >
          {progressText}
        </Text>
        {percent !== null ? (
          <Text
            style={[
              theme.typography.micro,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {`${percent}%`}
          </Text>
        ) : null}
      </View>
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
      <Text style={[theme.typography.micro, { color: theme.colors.textMuted }]}>
        {i18n.t('onboarding.import.providerWaitHint')}
      </Text>
    </View>
  );
}

/** Props of {@link OnboardingDynamicFooter}. */
export interface OnboardingDynamicFooterProps {
  readonly importState: OnboardingImportSnapshot;
  readonly hasNextCustomStep: boolean;
  readonly onContinue: () => void;
  readonly onEnterApp: () => void;
}

/**
 * Dynamic bottom CTA footer for Screen 3 and Personalization Cards 1–4 (`#513`):
 * - While importing: white primary `Continue` CTA
 * - The instant import reaches `'ready'`: semantic success green `Enter App` CTA +
 *   subtle `Continue customizing` link underneath (when further cards remain)
 */
export function OnboardingDynamicFooter({
  importState,
  hasNextCustomStep,
  onContinue,
  onEnterApp,
}: OnboardingDynamicFooterProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';
  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'transform, opacity, background-color');

  if (importState.status === 'ready') {
    return (
      <View style={[styles.footerWrap, { borderTopColor: theme.colors.surfaceBorder }]}>
        <Pressable
          testID="onboarding-enter-app-cta"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('onboarding.import.enterAppAction')}
          hasTVPreferredFocus={isTv}
          focusable
          onPress={onEnterApp}
          style={(state) => [
            styles.enterAppBtn,
            cursorPointer,
            transition,
            {
              backgroundColor: theme.colors.successColor,
              borderRadius: theme.radius.button,
              borderWidth: state.focused ? theme.focus.ringWidth : 0,
              borderColor: theme.colors.focusRingColor,
              opacity: state.pressed ? 0.88 : 1,
            },
          ]}
        >
          <Text style={[theme.typography.title, styles.bold, { color: theme.colors.ctaFg }]}>
            {i18n.t('onboarding.import.enterAppAction')}
          </Text>
        </Pressable>

        {hasNextCustomStep ? (
          <Pressable
            testID="onboarding-continue-customizing"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('onboarding.import.continueCustomizing')}
            focusable
            onPress={onContinue}
            style={(state) => [
              styles.subtleLink,
              cursorPointer,
              {
                borderRadius: theme.radius.button,
                backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
              },
            ]}
          >
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('onboarding.import.continueCustomizing')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.footerWrap, { borderTopColor: theme.colors.surfaceBorder }]}>
      <CtaButton
        testID="onboarding-next-cta"
        variant="primary"
        label={i18n.t('onboarding.import.continueAction')}
        hasTVPreferredFocus={isTv}
        onPress={onContinue}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  flex1: { flex: 1 },
  track: { height: 5, width: '100%', overflow: 'hidden' },
  fill: { height: '100%' },
  errorRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  errorActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footerWrap: {
    paddingTop: 14,
    borderTopWidth: 1,
    alignItems: 'center',
    gap: 8,
  },
  enterAppBtn: {
    minHeight: 42,
    paddingHorizontal: 24,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bold: { fontWeight: '700' },
  subtleLink: { paddingHorizontal: 12, paddingVertical: 6 },
});
