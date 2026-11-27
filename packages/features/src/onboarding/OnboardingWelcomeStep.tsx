import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  useI18n,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { OAuthProviderId, SyncAccountPort } from '../ports/wave-f9-ports';
import { OnboardingRecoveryCard, OnboardingSwitchRow } from './OnboardingPrimitives';
import { OnboardingWelcomeAuthForm, type WelcomeAuthSubPhase } from './OnboardingWelcomeAuthForm';
import {
  mapOnboardingAuthError,
  validateOnboardingEmail,
  validateOnboardingSignIn,
  validateOnboardingSignUp,
} from './onboarding-model';

type WelcomeSubPhase = WelcomeAuthSubPhase | 'recovery' | 'transfer';

/** Slot props supplied to `renderTransferPanel` when opening Wave P9 QR/8-digit device transfer. */
export interface OnboardingTransferSlotProps {
  readonly active: boolean;
  readonly onPaired: () => void;
}

/** Props of {@link OnboardingWelcomeStep}. */
export interface OnboardingWelcomeStepProps {
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly pendingPairUri?: string | null | undefined;
  readonly renderTransferPanel?:
    | ((slot: OnboardingTransferSlotProps) => ReactElement | null)
    | undefined;
  readonly onOpenPrivacyPolicy: () => void;
  /** Commits KVKK diagnostics & welcome flags ONLY once the user proceeds past Screen 1. */
  readonly onCommitConsent: (diagnosticsOptIn: boolean) => void;
  readonly onProceedExistingAccount: () => void;
  readonly onProceedNewAccount: () => void;
  readonly onProceedGuest: () => void;
  readonly onSubPhaseChange?: ((canGoBack: boolean, goBack: () => void) => void) | undefined;
}

/**
 * Onboarding Screen 1 (`#513`): Smart Email existence check, inline 1-tap Create Account,
 * E2EE Recovery Code acknowledgment, OAuth-ready seam, Bidirectional Device Transfer slot,
 * Guest Mode (`welcome-continue-without-account`), and 2-line KVKK/Diagnostics consent strip.
 */
export function OnboardingWelcomeStep({
  syncAccount,
  pendingPairUri,
  renderTransferPanel,
  onOpenPrivacyPolicy,
  onCommitConsent,
  onProceedExistingAccount,
  onProceedNewAccount,
  onProceedGuest,
  onSubPhaseChange,
}: OnboardingWelcomeStepProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const [subPhase, setSubPhase] = useState<WelcomeSubPhase>(() =>
    pendingPairUri && pendingPairUri.trim().length > 0 && renderTransferPanel !== undefined
      ? 'transfer'
      : 'entry',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCreateFallback, setShowCreateFallback] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageId | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  // Fresh onboarding consent defaults ON locally; persisted ONLY when user proceeds past Screen 1!
  const [diagnosticsOptIn, setDiagnosticsOptIn] = useState(true);
  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reqSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (pendingPairUri && pendingPairUri.trim().length > 0 && renderTransferPanel !== undefined) {
      reqSeqRef.current += 1;
      setSubmitting(false);
      setSubPhase('transfer');
    }
  }, [pendingPairUri, renderTransferPanel]);

  const resetToEntry = useCallback(() => {
    reqSeqRef.current += 1;
    setSubmitting(false);
    setSubPhase('entry');
    setPassword('');
    setConfirmPassword('');
    setErrorKey(null);
    setShowCreateFallback(false);
  }, []);

  useEffect(() => {
    const canGoBack = subPhase !== 'entry' && subPhase !== 'recovery' && subPhase !== 'checking';
    onSubPhaseChange?.(canGoBack, resetToEntry);
  }, [onSubPhaseChange, resetToEntry, subPhase]);

  const handleCheckEmail = useCallback(async () => {
    if (syncAccount === undefined) return;
    const emailErr = validateOnboardingEmail(email);
    if (emailErr !== null) {
      setErrorKey(emailErr);
      return;
    }
    const seq = ++reqSeqRef.current;
    setErrorKey(null);
    setSubPhase('checking');
    const trimmed = email.trim();
    let lookup: 'exists' | 'not_found' | 'unknown' = 'unknown';
    try {
      if (syncAccount.checkEmail !== undefined) {
        lookup = await syncAccount.checkEmail(trimmed);
      }
    } catch {
      lookup = 'unknown';
    }
    if (!mountedRef.current || reqSeqRef.current !== seq) return;
    if (lookup === 'exists') {
      setShowCreateFallback(false);
      setSubPhase('signin');
    } else if (lookup === 'not_found') {
      setSubPhase('not_found');
    } else {
      setShowCreateFallback(true);
      setSubPhase('signin');
    }
  }, [email, syncAccount]);

  const handleSignIn = useCallback(async () => {
    if (syncAccount === undefined) return;
    const validationErr = validateOnboardingSignIn(email, password);
    if (validationErr !== null) {
      setErrorKey(validationErr);
      return;
    }
    const seq = ++reqSeqRef.current;
    setErrorKey(null);
    setSubmitting(true);
    try {
      const res = await syncAccount.signIn(email.trim(), password);
      if (!mountedRef.current || reqSeqRef.current !== seq) return;
      if (res.ok) {
        onCommitConsent(diagnosticsOptIn);
        onProceedExistingAccount();
      } else {
        setShowCreateFallback(true);
        setErrorKey(mapOnboardingAuthError(res.errorCode));
      }
    } catch {
      if (!mountedRef.current || reqSeqRef.current !== seq) return;
      setShowCreateFallback(true);
      setErrorKey('account.errorGeneric');
    } finally {
      if (mountedRef.current && reqSeqRef.current === seq) {
        setSubmitting(false);
      }
    }
  }, [diagnosticsOptIn, email, onCommitConsent, onProceedExistingAccount, password, syncAccount]);

  const handleSignUp = useCallback(async () => {
    if (syncAccount === undefined) return;
    const validationErr = validateOnboardingSignUp(email, password, confirmPassword);
    if (validationErr !== null) {
      setErrorKey(validationErr);
      return;
    }
    const seq = ++reqSeqRef.current;
    setErrorKey(null);
    setSubmitting(true);
    try {
      const res = await syncAccount.register(email.trim(), password, confirmPassword);
      if (!mountedRef.current || reqSeqRef.current !== seq) return;
      if (res.ok) {
        const code = res.recoveryCode ?? syncAccount.getState().pendingRecoveryCode;
        if (code) {
          setRecoveryCode(code);
          setSubPhase('recovery');
        } else {
          onCommitConsent(diagnosticsOptIn);
          onProceedNewAccount();
        }
      } else {
        setErrorKey(mapOnboardingAuthError(res.errorCode));
      }
    } catch {
      if (!mountedRef.current || reqSeqRef.current !== seq) return;
      setErrorKey('account.errorGeneric');
    } finally {
      if (mountedRef.current && reqSeqRef.current === seq) {
        setSubmitting(false);
      }
    }
  }, [
    confirmPassword,
    diagnosticsOptIn,
    email,
    onCommitConsent,
    onProceedNewAccount,
    password,
    syncAccount,
  ]);

  const handleAcknowledgeRecovery = useCallback(() => {
    syncAccount?.acknowledgeRecoveryCode();
    setRecoveryCode(null);
    onCommitConsent(diagnosticsOptIn);
    onProceedNewAccount();
  }, [diagnosticsOptIn, onCommitConsent, onProceedNewAccount, syncAccount]);

  const handleOAuth = useCallback(
    async (provider: OAuthProviderId) => {
      if (syncAccount?.signInWithOAuth === undefined) return;
      const seq = ++reqSeqRef.current;
      setErrorKey(null);
      setSubmitting(true);
      try {
        const res = await syncAccount.signInWithOAuth(provider);
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        if (res.ok) {
          onCommitConsent(diagnosticsOptIn);
          onProceedExistingAccount();
        } else {
          setErrorKey(mapOnboardingAuthError(res.errorCode));
        }
      } catch {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setErrorKey('account.errorGeneric');
      } finally {
        if (mountedRef.current && reqSeqRef.current === seq) {
          setSubmitting(false);
        }
      }
    },
    [diagnosticsOptIn, onCommitConsent, onProceedExistingAccount, syncAccount],
  );

  const authBusy = subPhase === 'checking' || submitting;

  const handleGuest = useCallback(() => {
    if (authBusy) return;
    reqSeqRef.current += 1;
    onCommitConsent(diagnosticsOptIn);
    onProceedGuest();
  }, [authBusy, diagnosticsOptIn, onCommitConsent, onProceedGuest]);

  const handleTransferPaired = useCallback(() => {
    reqSeqRef.current += 1;
    onCommitConsent(diagnosticsOptIn);
    onProceedExistingAccount();
  }, [diagnosticsOptIn, onCommitConsent, onProceedExistingAccount]);

  const oauthProviders = syncAccount?.supportedOAuthProviders ?? [];
  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color');

  return (
    <View testID="welcome-sync-overlay" style={styles.root}>
      <View testID="onboarding-welcome-step" style={styles.step}>
        <View style={styles.header}>
          <Text
            testID="onboarding-welcome-title"
            accessibilityRole="header"
            style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('onboarding.welcome.title')}
          </Text>
          <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
            {i18n.t('onboarding.welcome.subtitle')}
          </Text>
        </View>

        {subPhase === 'recovery' && recoveryCode !== null ? (
          <OnboardingRecoveryCard
            recoveryCode={recoveryCode}
            isTv={isTv}
            onAcknowledge={handleAcknowledgeRecovery}
          />
        ) : subPhase === 'transfer' && renderTransferPanel !== undefined ? (
          <View style={styles.section}>
            {renderTransferPanel({ active: true, onPaired: handleTransferPaired })}
            <CtaButton
              testID="onboarding-transfer-back"
              variant="ghost"
              label={i18n.t('onboarding.welcome.backToEmail')}
              onPress={resetToEntry}
            />
          </View>
        ) : (
          <>
            {syncAccount !== undefined ? (
              <OnboardingWelcomeAuthForm
                subPhase={subPhase === 'recovery' || subPhase === 'transfer' ? 'entry' : subPhase}
                isTv={isTv}
                email={email}
                password={password}
                confirmPassword={confirmPassword}
                showCreateFallback={showCreateFallback}
                submitting={submitting}
                errorKey={errorKey}
                oauthProviders={oauthProviders}
                onChangeEmail={(next) => {
                  setEmail(next);
                  if (errorKey !== null) setErrorKey(null);
                }}
                onChangePassword={setPassword}
                onChangeConfirmPassword={setConfirmPassword}
                onCheckEmail={() => {
                  void handleCheckEmail();
                }}
                onSignIn={() => {
                  void handleSignIn();
                }}
                onSignUp={() => {
                  void handleSignUp();
                }}
                onSelectSignUp={() => {
                  setErrorKey(null);
                  setSubPhase('signup');
                }}
                onResetToEntry={resetToEntry}
                onOAuth={(provider) => {
                  void handleOAuth(provider);
                }}
              />
            ) : null}

            <View style={[styles.actionsDivider, { borderTopColor: theme.colors.surfaceBorder }]}>
              <View style={styles.inlineRow}>
                {syncAccount !== undefined && renderTransferPanel !== undefined ? (
                  <CtaButton
                    testID="onboarding-transfer-btn"
                    variant="secondary"
                    label={i18n.t('onboarding.welcome.transferAction')}
                    disabled={authBusy}
                    onPress={() => {
                      if (authBusy) return;
                      reqSeqRef.current += 1;
                      setErrorKey(null);
                      setSubPhase('transfer');
                    }}
                  />
                ) : null}
                <CtaButton
                  testID="welcome-continue-without-account"
                  variant={syncAccount === undefined ? 'primary' : 'secondary'}
                  label={i18n.t('onboarding.welcome.guestAction')}
                  disabled={authBusy}
                  hasTVPreferredFocus={isTv && subPhase === 'entry'}
                  onPress={handleGuest}
                />
              </View>
            </View>

            <View
              testID="welcome-privacy-consent-strip"
              style={[
                styles.privacyStrip,
                {
                  borderColor: theme.colors.surfaceBorder,
                  backgroundColor: theme.colors.bgCard,
                  borderRadius: theme.radius.card,
                },
              ]}
            >
              <View style={styles.privacyLine}>
                <Text style={[theme.typography.micro, { color: theme.colors.textSecondary }]}>
                  {i18n.t('onboarding.welcome.privacyStripPrefix')}
                </Text>
                <Pressable
                  testID="onboarding-privacy-policy-link"
                  accessibilityRole="link"
                  accessibilityLabel={i18n.t('onboarding.welcome.privacyPolicyLink')}
                  focusable
                  onPress={onOpenPrivacyPolicy}
                  style={(state) => [
                    styles.policyLinkBtn,
                    cursorPointer,
                    transition,
                    {
                      borderRadius: theme.radius.button,
                      backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[
                      theme.typography.micro,
                      styles.underline,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {i18n.t('onboarding.welcome.privacyPolicyLink')}
                  </Text>
                </Pressable>
              </View>

              <OnboardingSwitchRow
                testID="privacy-consent-telemetry-toggle"
                title={i18n.t('onboarding.welcome.diagnosticsLabel')}
                checked={diagnosticsOptIn}
                compact
                onToggle={() => setDiagnosticsOptIn((prev) => !prev)}
              />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  step: { width: '100%', gap: 16 },
  header: { gap: 6 },
  section: { gap: 12 },
  inlineRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  actionsDivider: { paddingTop: 14, borderTopWidth: 1, gap: 10 },
  privacyStrip: { borderWidth: 1, padding: 10, gap: 6 },
  privacyLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  policyLinkBtn: { paddingHorizontal: 4, paddingVertical: 2 },
  underline: { textDecorationLine: 'underline' },
});
