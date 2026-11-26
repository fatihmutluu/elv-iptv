import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  Surface,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SyncAccountPort } from '../ports/wave-f9-ports';
import { AccountQrPairingView, AccountServerUrlField, AccountTextField } from './AccountFormParts';
import {
  mapSyncErrorCodeToMessageId,
  useSyncQrPairing,
  validateSignInFields,
  validateSignUpFields,
} from './account-helpers';

type AuthTabId = 'signin' | 'signup' | 'qr';

/** Props of {@link AccountSignedOutSection}. */
export interface AccountSignedOutSectionProps {
  readonly syncAccount: SyncAccountPort;
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly pendingClaimCode: string | null;
  readonly onQueuePendingClaim: (codeOrUri: string) => void;
  readonly onAuthSucceeded: () => Promise<void>;
  readonly deleteSuccessBanner: boolean;
  readonly syncServerUrl: string;
  readonly onSyncServerUrlChange?: (nextUrl: string) => void;
  readonly qrPollIntervalMs?: number;
}

/** Signed-out Settings card offering Sign In, Create Account, Pair via QR, custom Sync server URL, and queued QR claim. */
export function AccountSignedOutSection({
  syncAccount,
  isTv,
  isActiveScope,
  pendingClaimCode,
  onQueuePendingClaim,
  onAuthSucceeded,
  deleteSuccessBanner,
  syncServerUrl,
  onSyncServerUrlChange,
  qrPollIntervalMs,
}: AccountSignedOutSectionProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [tab, setTab] = useState<AuthTabId>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [claimInput, setClaimInput] = useState(pendingClaimCode ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageId | null>(null);
  const [serverUrlValid, setServerUrlValid] = useState(true);

  const pairing = useSyncQrPairing(syncAccount, tab === 'qr', undefined, qrPollIntervalMs);

  const handleSelectTab = useCallback((next: AuthTabId) => {
    setTab(next);
    setErrorKey(null);
  }, []);

  const handleSignIn = useCallback(async () => {
    if (!serverUrlValid) {
      setErrorKey('source.validation.invalidAddress');
      return;
    }
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
  }, [email, onAuthSucceeded, password, serverUrlValid, syncAccount]);

  const handleSignUp = useCallback(async () => {
    if (!serverUrlValid) {
      setErrorKey('source.validation.invalidAddress');
      return;
    }
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
  }, [confirmPassword, email, onAuthSucceeded, password, serverUrlValid, syncAccount]);

  const handleQueueClaim = useCallback(() => {
    const trimmed = claimInput.trim();
    if (trimmed.length === 0) return;
    onQueuePendingClaim(trimmed);
  }, [claimInput, onQueuePendingClaim]);

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
          <AccountQrPairingView pairing={pairing} size={180} testIDPrefix="account-qr" />
        )}

        <AccountServerUrlField
          value={syncServerUrl}
          {...(onSyncServerUrlChange !== undefined
            ? { onChangeValidUrl: onSyncServerUrlChange }
            : {})}
          onValidityChange={setServerUrlValid}
          editable={!submitting}
        />

        <Text
          testID="account-oauth-coming-soon"
          style={[theme.typography.caption, { color: theme.colors.textMuted }]}
        >
          {i18n.t('account.oauthComingSoon')}
        </Text>
      </Surface>

      <Surface
        testID="account-claim-card"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.card}
      >
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
          {i18n.t('account.qrClaimTitle')}
        </Text>
        <AccountTextField
          testID="account-claim-input"
          label={i18n.t('account.qrClaimInputLabel')}
          value={claimInput}
          onChangeText={setClaimInput}
          placeholder="elviptv://pair?..."
        />
        {pendingClaimCode !== null ? (
          <Text
            testID="account-claim-signin-first"
            accessibilityLiveRegion="polite"
            style={[theme.typography.caption, { color: theme.colors.accent }]}
          >
            {i18n.t('account.qrClaimSignInFirst')}
          </Text>
        ) : null}
        <CtaButton
          testID="account-claim-submit"
          variant="secondary"
          label={i18n.t('account.qrClaimAction')}
          disabled={claimInput.trim().length === 0}
          onPress={handleQueueClaim}
        />
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
