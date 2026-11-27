import type { MessageId } from '@elv/i18n';
import { CtaButton, useI18n, useTheme, webCursorPointer } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { OAuthProviderId } from '../ports/wave-f9-ports';
import { OnboardingTextField } from './OnboardingPrimitives';

/** Interactive auth sub-phase rendered inside {@link OnboardingWelcomeAuthForm}. */
export type WelcomeAuthSubPhase = 'entry' | 'checking' | 'signin' | 'not_found' | 'signup';

interface OnboardingWelcomeAuthFormProps {
  readonly subPhase: WelcomeAuthSubPhase;
  readonly isTv: boolean;
  readonly email: string;
  readonly password: string;
  readonly confirmPassword: string;
  readonly showCreateFallback: boolean;
  readonly submitting: boolean;
  readonly errorKey: MessageId | null;
  readonly oauthProviders: readonly OAuthProviderId[];
  readonly onChangeEmail: (next: string) => void;
  readonly onChangePassword: (next: string) => void;
  readonly onChangeConfirmPassword: (next: string) => void;
  readonly onCheckEmail: () => void;
  readonly onSignIn: () => void;
  readonly onSignUp: () => void;
  readonly onSelectSignUp: () => void;
  readonly onResetToEntry: () => void;
  readonly onOAuth: (provider: OAuthProviderId) => void;
}

/**
 * Smart Email entry, not-found 1-tap registration prompt, password sign-in, sign-up form,
 * and OAuth seam for Onboarding Screen 1 (`#513`).
 */
export function OnboardingWelcomeAuthForm({
  subPhase,
  isTv,
  email,
  password,
  confirmPassword,
  showCreateFallback,
  submitting,
  errorKey,
  oauthProviders,
  onChangeEmail,
  onChangePassword,
  onChangeConfirmPassword,
  onCheckEmail,
  onSignIn,
  onSignUp,
  onSelectSignUp,
  onResetToEntry,
  onOAuth,
}: OnboardingWelcomeAuthFormProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursorPointer = webCursorPointer();

  return (
    <View style={styles.section}>
      {subPhase === 'entry' || subPhase === 'checking' ? (
        <>
          <OnboardingTextField
            testID="onboarding-email-input"
            label={i18n.t('onboarding.welcome.emailOption')}
            value={email}
            onChangeText={onChangeEmail}
            placeholder={i18n.t('account.emailPlaceholder')}
            keyboardType="email-address"
            autoComplete="email"
            editable={subPhase !== 'checking'}
            onSubmitEditing={onCheckEmail}
          />
          {errorKey !== null ? (
            <Text
              testID="onboarding-welcome-error"
              accessibilityLiveRegion="polite"
              style={[theme.typography.caption, { color: theme.colors.liveColor }]}
            >
              {i18n.t(errorKey)}
            </Text>
          ) : null}
          <CtaButton
            testID="onboarding-email-continue"
            variant="primary"
            label={
              subPhase === 'checking'
                ? i18n.t('onboarding.welcome.checkingEmail')
                : i18n.t('onboarding.welcome.emailContinue')
            }
            disabled={subPhase === 'checking'}
            onPress={onCheckEmail}
          />
        </>
      ) : subPhase === 'not_found' ? (
        <View
          style={[
            styles.infoCard,
            {
              backgroundColor: theme.colors.bgCard,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <Text style={[theme.typography.body, { color: theme.colors.textPrimary }]}>
            {i18n.t('onboarding.welcome.notFoundPrompt')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {email.trim()}
          </Text>
          <View style={styles.inlineRow}>
            <CtaButton
              testID="onboarding-create-with-email"
              variant="primary"
              label={i18n.t('onboarding.welcome.createWithEmailAction')}
              hasTVPreferredFocus={isTv}
              onPress={onSelectSignUp}
            />
            <CtaButton
              testID="onboarding-back-to-email"
              variant="ghost"
              label={i18n.t('onboarding.welcome.backToEmail')}
              onPress={onResetToEntry}
            />
          </View>
        </View>
      ) : subPhase === 'signin' ? (
        <View style={styles.section}>
          <View style={styles.emailSummaryRow}>
            <Text
              style={[
                theme.typography.caption,
                styles.flex1,
                { color: theme.colors.textSecondary },
              ]}
            >
              {showCreateFallback ? email.trim() : i18n.t('onboarding.welcome.existingAccountHint')}
            </Text>
            <Pressable
              testID="onboarding-back-to-email"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('onboarding.welcome.backToEmail')}
              focusable
              onPress={onResetToEntry}
              style={(state) => [
                styles.linkPad,
                cursorPointer,
                {
                  borderRadius: theme.radius.button,
                  borderWidth: state.focused ? theme.focus.ringWidth : 1,
                  borderColor: state.focused ? theme.colors.focusRingColor : 'transparent',
                  backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                },
              ]}
            >
              <Text style={[theme.typography.caption, { color: theme.colors.accent }]}>
                {i18n.t('onboarding.welcome.backToEmail')}
              </Text>
            </Pressable>
          </View>
          <OnboardingTextField
            testID="onboarding-password-input"
            label={i18n.t('account.passwordLabel')}
            value={password}
            onChangeText={onChangePassword}
            placeholder={i18n.t('account.passwordPlaceholder')}
            secureTextEntry
            autoComplete="password"
            editable={!submitting}
            onSubmitEditing={onSignIn}
          />
          {errorKey !== null ? (
            <Text
              testID="onboarding-welcome-error"
              accessibilityLiveRegion="polite"
              style={[theme.typography.caption, { color: theme.colors.liveColor }]}
            >
              {i18n.t(errorKey)}
            </Text>
          ) : null}
          <View style={styles.inlineRow}>
            <CtaButton
              testID="onboarding-signin-submit"
              variant="primary"
              label={i18n.t('account.signInAction')}
              disabled={submitting}
              hasTVPreferredFocus={isTv}
              onPress={onSignIn}
            />
            {showCreateFallback ? (
              <CtaButton
                testID="onboarding-create-with-email"
                variant="secondary"
                label={i18n.t('onboarding.welcome.createWithEmailAction')}
                disabled={submitting}
                onPress={onSelectSignUp}
              />
            ) : null}
          </View>
        </View>
      ) : (
        <View style={styles.section}>
          <View style={styles.emailSummaryRow}>
            <Text
              style={[
                theme.typography.caption,
                styles.flex1,
                { color: theme.colors.textSecondary },
              ]}
            >
              {email.trim()}
            </Text>
            <Pressable
              testID="onboarding-back-to-email"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('onboarding.welcome.backToEmail')}
              focusable
              onPress={onResetToEntry}
              style={(state) => [
                styles.linkPad,
                cursorPointer,
                {
                  borderRadius: theme.radius.button,
                  borderWidth: state.focused ? theme.focus.ringWidth : 1,
                  borderColor: state.focused ? theme.colors.focusRingColor : 'transparent',
                  backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                },
              ]}
            >
              <Text style={[theme.typography.caption, { color: theme.colors.accent }]}>
                {i18n.t('onboarding.welcome.backToEmail')}
              </Text>
            </Pressable>
          </View>
          <OnboardingTextField
            testID="onboarding-password-input"
            label={i18n.t('account.passwordLabel')}
            value={password}
            onChangeText={onChangePassword}
            placeholder={i18n.t('account.passwordPlaceholder')}
            secureTextEntry
            autoComplete="new-password"
            editable={!submitting}
          />
          <OnboardingTextField
            testID="onboarding-confirm-password-input"
            label={i18n.t('account.confirmPasswordLabel')}
            value={confirmPassword}
            onChangeText={onChangeConfirmPassword}
            placeholder={i18n.t('account.confirmPasswordPlaceholder')}
            secureTextEntry
            autoComplete="new-password"
            editable={!submitting}
            onSubmitEditing={onSignUp}
          />
          {errorKey !== null ? (
            <Text
              testID="onboarding-welcome-error"
              accessibilityLiveRegion="polite"
              style={[theme.typography.caption, { color: theme.colors.liveColor }]}
            >
              {i18n.t(errorKey)}
            </Text>
          ) : null}
          <CtaButton
            testID="onboarding-signup-submit"
            variant="primary"
            label={i18n.t('account.createAccountAction')}
            disabled={submitting}
            hasTVPreferredFocus={isTv}
            onPress={onSignUp}
          />
        </View>
      )}

      {oauthProviders.length > 0 && subPhase === 'entry' ? (
        <View style={styles.inlineRow}>
          {oauthProviders.map((provider) => (
            <CtaButton
              key={provider}
              testID={`onboarding-oauth-${provider}`}
              variant="secondary"
              label={provider === 'google' ? 'Google' : 'Apple'}
              disabled={submitting}
              onPress={() => onOAuth(provider)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  infoCard: { borderWidth: 1, padding: 14, gap: 10 },
  emailSummaryRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex1: { flex: 1 },
  linkPad: { paddingHorizontal: 6, paddingVertical: 4 },
  inlineRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
});
