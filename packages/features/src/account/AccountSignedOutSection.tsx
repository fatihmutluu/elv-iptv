import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  Surface,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { QrScannerPort, SyncAccountPort } from '../ports/wave-f9-ports';
import { AccountBidirectionalPairingPanel } from './AccountBidirectionalPairingPanel';
import { AccountTextField } from './AccountFormParts';
import {
  mapSyncErrorCodeToMessageId,
  validateSignInFields,
  validateSignUpFields,
} from './account-helpers';

type AuthTabId = 'signin' | 'signup' | 'qr';

/** Props of {@link AccountSignedOutSection}. */
export interface AccountSignedOutSectionProps {
  readonly syncAccount: SyncAccountPort;
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly onAuthSucceeded: () => Promise<void>;
  readonly deleteSuccessBanner: boolean;
  readonly qrScanner?: QrScannerPort;
  readonly pendingPairUri?: string | null;
  readonly onPairUriHandled?: () => void;
  readonly qrPollIntervalMs?: number;
}

/** Signed-out Settings card offering Sign In, Create Account, and unified Bidirectional QR + 8-Digit Pairing. */
export function AccountSignedOutSection({
  syncAccount,
  isTv,
  isActiveScope,
  onAuthSucceeded,
  deleteSuccessBanner,
  qrScanner,
  pendingPairUri,
  onPairUriHandled,
  qrPollIntervalMs,
}: AccountSignedOutSectionProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [tab, setTab] = useState<AuthTabId>(() =>
    pendingPairUri && pendingPairUri.trim().length > 0 ? 'qr' : 'signin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageId | null>(null);

  useEffect(() => {
    if (pendingPairUri && pendingPairUri.trim().length > 0) {
      setTab('qr');
    }
  }, [pendingPairUri]);

  const handleSelectTab = useCallback((next: AuthTabId) => {
    setTab(next);
    setErrorKey(null);
  }, []);

  const handleSignIn = useCallback(async () => {
    const errKey = validateSignInFields(email, password);
    if (errKey !== null) {
      setErrorKey(errKey);
      return;
    }
    setErrorKey(null);
    setSubmitting(true);
    try {
      const res = await syncAccount.signIn(email.trim(), password);
      if (res.ok) {
        await onAuthSucceeded();
      } else {
        setErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
      }
    } catch {
      setErrorKey('account.errorGeneric');
    } finally {
      setSubmitting(false);
    }
  }, [email, onAuthSucceeded, password, syncAccount]);

  const handleSignUp = useCallback(async () => {
    const errKey = validateSignUpFields(email, password, confirmPassword);
    if (errKey !== null) {
      setErrorKey(errKey);
      return;
    }
    setErrorKey(null);
    setSubmitting(true);
    try {
      const res = await syncAccount.register(email.trim(), password, confirmPassword);
      if (res.ok) {
        await onAuthSucceeded();
      } else {
        setErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
      }
    } catch {
      setErrorKey('account.errorGeneric');
    } finally {
      setSubmitting(false);
    }
  }, [confirmPassword, email, onAuthSucceeded, password, syncAccount]);

  const cursorPointer = webCursorPointer();
  const tabTransition = webTransition(theme, 'color, border-color, background-color');
  const tabs: readonly { readonly id: AuthTabId; readonly labelKey: MessageId }[] = [
    { id: 'signin', labelKey: 'welcome.tabSignIn' },
    { id: 'signup', labelKey: 'welcome.tabCreateAccount' },
    { id: 'qr', labelKey: 'welcome.tabPairQr' },
  ];

  return (
    <>
      {deleteSuccessBanner ? (
        <Surface
          testID="account-delete-success"
          tone="card"
          bordered
          rounded="card"
          style={styles.bannerCard}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={[theme.typography.body, { color: theme.colors.successColor }]}
          >
            {i18n.t('account.deleteSuccess')}
          </Text>
        </Surface>
      ) : null}

      <Surface
        testID="account-auth-card"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.card}
      >
        <View style={styles.headerBlock}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {i18n.t('account.title')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('account.subtitle')}
          </Text>
          <Text
            testID="account-sync-initial-prefs-hint"
            style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {i18n.t('sync.initialPrefsHint')}
          </Text>
        </View>

        <View
          accessibilityRole="tablist"
          style={[styles.tabRow, { borderBottomColor: theme.colors.surfaceBorder }]}
        >
          {tabs.map((item, idx) => {
            const selected = tab === item.id;
            return (
              <Pressable
                key={item.id}
                testID={`account-tab-${item.id}`}
                accessibilityRole="tab"
                accessibilityLabel={i18n.t(item.labelKey)}
                accessibilityState={{ selected }}
                aria-selected={selected}
                focusable
                hasTVPreferredFocus={isTv && isActiveScope && idx === 0}
                onPress={() => handleSelectTab(item.id)}
                style={(state) => [
                  styles.tabItem,
                  cursorPointer,
                  tabTransition,
                  {
                    borderBottomColor: selected ? theme.colors.accent : 'transparent',
                    backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                    borderRadius: state.focused ? theme.radius.button : 0,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    {
                      color: selected ? theme.colors.textPrimary : theme.colors.textSecondary,
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
          <View style={styles.form}>
            <AccountTextField
              testID="account-email-input"
              label={i18n.t('account.emailLabel')}
              value={email}
              onChangeText={setEmail}
              placeholder={i18n.t('account.emailPlaceholder')}
              keyboardType="email-address"
              autoComplete="email"
              editable={!submitting}
            />
            <AccountTextField
              testID="account-password-input"
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
                testID="account-auth-error"
                accessibilityLiveRegion="polite"
                style={[theme.typography.caption, { color: theme.colors.liveColor }]}
              >
                {i18n.t(errorKey)}
              </Text>
            ) : null}
            <CtaButton
              testID="account-signin-submit"
              variant="primary"
              label={i18n.t('account.signInAction')}
              disabled={submitting}
              onPress={() => {
                void handleSignIn();
              }}
            />
          </View>
        ) : tab === 'signup' ? (
          <View style={styles.form}>
            <AccountTextField
              testID="account-email-input"
              label={i18n.t('account.emailLabel')}
              value={email}
              onChangeText={setEmail}
              placeholder={i18n.t('account.emailPlaceholder')}
              keyboardType="email-address"
              autoComplete="email"
              editable={!submitting}
            />
            <AccountTextField
              testID="account-password-input"
              label={i18n.t('account.passwordLabel')}
              value={password}
              onChangeText={setPassword}
              placeholder={i18n.t('account.passwordPlaceholder')}
              secureTextEntry
              autoComplete="new-password"
              editable={!submitting}
            />
            <AccountTextField
              testID="account-confirm-password-input"
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
                testID="account-auth-error"
                accessibilityLiveRegion="polite"
                style={[theme.typography.caption, { color: theme.colors.liveColor }]}
              >
                {i18n.t(errorKey)}
              </Text>
            ) : null}
            <CtaButton
              testID="account-signup-submit"
              variant="primary"
              label={i18n.t('account.createAccountAction')}
              disabled={submitting}
              onPress={() => {
                void handleSignUp();
              }}
            />
          </View>
        ) : (
          <AccountBidirectionalPairingPanel
            syncAccount={syncAccount}
            active={tab === 'qr'}
            legacyTestIDPrefix="account-qr"
            {...(qrScanner !== undefined ? { qrScanner } : {})}
            {...(pendingPairUri !== undefined ? { pendingPairUri } : {})}
            {...(onPairUriHandled !== undefined ? { onPairUriHandled } : {})}
            {...(qrPollIntervalMs !== undefined ? { pollIntervalMs: qrPollIntervalMs } : {})}
          />
        )}

        <Text
          testID="account-oauth-coming-soon"
          style={[theme.typography.caption, { color: theme.colors.textMuted }]}
        >
          {i18n.t('account.oauthComingSoon')}
        </Text>
      </Surface>
    </>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14 },
  bannerCard: { padding: 14 },
  headerBlock: { gap: 4 },
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
});
