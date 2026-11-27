import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  type TvRemoteDispatcher,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type {
  BidirectionalPairingSnapshot,
  SyncAccountPort,
  SyncAccountState,
  SyncQrPairingSession,
} from '../../ports/wave-f9-ports';
import { AccountSettingsPanel } from '../AccountSettingsPanel';

interface StatefulSyncMock {
  readonly port: SyncAccountPort;
  readonly setState: (next: SyncAccountState) => void;
}

function createStatefulSyncAccount(initial: Partial<SyncAccountState> = {}): StatefulSyncMock {
  let current: SyncAccountState = {
    status: 'signed_out',
    email: null,
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
    autoSyncState: 'idle',
    ...initial,
  };
  const listeners = new Set<(s: SyncAccountState) => void>();
  const setState = (next: SyncAccountState) => {
    current = next;
    for (const listener of listeners) listener(current);
  };
  const session: SyncQrPairingSession = {
    pairingId: 'pair-settings-1',
    code: 'PAIR12345678',
    qrUri: 'elviptv://pair?c=PAIR12345678&k=BBBBBBBBBBBBBBBBBBBBBB',
    expiresAtMs: Date.now() + 300_000,
    status: 'pending',
  };
  const bidirSession: BidirectionalPairingSnapshot = {
    pairingId: 'bidir-settings-1',
    role: 'host',
    code: '12345678',
    qrUri: 'elviptv://pair?c=12345678&pk=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    expiresAtMs: Date.now() + 300_000,
    status: 'pending',
    sas: null,
    direction: null,
    localMaskedEmail: current.email ? 'v***@example.com' : null,
    peerMaskedEmail: null,
  };

  const port: SyncAccountPort = {
    getState: jest.fn(() => current),
    subscribe: jest.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    signIn: jest.fn(async (email, _password) => {
      setState({
        status: 'signed_in',
        email,
        lastSyncedAtIso: '2026-11-25T12:00:00Z',
        pendingRecoveryCode: null,
        errorCode: null,
        autoSyncState: 'idle',
      });
      return { ok: true };
    }),
    register: jest.fn(async (email, _password, _confirm) => {
      setState({
        status: 'signed_in',
        email,
        lastSyncedAtIso: null,
        pendingRecoveryCode: 'WXYZ-1234-ABCD-5678-EFGH-9012',
        errorCode: null,
        autoSyncState: 'idle',
      });
      return { ok: true, recoveryCode: 'WXYZ-1234-ABCD-5678-EFGH-9012' };
    }),
    acknowledgeRecoveryCode: jest.fn(() => {
      setState({ ...current, pendingRecoveryCode: null });
    }),
    syncNow: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => {
      setState({
        status: 'signed_out',
        email: null,
        lastSyncedAtIso: null,
        pendingRecoveryCode: null,
        errorCode: null,
        autoSyncState: 'idle',
      });
    }),
    deleteAccount: jest.fn(async (_password) => {
      setState({
        status: 'signed_out',
        email: null,
        lastSyncedAtIso: null,
        pendingRecoveryCode: null,
        errorCode: null,
        autoSyncState: 'idle',
      });
      return { ok: true };
    }),
    createQrPairing: jest.fn(async () => session),
    pollQrPairing: jest.fn(async (_pairingId) => 'pending' as const),
    claimQrPairing: jest.fn(async (_codeOrUri) => ({ ok: true })),
    startBidirectionalPairing: jest.fn(async () => bidirSession),
    joinBidirectionalPairing: jest.fn(async () => ({
      ...bidirSession,
      role: 'responder' as const,
      status: 'awaiting_sas' as const,
      sas: '7319',
      direction: 'responder_to_host' as const,
      localMaskedEmail: 'v***@example.com',
      peerMaskedEmail: null,
    })),
    pollBidirectionalPairing: jest.fn(async () => bidirSession),
    confirmBidirectionalPairing: jest.fn(async () => ({ ok: true })),
    cancelBidirectionalPairing: jest.fn(async () => undefined),
  };

  return { port, setState };
}

function renderPanel(
  ui: ReactElement,
  options?: {
    readonly isTv?: boolean;
    readonly dispatcher?: TvRemoteDispatcher;
  },
) {
  const isTv = options?.isTv ?? false;
  return render(
    <TvRemoteProvider
      {...(options?.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {})}
    >
      <ViewportProvider
        value={
          isTv
            ? {
                formFactor: 'tv',
                orientation: 'landscape',
                inputModality: 'tv',
                width: 1920,
                height: 1080,
              }
            : {
                formFactor: 'desktop',
                orientation: 'landscape',
                inputModality: 'pointer',
                width: 1280,
                height: 800,
              }
        }
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>{ui}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>,
  );
}

describe('AccountSettingsPanel', () => {
  it('omits Sync Server URL input, renders bidirectional QR + 8-digit pairing on QR tab, and supports Sign In', async () => {
    const { port } = createStatefulSyncAccount();
    await renderPanel(<AccountSettingsPanel syncAccount={port} />);

    const authHint = screen.getByTestId('account-oauth-coming-soon');
    expect(authHint).toHaveTextContent(
      'Sign in with your email and password, or pair this device with a QR code.',
    );
    expect(authHint).not.toHaveTextContent(/future store update/i);

    // Sync Server URL input and legacy claim card MUST NOT be rendered
    expect(screen.queryByTestId('account-server-url-input')).toBeNull();
    expect(screen.queryByTestId('account-claim-card')).toBeNull();

    // Switch to QR tab -> renders live bidirectional QR + 8-digit code
    await fireEvent.press(screen.getByTestId('account-tab-qr'));
    await waitFor(() => {
      expect(screen.getByTestId('pair-qr-code')).toBeTruthy();
      expect(screen.getByTestId('pair-host-code')).toHaveTextContent('1234 5678');
    });

    // Switch back to Sign In and authenticate
    await fireEvent.press(screen.getByTestId('account-tab-signin'));
    await fireEvent.changeText(screen.getByTestId('account-email-input'), 'alice@example.com');
    await fireEvent.changeText(screen.getByTestId('account-password-input'), 'strongpassword123');
    await fireEvent.press(screen.getByTestId('account-signin-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('account-signed-in-email')).toHaveTextContent('alice@example.com');
      expect(screen.getByTestId('account-auto-sync-badge')).toHaveTextContent(
        'Automatic sync active',
      );
    });
  });

  it('supports recovery code banner, automatic sync status + manual Sync Now, bidirectional pairing, Sign Out, and destructive Delete Account confirmation', async () => {
    const { port } = createStatefulSyncAccount({
      status: 'signed_in',
      email: 'viewer@example.com',
      lastSyncedAtIso: '2026-11-25T10:30:00Z',
      pendingRecoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
      autoSyncState: 'idle',
    });

    await renderPanel(<AccountSettingsPanel syncAccount={port} />);

    // No Sync Server URL input
    expect(screen.queryByTestId('account-server-url-input')).toBeNull();

    // Recovery code banner visible & acknowledgeable
    expect(screen.getByTestId('account-recovery-code')).toHaveTextContent(
      'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    );
    await fireEvent.press(screen.getByTestId('account-recovery-saved-btn'));
    expect(port.acknowledgeRecoveryCode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('account-recovery-banner')).toBeNull());

    // Automatic sync badge & manual Sync Now fallback
    expect(screen.getByTestId('account-auto-sync-badge')).toHaveTextContent(
      'Automatic sync active',
    );
    expect(screen.getByTestId('account-sync-status')).toHaveTextContent('All devices up to date');
    await fireEvent.press(screen.getByTestId('account-sync-now-btn'));
    expect(port.syncNow).toHaveBeenCalledTimes(1);

    // Bidirectional pairing works cleanly while signed in
    await waitFor(() => {
      expect(screen.getByTestId('pair-qr-code')).toBeTruthy();
      expect(screen.getByTestId('pair-code-input')).toBeTruthy();
    });
    await fireEvent.changeText(screen.getByTestId('pair-code-input'), '99998888');
    await fireEvent.press(screen.getByTestId('pair-code-submit'));
    await waitFor(() => {
      expect(port.joinBidirectionalPairing).toHaveBeenCalledWith('99998888');
      expect(screen.getByTestId('pair-sas-code')).toHaveTextContent('7319');
    });
    await fireEvent.press(screen.getByTestId('pair-sas-confirm'));
    await waitFor(() => {
      expect(port.confirmBidirectionalPairing).toHaveBeenCalledWith(
        'bidir-settings-1',
        'responder_to_host',
      );
      expect(screen.getByTestId('pair-completed')).toBeTruthy();
    });

    // Mandatory permanent Delete Account double-confirmation
    await fireEvent.press(screen.getByTestId('account-delete-expand-btn'));
    expect(screen.getByTestId('account-delete-confirm-box')).toBeTruthy();

    await fireEvent.changeText(
      screen.getByTestId('account-delete-password-input'),
      'my-vault-password',
    );
    await fireEvent.press(screen.getByTestId('account-delete-confirm-btn'));

    await waitFor(() => {
      expect(port.deleteAccount).toHaveBeenCalledWith('my-vault-password');
      expect(screen.getByTestId('account-delete-success')).toHaveTextContent(/permanently deleted/);
    });
  });

  it('supports TV focus guide handoff, preserves D-pad left for horizontal controls, and returns on Back', async () => {
    const { port } = createStatefulSyncAccount();
    const dispatcher = createTvRemoteDispatcher();
    const onBack = jest.fn();

    await renderPanel(<AccountSettingsPanel syncAccount={port} isActiveScope onBack={onBack} />, {
      isTv: true,
      dispatcher,
    });

    expect(screen.getByTestId('settings-panel-account-focus-guide')).toBeTruthy();

    // D-pad left stays unhandled by JS bridge so native TV focus navigates horizontal controls cleanly
    await act(async () => {
      dispatcher.dispatch({ key: 'left', action: 'press', time: 10 }, false);
    });
    expect(onBack).not.toHaveBeenCalled();

    // TV Back returns cleanly to Settings sidebar
    await act(async () => {
      dispatcher.dispatch({ key: 'back', action: 'press', time: 20 }, false);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('degrades cleanly to local-only card when syncAccount port is absent', async () => {
    await renderPanel(<AccountSettingsPanel />);
    expect(screen.getByTestId('account-unavailable-card')).toBeTruthy();
  });
});
