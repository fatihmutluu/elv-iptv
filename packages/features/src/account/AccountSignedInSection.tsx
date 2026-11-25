import type { MessageId } from '@elv/i18n';
import { CtaButton, MicroPill, Surface, useI18n, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SyncAccountPort, SyncAccountState } from '../ports/wave-f9-ports';
import { AccountQrPairingView, AccountRecoveryBanner, AccountTextField } from './AccountFormParts';
import { mapSyncErrorCodeToMessageId, useSyncQrPairing } from './account-helpers';

/** Props of {@link AccountSignedInSection}. */
export interface AccountSignedInSectionProps {
  readonly syncAccount: SyncAccountPort;
  readonly state: SyncAccountState;
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly autoClaimStatus: 'idle' | 'success' | 'error';
  readonly onDeleteSuccess: () => void;
  readonly qrPollIntervalMs?: number;
}

/** Signed-in Settings view: email badge, Sync Now, Pairing QR, Approve Device, Sign Out & Delete Account. */
export function AccountSignedInSection({
  syncAccount,
  state,
  isTv,
  isActiveScope,
  autoClaimStatus,
  onDeleteSuccess,
  qrPollIntervalMs,
}: AccountSignedInSectionProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncErrorKey, setSyncErrorKey] = useState<MessageId | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [claimInput, setClaimInput] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimStatus, setClaimStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [claimErrorKey, setClaimErrorKey] = useState<MessageId | null>(null);
  const [deleteExpanded, setDeleteExpanded] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErrorKey, setDeleteErrorKey] = useState<MessageId | null>(null);

  const pairing = useSyncQrPairing(syncAccount, showQr, undefined, qrPollIntervalMs);

  const handleSyncNow = useCallback(async () => {
    setSyncErrorKey(null);
    setSyncBusy(true);
    try {
      const res = await syncAccount.syncNow();
      if (!res.ok) setSyncErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
    } catch {
      setSyncErrorKey('account.errorGeneric');
    } finally {
      setSyncBusy(false);
    }
  }, [syncAccount]);

  const handleClaimSubmit = useCallback(async () => {
    const trimmed = claimInput.trim();
    if (trimmed.length === 0) return;
    setClaimBusy(true);
    setClaimStatus('idle');
    setClaimErrorKey(null);
    try {
      const res = await syncAccount.claimQrPairing(trimmed);
      if (res.ok) {
        setClaimStatus('success');
        setClaimInput('');
      } else {
        setClaimStatus('error');
        setClaimErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
      }
    } catch {
      setClaimStatus('error');
      setClaimErrorKey('account.errorGeneric');
    } finally {
      setClaimBusy(false);
    }
  }, [claimInput, syncAccount]);

  const handleConfirmDelete = useCallback(async () => {
    if (deletePassword.length === 0) {
      setDeleteErrorKey('account.errorWeakPassword');
      return;
    }
    setDeleteBusy(true);
    setDeleteErrorKey(null);
    try {
      const res = await syncAccount.deleteAccount(deletePassword);
      if (res.ok) {
        setDeletePassword('');
        setDeleteExpanded(false);
        onDeleteSuccess();
      } else {
        setDeleteErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
      }
    } catch {
      setDeleteErrorKey('account.errorGeneric');
    } finally {
      setDeleteBusy(false);
    }
  }, [deletePassword, onDeleteSuccess, syncAccount]);

  const isSyncing = syncBusy || state.status === 'syncing';
  const effectiveClaimSuccess = claimStatus === 'success' || autoClaimStatus === 'success';

  return (
    <>
      {state.pendingRecoveryCode !== null ? (
        <AccountRecoveryBanner
          recoveryCode={state.pendingRecoveryCode}
          onAcknowledge={() => syncAccount.acknowledgeRecoveryCode()}
          testIDPrefix="account"
        />
      ) : null}

      <Surface
        testID="account-status-card"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.card}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('account.title')}
            </Text>
            <View style={styles.badgeRow}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('account.signedInAs')}
              </Text>
              <MicroPill testID="account-signed-in-email" label={state.email ?? ''} tone="accent" />
            </View>
            <Text
              testID="account-sync-status"
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {isSyncing
                ? i18n.t('account.syncingStatus')
                : state.lastSyncedAtIso !== null
                  ? `${i18n.t('account.syncedStatus')} · ${state.lastSyncedAtIso}`
                  : i18n.t('account.syncedStatus')}
            </Text>
          </View>
          <View style={styles.actionsRow}>
            <CtaButton
              testID="account-sync-now-btn"
              variant="primary"
              label={i18n.t('account.syncNowAction')}
              disabled={isSyncing}
              hasTVPreferredFocus={isTv && isActiveScope}
              onPress={() => {
                void handleSyncNow();
              }}
            />
            <CtaButton
              testID="account-signout-btn"
              variant="secondary"
              label={i18n.t('account.signOutAction')}
              onPress={() => {
                void syncAccount.signOut();
              }}
            />
          </View>
        </View>

        {syncErrorKey !== null ? (
          <Text
            testID="account-sync-error"
            accessibilityLiveRegion="polite"
            style={[theme.typography.caption, { color: theme.colors.liveColor }]}
          >
            {i18n.t(syncErrorKey)}
          </Text>
        ) : null}
      </Surface>

      <Surface testID="account-qr-card" tone="surface" bordered rounded="modal" style={styles.card}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('account.qrTitle')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('account.qrBody')}
            </Text>
          </View>
          <CtaButton
            testID="account-show-qr-btn"
            variant="secondary"
            label={i18n.t('account.qrGenerateAction')}
            onPress={() => setShowQr((prev) => !prev)}
          />
        </View>
        {showQr ? (
          <AccountQrPairingView pairing={pairing} size={180} testIDPrefix="account-qr" />
        ) : null}
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
          editable={!claimBusy}
        />
        {effectiveClaimSuccess ? (
          <Text
            testID="account-claim-success"
            accessibilityLiveRegion="polite"
            style={[theme.typography.caption, { color: theme.colors.successColor }]}
          >
            {i18n.t('account.qrClaimSuccess')}
          </Text>
        ) : null}
        {claimStatus === 'error' || autoClaimStatus === 'error' ? (
          <Text
            testID="account-claim-error"
            accessibilityLiveRegion="polite"
            style={[theme.typography.caption, { color: theme.colors.liveColor }]}
          >
            {i18n.t(claimErrorKey ?? 'account.errorGeneric')}
          </Text>
        ) : null}
        <CtaButton
          testID="account-claim-submit"
          variant="secondary"
          label={i18n.t('account.qrClaimAction')}
          disabled={claimBusy || claimInput.trim().length === 0}
          onPress={() => {
            void handleClaimSubmit();
          }}
        />
      </Surface>

      <Surface
        testID="account-delete-section"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.card}
      >
        <Text style={[theme.typography.title, { color: theme.colors.liveColor }]}>
          {i18n.t('account.deleteTitle')}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('account.deleteBody')}
        </Text>

        {!deleteExpanded ? (
          <CtaButton
            testID="account-delete-expand-btn"
            variant="secondary"
            label={i18n.t('account.deleteAction')}
            onPress={() => {
              setDeleteErrorKey(null);
              setDeleteExpanded(true);
            }}
          />
        ) : (
          <View
            testID="account-delete-confirm-box"
            style={[
              styles.deleteConfirmBox,
              {
                borderColor: theme.colors.liveColor,
                backgroundColor: theme.colors.bgCard,
                borderRadius: theme.radius.card,
              },
            ]}
          >
            <AccountTextField
              testID="account-delete-password-input"
              label={i18n.t('account.passwordLabel')}
              value={deletePassword}
              onChangeText={setDeletePassword}
              placeholder={i18n.t('account.passwordPlaceholder')}
              secureTextEntry
              autoComplete="password"
              editable={!deleteBusy}
            />
            {deleteErrorKey !== null ? (
              <Text
                testID="account-delete-error"
                accessibilityLiveRegion="polite"
                style={[theme.typography.caption, { color: theme.colors.liveColor }]}
              >
                {i18n.t(deleteErrorKey)}
              </Text>
            ) : null}
            <View style={styles.actionsRow}>
              <CtaButton
                testID="account-delete-cancel-btn"
                variant="secondary"
                label={i18n.t('account.deleteCancelAction')}
                disabled={deleteBusy}
                onPress={() => {
                  setDeleteExpanded(false);
                  setDeletePassword('');
                  setDeleteErrorKey(null);
                }}
              />
              <CtaButton
                testID="account-delete-confirm-btn"
                variant="primary"
                label={i18n.t('account.deleteConfirmAction')}
                disabled={deleteBusy || deletePassword.length === 0}
                onPress={() => {
                  void handleConfirmDelete();
                }}
              />
            </View>
          </View>
        )}
      </Surface>
    </>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14 },
  headerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: { flex: 1, minWidth: 200, gap: 6 },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  deleteConfirmBox: {
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
});
