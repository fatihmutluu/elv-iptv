import type { MessageId } from '@elv/i18n';
import { CtaButton, MicroPill, Surface, useI18n, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type {
  AutoSyncState,
  QrScannerPort,
  SyncAccountPort,
  SyncAccountState,
} from '../ports/wave-f9-ports';
import { AccountBidirectionalPairingPanel } from './AccountBidirectionalPairingPanel';
import { AccountRecoveryBanner, AccountTextField } from './AccountFormParts';
import { mapSyncErrorCodeToMessageId } from './account-helpers';

/** Props of {@link AccountSignedInSection}. */
export interface AccountSignedInSectionProps {
  readonly syncAccount: SyncAccountPort;
  readonly state: SyncAccountState;
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly onDeleteSuccess: () => void;
  readonly qrScanner?: QrScannerPort;
  readonly pendingPairUri?: string | null;
  readonly onPairUriHandled?: () => void;
  readonly qrPollIntervalMs?: number;
}

function autoSyncStatusMessageKey(autoState: AutoSyncState): MessageId {
  if (autoState === 'syncing') return 'account.sync.statusSyncing';
  if (autoState === 'pending') return 'account.sync.statusPending';
  if (autoState === 'offline') return 'account.sync.statusOffline';
  return 'account.sync.statusUpToDate';
}

/**
 * Signed-in Settings view (`#26`, `#510`):
 * email badge, live automatic background sync indicator, compact secondary "Sync now" fallback,
 * unified bidirectional QR + 8-digit pairing card, Sign Out, and destructive Delete Account flow.
 */
export function AccountSignedInSection({
  syncAccount,
  state,
  isTv,
  isActiveScope,
  onDeleteSuccess,
  qrScanner,
  pendingPairUri,
  onPairUriHandled,
  qrPollIntervalMs,
}: AccountSignedInSectionProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncErrorKey, setSyncErrorKey] = useState<MessageId | null>(null);
  const [deleteExpanded, setDeleteExpanded] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErrorKey, setDeleteErrorKey] = useState<MessageId | null>(null);

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

  const isSyncing = syncBusy || state.status === 'syncing' || state.autoSyncState === 'syncing';
  const effectiveAutoState: AutoSyncState = isSyncing ? 'syncing' : (state.autoSyncState ?? 'idle');
  const hasPendingRecovery = state.pendingRecoveryCode !== null;
  const supportsBidirectional =
    syncAccount.startBidirectionalPairing !== undefined &&
    syncAccount.joinBidirectionalPairing !== undefined;

  return (
    <>
      {hasPendingRecovery ? (
        <AccountRecoveryBanner
          recoveryCode={state.pendingRecoveryCode}
          onAcknowledge={() => syncAccount.acknowledgeRecoveryCode()}
          testIDPrefix="account"
          hasTVPreferredFocus={isTv && isActiveScope}
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
              <MicroPill
                testID="account-auto-sync-badge"
                label={i18n.t('account.sync.autoBadge')}
                tone={effectiveAutoState === 'offline' ? 'neutral' : 'success'}
              />
            </View>
            <Text
              testID="account-sync-status"
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {i18n.t(autoSyncStatusMessageKey(effectiveAutoState))}
            </Text>
            {state.lastSyncedAtIso !== null ? (
              <Text
                testID="account-last-synced"
                style={[theme.typography.caption, { color: theme.colors.textMuted }]}
              >
                {i18n.t('account.sync.lastSynced', { time: state.lastSyncedAtIso })}
              </Text>
            ) : null}
            <Text
              testID="account-sync-initial-prefs-hint"
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {i18n.t('sync.initialPrefsHint')}
            </Text>
          </View>
          <View style={styles.actionsRow}>
            <CtaButton
              testID="account-sync-now-btn"
              variant="secondary"
              label={i18n.t('account.sync.manualFallback')}
              disabled={isSyncing}
              hasTVPreferredFocus={isTv && isActiveScope && !hasPendingRecovery}
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

      {supportsBidirectional ? (
        <Surface
          testID="account-pairing-card"
          tone="surface"
          bordered
          rounded="modal"
          style={styles.card}
        >
          <AccountBidirectionalPairingPanel
            syncAccount={syncAccount}
            {...(qrScanner !== undefined ? { qrScanner } : {})}
            {...(pendingPairUri !== undefined ? { pendingPairUri } : {})}
            {...(onPairUriHandled !== undefined ? { onPairUriHandled } : {})}
            {...(qrPollIntervalMs !== undefined ? { pollIntervalMs: qrPollIntervalMs } : {})}
          />
        </Surface>
      ) : null}

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
            variant="destructive"
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
                variant="destructive"
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
