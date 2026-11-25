import type { KeyEvent } from '@elv/focus-core';
import {
  Surface,
  TextEntryBoundary,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import type { SyncAccountPort } from '../ports/wave-f9-ports';
import { AccountSignedInSection } from './AccountSignedInSection';
import { AccountSignedOutSection } from './AccountSignedOutSection';
import { useSyncAccountState } from './account-helpers';

/** Props of {@link AccountSettingsPanel}. */
export interface AccountSettingsPanelProps {
  readonly syncAccount?: SyncAccountPort;
  /** Whether this Settings detail pane currently owns 10-foot TV remote focus. */
  readonly isActiveScope?: boolean;
  /** Returns TV focus from this panel back to the Settings sidebar. */
  readonly onBack?: () => void;
  /** Routes TV focus directly to the top navigation bar. */
  readonly onFocusTopNav?: () => void;
  /** Optional polling interval override (ms) for deterministic unit tests. */
  readonly qrPollIntervalMs?: number;
}

function AccountPanelTvBridge({
  onBack,
  onFocusTopNav,
}: {
  readonly onBack?: () => void;
  readonly onFocusTopNav?: () => void;
}): null {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        if (onBack !== undefined) {
          onBack();
          return true;
        }
        if (onFocusTopNav !== undefined) {
          onFocusTopNav();
          return true;
        }
      }
      return false;
    },
    [onBack, onFocusTopNav],
  );
  useKeyInterpreter(handleKey);
  return null;
}

/**
 * Cinema Quietude v2 Settings Account & Sync panel (`#26`).
 * Supports E2EE Sign In / Create Account / Universal QR Pairing, Recovery Code acknowledgment,
 * Approve Device Pairing (including queued sign-in-first handoff), Sync Now, Sign Out, and
 * Apple 5.1.1(v) / Google Play permanent account deletion.
 */
export function AccountSettingsPanel({
  syncAccount,
  isActiveScope = true,
  onBack,
  onFocusTopNav,
  qrPollIntervalMs,
}: AccountSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const accountState = useSyncAccountState(syncAccount);
  const [pendingClaimCode, setPendingClaimCode] = useState<string | null>(null);
  const pendingClaimRef = useRef<string | null>(null);
  pendingClaimRef.current = pendingClaimCode;
  const [autoClaimStatus, setAutoClaimStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [deleteSuccessBanner, setDeleteSuccessBanner] = useState(false);

  const handleQueuePendingClaim = useCallback((codeOrUri: string) => {
    setPendingClaimCode(codeOrUri);
    setAutoClaimStatus('idle');
  }, []);

  const handleAuthSucceeded = useCallback(async () => {
    setDeleteSuccessBanner(false);
    const queued = pendingClaimRef.current;
    if (!queued || !syncAccount) return;
    setPendingClaimCode(null);
    try {
      const res = await syncAccount.claimQrPairing(queued);
      setAutoClaimStatus(res.ok ? 'success' : 'error');
    } catch {
      setAutoClaimStatus('error');
    }
  }, [syncAccount]);

  const handleDeleteSuccess = useCallback(() => {
    setDeleteSuccessBanner(true);
    setAutoClaimStatus('idle');
  }, []);

  const isSignedIn = accountState.status === 'signed_in' || accountState.status === 'syncing';

  return (
    <TextEntryBoundary>
      <ScrollView
        testID="settings-panel-account"
        style={styles.scroll}
        contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
        keyboardShouldPersistTaps="handled"
      >
        {isTv && isActiveScope && (onBack !== undefined || onFocusTopNav !== undefined) ? (
          <AccountPanelTvBridge
            {...(onBack !== undefined ? { onBack } : {})}
            {...(onFocusTopNav !== undefined ? { onFocusTopNav } : {})}
          />
        ) : null}

        {syncAccount === undefined ? (
          <Surface
            testID="account-unavailable-card"
            tone="surface"
            bordered
            rounded="modal"
            style={styles.unavailableCard}
          >
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('account.title')}
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              {i18n.t('welcome.localOnlyNote')}
            </Text>
          </Surface>
        ) : isSignedIn ? (
          <AccountSignedInSection
            syncAccount={syncAccount}
            state={accountState}
            isTv={isTv}
            isActiveScope={isActiveScope}
            autoClaimStatus={autoClaimStatus}
            onDeleteSuccess={handleDeleteSuccess}
            {...(qrPollIntervalMs !== undefined ? { qrPollIntervalMs } : {})}
          />
        ) : (
          <AccountSignedOutSection
            syncAccount={syncAccount}
            isTv={isTv}
            isActiveScope={isActiveScope}
            pendingClaimCode={pendingClaimCode}
            onQueuePendingClaim={handleQueuePendingClaim}
            onAuthSucceeded={handleAuthSucceeded}
            deleteSuccessBanner={deleteSuccessBanner}
            {...(qrPollIntervalMs !== undefined ? { qrPollIntervalMs } : {})}
          />
        )}
      </ScrollView>
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  unavailableCard: { padding: 18, gap: 8 },
});
