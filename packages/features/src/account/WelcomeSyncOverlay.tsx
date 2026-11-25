import type { KeyEvent } from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  TextEntryBoundary,
  TvFocusGuideRegion,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SyncAccountPort } from '../ports/wave-f9-ports';
import { AccountQrPairingView, AccountRecoveryBanner, AccountTextField } from './AccountFormParts';
import {
  mapSyncErrorCodeToMessageId,
  useSyncQrPairing,
  validateSignInFields,
  validateSignUpFields,
} from './account-helpers';

type WelcomeTabId = 'signin' | 'signup' | 'qr';

/** Props of {@link WelcomeSyncOverlay}. */
export interface WelcomeSyncOverlayProps {
  readonly visible: boolean;
  readonly syncAccount: SyncAccountPort;
  /** Dismisses the first-run welcome overlay and enters the full local app (`welcomeDismissed = true`). */
  readonly onContinueWithoutAccount: () => void;
  /** Optional polling interval override (ms) for deterministic unit tests. */
  readonly qrPollIntervalMs?: number;
}

function WelcomeTvKeyBridge({ onBack }: { readonly onBack: (() => void) | undefined }): null {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onBack?.();
        return true;
      }
      return false;
    },
    [onBack],
  );
  useKeyInterpreter(handleKey);
  return null;
}

/**
 * First-run Cinema Quietude v2 E2EE Sync Welcome overlay (`#26`).
 * Renders in-tree (never RN `<Modal>`) with calm obsidian glass framing, Sign In / Create Account /
 * Pair via QR tabs, recovery code acknowledgment, and a prominent "Continue without account" escape.
 */
export function WelcomeSyncOverlay({
  visible,
  syncAccount,
  onContinueWithoutAccount,
  qrPollIntervalMs,
}: WelcomeSyncOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const [tab, setTab] = useState<WelcomeTabId>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageId | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const pairing = useSyncQrPairing(
    syncAccount,
    visible && tab === 'qr' && recoveryCode === null,
    onContinueWithoutAccount,
    qrPollIntervalMs,
  );

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return undefined;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape' && recoveryCode === null) {
        e.preventDefault?.();
        onContinueWithoutAccount();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [onContinueWithoutAccount, recoveryCode, visible]);

  const handleSelectTab = useCallback((next: WelcomeTabId) => {
    setTab(next);
    setErrorKey(null);
  }, []);

  const handleSignIn = useCallback(async () => {
    const validationErr = validateSignInFields(email, password);
    if (validationErr !== null) {
      setErrorKey(validationErr);
      return;
    }
    setErrorKey(null);
    setSubmitting(true);
    try {
      const res = await syncAccount.signIn(email.trim(), password);
      if (res.ok) {
        onContinueWithoutAccount();
      } else {
        setErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
      }
    } catch {
      setErrorKey('account.errorGeneric');
    } finally {
      setSubmitting(false);
    }
  }, [email, onContinueWithoutAccount, password, syncAccount]);

  const handleSignUp = useCallback(async () => {
    const validationErr = validateSignUpFields(email, password, confirmPassword);
    if (validationErr !== null) {
      setErrorKey(validationErr);
      return;
    }
    setErrorKey(null);
    setSubmitting(true);
    try {
      const res = await syncAccount.register(email.trim(), password, confirmPassword);
      if (res.ok) {
        const code = res.recoveryCode ?? syncAccount.getState().pendingRecoveryCode;
        if (code) {
          setRecoveryCode(code);
        } else {
          onContinueWithoutAccount();
        }
      } else {
        setErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
      }
    } catch {
      setErrorKey('account.errorGeneric');
    } finally {
      setSubmitting(false);
    }
  }, [confirmPassword, email, onContinueWithoutAccount, password, syncAccount]);

  const handleAcknowledgeRecovery = useCallback(() => {
    syncAccount.acknowledgeRecoveryCode();
    setRecoveryCode(null);
    onContinueWithoutAccount();
  }, [onContinueWithoutAccount, syncAccount]);

  if (!visible) return null;

  const cursorPointer = webCursorPointer();
  const tabTransition = webTransition(theme, 'color, border-color, background-color');

  const tabs: readonly { readonly id: WelcomeTabId; readonly labelKey: MessageId }[] = [
    { id: 'signin', labelKey: 'welcome.tabSignIn' },
    { id: 'signup', labelKey: 'welcome.tabCreateAccount' },
    { id: 'qr', labelKey: 'welcome.tabPairQr' },
  ];

  return (
    <TextEntryBoundary>
      <TvFocusGuideRegion
        testID="welcome-sync-focus-guide"
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
        <View testID="welcome-sync-overlay" style={styles.overlayCenter}>
          {isTv ? (
            <WelcomeTvKeyBridge
              onBack={recoveryCode === null ? onContinueWithoutAccount : undefined}
            />
          ) : null}

          <View
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
              style={styles.scroll}
              contentContainerStyle={[styles.scrollContent, { gap: theme.spacing.md }]}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.header}>
                <Text
                  testID="welcome-title"
                  accessibilityRole="header"
                  style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
                >
                  {i18n.t('welcome.title')}
                </Text>
                <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                  {i18n.t('welcome.subtitle')}
                </Text>
              </View>

              {recoveryCode !== null ? (
                <AccountRecoveryBanner
                  recoveryCode={recoveryCode}
                  onAcknowledge={handleAcknowledgeRecovery}
                  testIDPrefix="welcome"
                  hasTVPreferredFocus={isTv}
                />
              ) : (
                <>
                  <View
                    testID="welcome-tabs"
                    accessibilityRole="tablist"
                    style={[styles.tabRow, { borderBottomColor: theme.colors.surfaceBorder }]}
                  >
                    {tabs.map((item) => {
                      const selected = tab === item.id;
                      return (
                        <Pressable
                          key={item.id}
                          testID={`welcome-tab-${item.id}`}
                          accessibilityRole="tab"
                          accessibilityLabel={i18n.t(item.labelKey)}
                          accessibilityState={{ selected }}
                          aria-selected={selected}
                          focusable
                          onPress={() => handleSelectTab(item.id)}
                          style={(state) => [
                            styles.tabItem,
                            cursorPointer,
                            tabTransition,
                            {
                              borderBottomColor: selected ? theme.colors.accent : 'transparent',
                              backgroundColor: state.focused
                                ? theme.colors.focusFill
                                : 'transparent',
                              borderRadius: state.focused ? theme.radius.button : 0,
                            },
                          ]}
                        >
                          <Text
                            numberOfLines={1}
                            style={[
                              theme.typography.title,
                              {
                                color: selected
                                  ? theme.colors.textPrimary
                                  : theme.colors.textSecondary,
                                fontWeight: selected ? '700' : '500',
                              },
                            ]}
                          >
                            {i18n.t(item.labelKey)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  {tab === 'signin' ? (
                    <View testID="welcome-signin-form" style={styles.form}>
                      <AccountTextField
                        testID="welcome-email-input"
                        label={i18n.t('account.emailLabel')}
                        value={email}
                        onChangeText={setEmail}
                        placeholder={i18n.t('account.emailPlaceholder')}
                        keyboardType="email-address"
                        autoComplete="email"
                        editable={!submitting}
                      />
                      <AccountTextField
                        testID="welcome-password-input"
                        label={i18n.t('account.passwordLabel')}
                        value={password}
                        onChangeText={setPassword}
                        placeholder={i18n.t('account.passwordPlaceholder')}
                        secureTextEntry
                        autoComplete="password"
                        editable={!submitting}
                      />
                      {errorKey !== null ? (
                        <Text
                          testID="welcome-error"
                          accessibilityLiveRegion="polite"
                          style={[theme.typography.caption, { color: theme.colors.liveColor }]}
                        >
                          {i18n.t(errorKey)}
                        </Text>
                      ) : null}
                      <CtaButton
                        testID="welcome-signin-submit"
                        variant="primary"
                        label={i18n.t('account.signInAction')}
                        disabled={submitting}
                        onPress={() => {
                          void handleSignIn();
                        }}
                      />
                    </View>
                  ) : tab === 'signup' ? (
                    <View testID="welcome-signup-form" style={styles.form}>
                      <AccountTextField
                        testID="welcome-email-input"
                        label={i18n.t('account.emailLabel')}
                        value={email}
                        onChangeText={setEmail}
                        placeholder={i18n.t('account.emailPlaceholder')}
                        keyboardType="email-address"
                        autoComplete="email"
                        editable={!submitting}
                      />
                      <AccountTextField
                        testID="welcome-password-input"
                        label={i18n.t('account.passwordLabel')}
                        value={password}
                        onChangeText={setPassword}
                        placeholder={i18n.t('account.passwordPlaceholder')}
                        secureTextEntry
                        autoComplete="new-password"
                        editable={!submitting}
                      />
                      <AccountTextField
                        testID="welcome-confirm-password-input"
                        label={i18n.t('account.confirmPasswordLabel')}
                        value={confirmPassword}
                        onChangeText={setConfirmPassword}
                        placeholder={i18n.t('account.confirmPasswordPlaceholder')}
                        secureTextEntry
                        autoComplete="new-password"
                        editable={!submitting}
                      />
                      {errorKey !== null ? (
                        <Text
                          testID="welcome-error"
                          accessibilityLiveRegion="polite"
                          style={[theme.typography.caption, { color: theme.colors.liveColor }]}
                        >
                          {i18n.t(errorKey)}
                        </Text>
                      ) : null}
                      <CtaButton
                        testID="welcome-signup-submit"
                        variant="primary"
                        label={i18n.t('account.createAccountAction')}
                        disabled={submitting}
                        onPress={() => {
                          void handleSignUp();
                        }}
                      />
                    </View>
                  ) : (
                    <View testID="welcome-qr-pane" style={styles.form}>
                      <AccountQrPairingView
                        pairing={pairing}
                        size={180}
                        testIDPrefix="welcome-qr"
                      />
                    </View>
                  )}

                  <View style={[styles.footer, { borderTopColor: theme.colors.surfaceBorder }]}>
                    <CtaButton
                      testID="welcome-continue-without-account"
                      variant="secondary"
                      label={i18n.t('welcome.continueWithoutAccount')}
                      hasTVPreferredFocus={isTv}
                      onPress={onContinueWithoutAccount}
                    />
                    <Text
                      testID="welcome-local-only-note"
                      style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                    >
                      {i18n.t('welcome.localOnlyNote')}
                    </Text>
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </TvFocusGuideRegion>
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayCenter: {
    width: '100%',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '92%',
    borderWidth: 1,
    overflow: 'hidden',
  },
  scroll: { flexGrow: 0 },
  scrollContent: { padding: 24 },
  header: { gap: 6 },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    borderBottomWidth: 1,
  },
  tabItem: {
    minHeight: 40,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    justifyContent: 'center',
  },
  form: { gap: 12 },
  footer: {
    marginTop: 4,
    paddingTop: 14,
    borderTopWidth: 1,
    gap: 8,
  },
});
