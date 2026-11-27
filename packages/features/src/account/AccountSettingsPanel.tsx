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
import { type ReactElement, useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import type { QrScannerPort, SyncAccountPort } from '../ports/wave-f9-ports';
import { useRouteActive } from '../shared';
import { AccountSignedInSection } from './AccountSignedInSection';
import { AccountSignedOutSection } from './AccountSignedOutSection';
import { useSyncAccountState } from './account-helpers';

/** Props of {@link AccountSettingsPanel}. */
export interface AccountSettingsPanelProps {
  readonly syncAccount?: SyncAccountPort;
  /** Optional native camera QR scanner port for bidirectional pairing (`#510`). */
  readonly qrScanner?: QrScannerPort;
  /** Optional incoming `elviptv://pair?...` or Universal Link pairing URI (`#510`). */
  readonly pendingPairUri?: string | null;
  /** Invoked once `pendingPairUri` has been consumed. */
  readonly onPairUriHandled?: () => void;
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
 * Cinema Quietude v2 Settings Account & Sync panel (`#26`, `#510`).
 * Supports E2EE Sign In / Create Account / Bidirectional X25519 QR & 8-Digit Pairing,
 * automatic background sync status, Recovery Code acknowledgment, Sign Out,
 * and Apple 5.1.1(v) / Google Play permanent account deletion.
 */
export function AccountSettingsPanel({
  syncAccount,
  qrScanner,
  pendingPairUri,
  onPairUriHandled,
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
  const [deleteSuccessBanner, setDeleteSuccessBanner] = useState(false);

  const handleAuthSucceeded = useCallback(async () => {
    setDeleteSuccessBanner(false);
  }, []);

  const handleDeleteSuccess = useCallback(() => {
    setDeleteSuccessBanner(true);
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
              onDeleteSuccess={handleDeleteSuccess}
              {...(qrScanner !== undefined ? { qrScanner } : {})}
              {...(pendingPairUri !== undefined ? { pendingPairUri } : {})}
              {...(onPairUriHandled !== undefined ? { onPairUriHandled } : {})}
              {...(qrPollIntervalMs !== undefined ? { qrPollIntervalMs } : {})}
            />
          ) : (
            <AccountSignedOutSection
              syncAccount={syncAccount}
              isTv={isTv}
              isActiveScope={isActiveScope}
              onAuthSucceeded={handleAuthSucceeded}
              deleteSuccessBanner={deleteSuccessBanner}
              {...(qrScanner !== undefined ? { qrScanner } : {})}
              {...(pendingPairUri !== undefined ? { pendingPairUri } : {})}
              {...(onPairUriHandled !== undefined ? { onPairUriHandled } : {})}
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
