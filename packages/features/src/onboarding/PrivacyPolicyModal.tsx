import {
  CtaButton,
  TvFocusGuideRegion,
  useI18n,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { OnboardingBackBridge } from './OnboardingPrimitives';

/** Props of {@link PrivacyPolicyModal}. */
export interface PrivacyPolicyModalProps {
  readonly visible: boolean;
  readonly onClose: () => void;
}

/**
 * In-tree KVKK & GDPR Privacy Policy notice opened from Onboarding Screen 1 (`#513`).
 * Renders strictly in-tree (zero RN `<Modal>`), supports Escape and TV Back dismissal,
 * and uses dynamic Cinema Quietude theme tokens with zero hardcoded hex.
 */
export function PrivacyPolicyModal({
  visible,
  onClose,
}: PrivacyPolicyModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  if (!visible) return null;

  return (
    <TvFocusGuideRegion
      testID="onboarding-privacy-focus-guide"
      enabled={isTv}
      autoFocus
      trapFocusUp
      trapFocusDown
      trapFocusLeft
      trapFocusRight
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.overlayBackdrop,
          paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
          paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
        },
      ]}
    >
      <OnboardingBackBridge enabled={visible} isTv={isTv} onBack={onClose} />
      <View
        testID="onboarding-privacy-modal"
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
        <ScrollView
          testID="onboarding-privacy-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            testID="onboarding-privacy-section-summary"
            focusable={isTv}
            accessible
            style={(state) => [
              styles.section,
              styles.focusableBlock,
              {
                borderRadius: theme.radius.button,
                borderWidth: state.focused ? theme.focus.ringWidth : 1,
                borderColor: state.focused ? theme.colors.focusRingColor : 'transparent',
                backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
              },
            ]}
          >
            <Text
              accessibilityRole="header"
              style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('onboarding.privacy.title')}
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              {i18n.t('onboarding.privacy.summary')}
            </Text>
          </Pressable>

          {(
            [
              ['data', 'onboarding.privacy.sectionDataTitle', 'onboarding.privacy.sectionDataBody'],
              [
                'diagnostics',
                'onboarding.privacy.sectionDiagnosticsTitle',
                'onboarding.privacy.sectionDiagnosticsBody',
              ],
              [
                'rights',
                'onboarding.privacy.sectionRightsTitle',
                'onboarding.privacy.sectionRightsBody',
              ],
            ] as const
          ).map(([id, titleKey, bodyKey]) => (
            <Pressable
              key={id}
              testID={`onboarding-privacy-section-${id}`}
              focusable={isTv}
              accessible
              style={(state) => [
                styles.section,
                styles.focusableBlock,
                {
                  borderRadius: theme.radius.button,
                  borderWidth: state.focused ? theme.focus.ringWidth : 1,
                  borderColor: state.focused ? theme.colors.focusRingColor : 'transparent',
                  backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                },
              ]}
            >
              <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                {i18n.t(titleKey)}
              </Text>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t(bodyKey)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={[styles.footer, { borderTopColor: theme.colors.surfaceBorder }]}>
          <CtaButton
            testID="onboarding-privacy-close"
            variant="primary"
            label={i18n.t('onboarding.privacy.close')}
            hasTVPreferredFocus={isTv}
            onPress={onClose}
          />
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
    zIndex: 82,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '100%',
    maxWidth: 540,
    maxHeight: '86%',
    borderWidth: 1,
    overflow: 'hidden',
  },
  scroll: { flexGrow: 0 },
  content: { padding: 24, gap: 10 },
  section: { gap: 4 },
  focusableBlock: { paddingHorizontal: 8, paddingVertical: 6 },
  footer: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderTopWidth: 1,
    alignItems: 'flex-end',
  },
});
