import type { PreferencesPatch, PreferencesSnapshot } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import {
  Surface,
  TextEntryBoundary,
  TvFocusGuideRegion,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import type { SyncAccountPort } from '../ports/wave-f9-ports';
import { useRouteActive } from '../shared';
import { AccountSignedInSection } from './AccountSignedInSection';
import { AccountSignedOutSection } from './AccountSignedOutSection';
import { useSyncAccountState } from './account-helpers';

/** Structural preferences slice consumed by {@link AccountSettingsPanel}. */
export interface AccountPreferencesSlice {
  readonly preferences: Pick<PreferencesSnapshot, 'syncServerUrl'>;
  readonly updatePreferences: (patch: PreferencesPatch) => unknown;
}

/** Props of {@link AccountSettingsPanel}. */
export interface AccountSettingsPanelProps {
  readonly syncAccount?: SyncAccountPort;
  /** Optional reactive preferences controller for reading/updating `syncServerUrl`. */
  readonly preferences?: AccountPreferencesSlice;
  /** Current custom sync server base URL (overrides `preferences.preferences.syncServerUrl` when set). */
  readonly syncServerUrl?: string;
  /** Invoked with a validated, normalized sync server base URL (or `''` when cleared). */
  readonly onSyncServerUrlChange?: (nextUrl: string) => unknown;
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
  isAtLeftEdge,
  onBack,
  onFocusTopNav,
}: {
  readonly isAtLeftEdge: () => boolean;
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
      if (event.kind === 'press' && event.key === 'left' && isAtLeftEdge()) {
        if (onBack !== undefined) {
          onBack();
          return true;
        }
      }
      return false;
    },
    [isAtLeftEdge, onBack, onFocusTopNav],
  );
  useKeyInterpreter(handleKey);
  return null;
}

/**
 * Cinema Quietude v2 Settings Account & Sync panel (`#26`).
 * Supports E2EE Sign In / Create Account / Universal QR Pairing, custom Sync server URL configuration,
 * Recovery Code acknowledgment, Approve Device Pairing (including queued sign-in-first handoff),
 * Sync Now, Sign Out, and Apple 5.1.1(v) / Google Play permanent account deletion.
 */
export function AccountSettingsPanel({
  syncAccount,
  preferences,
  syncServerUrl,
  onSyncServerUrlChange,
  isActiveScope = true,
  onBack,
  onFocusTopNav,
  qrPollIntervalMs,
}: AccountSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const routeActive = useRouteActive();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const accountState = useSyncAccountState(syncAccount);
  const [pendingClaimCode, setPendingClaimCode] = useState<string | null>(null);
  const pendingClaimRef = useRef<string | null>(null);
  pendingClaimRef.current = pendingClaimCode;
  const [autoClaimStatus, setAutoClaimStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [deleteSuccessBanner, setDeleteSuccessBanner] = useState(false);

  const atLeftEdgeRef = useRef(true);
  useEffect(() => {
    if (isActiveScope) atLeftEdgeRef.current = true;
  }, [isActiveScope]);
  const isAtLeftEdge = useCallback(() => atLeftEdgeRef.current, []);
  const handleLeftEdgeChange = useCallback((atEdge: boolean) => {
    atLeftEdgeRef.current = atEdge;
  }, []);

  const effectiveSyncServerUrl = syncServerUrl ?? preferences?.preferences.syncServerUrl ?? '';
  const handleSyncServerUrlChange = useCallback(
    (nextUrl: string) => {
      if (onSyncServerUrlChange !== undefined) {
        onSyncServerUrlChange(nextUrl);
      } else if (preferences !== undefined) {
        void preferences.updatePreferences({ syncServerUrl: nextUrl });
      }
    },
    [onSyncServerUrlChange, preferences],
  );

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
      <TvFocusGuideRegion
        testID="settings-panel-account-focus-guide"
        enabled={isTv && routeActive}
        autoFocus={isActiveScope}
        style={styles.scroll}
      >
        <ScrollView
          testID="settings-panel-account"
          style={styles.scroll}
          contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
          keyboardShouldPersistTaps="handled"
        >
          {isTv && isActiveScope && (onBack !== undefined || onFocusTopNav !== undefined) ? (
            <AccountPanelTvBridge
              isAtLeftEdge={isAtLeftEdge}
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
              syncServerUrl={effectiveSyncServerUrl}
              onSyncServerUrlChange={handleSyncServerUrlChange}
              onLeftEdgeChange={handleLeftEdgeChange}
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
              syncServerUrl={effectiveSyncServerUrl}
              onSyncServerUrlChange={handleSyncServerUrlChange}
              onLeftEdgeChange={handleLeftEdgeChange}
              {...(qrPollIntervalMs !== undefined ? { qrPollIntervalMs } : {})}
            />
          )}
        </ScrollView>
      </TvFocusGuideRegion>
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  unavailableCard: { padding: 18, gap: 8 },
});
