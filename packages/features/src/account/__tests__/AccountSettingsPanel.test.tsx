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
      });
    }),
    deleteAccount: jest.fn(async (_password) => {
      setState({
        status: 'signed_out',
        email: null,
        lastSyncedAtIso: null,
        pendingRecoveryCode: null,
        errorCode: null,
      });
      return { ok: true };
    }),
    createQrPairing: jest.fn(async () => session),
    pollQrPairing: jest.fn(async (_pairingId) => 'pending' as const),
    claimQrPairing: jest.fn(async (_codeOrUri) => ({ ok: true })),
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
  it('shows neutral auth guidance copy, validates optional sync server URL, renders live QR pairing, and auto-completes queued pairing code after sign in', async () => {
    const { port } = createStatefulSyncAccount();
    const onSyncServerUrlChange = jest.fn();
    await renderPanel(
      <AccountSettingsPanel
        syncAccount={port}
        syncServerUrl=""
        onSyncServerUrlChange={onSyncServerUrlChange}
      />,
    );

    const authHint = screen.getByTestId('account-oauth-coming-soon');
    expect(authHint).toHaveTextContent(
      'Sign in with your email and password, or pair this device with a QR code.',
    );
    expect(authHint).not.toHaveTextContent(/future store update/i);

    // Optional sync server URL input validates via isValidSyncServerUrl and normalizes valid URLs
    const serverInput = screen.getByTestId('account-server-url-input');
    await fireEvent.changeText(serverInput, 'http://insecure.example.com');
    expect(screen.getByTestId('account-server-url-error')).toHaveTextContent(
      'The server or URL address is not valid.',
    );
    expect(onSyncServerUrlChange).not.toHaveBeenCalled();

    await fireEvent.changeText(serverInput, 'https://sync.example.com/');
    expect(screen.queryByTestId('account-server-url-error')).toBeNull();
    expect(onSyncServerUrlChange).toHaveBeenCalledWith('https://sync.example.com');

    await fireEvent.changeText(serverInput, 'http://127.0.0.1:8787');
    expect(onSyncServerUrlChange).toHaveBeenLastCalledWith('http://127.0.0.1:8787');

    // Try claiming a pairing code while signed out -> prompts sign-in first
    await fireEvent.changeText(
      screen.getByTestId('account-claim-input'),
      'elviptv://pair?c=TV1234567890&k=CCCCCCCCCCCCCCCCCCCCCC',
    );
    await fireEvent.press(screen.getByTestId('account-claim-submit'));
    expect(screen.getByTestId('account-claim-signin-first')).toHaveTextContent(
      /Sign in or create an account first/,
    );
    expect(port.claimQrPairing).not.toHaveBeenCalled();

    // Switch to QR tab -> renders live QR code
    await fireEvent.press(screen.getByTestId('account-tab-qr'));
    await waitFor(() => {
      expect(screen.getByTestId('account-qr-code')).toBeTruthy();
    });

    // Switch back to Sign In and authenticate -> auto-claims queued pairing URI
    await fireEvent.press(screen.getByTestId('account-tab-signin'));
    await fireEvent.changeText(screen.getByTestId('account-email-input'), 'alice@example.com');
    await fireEvent.changeText(screen.getByTestId('account-password-input'), 'strongpassword123');
    await fireEvent.press(screen.getByTestId('account-signin-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('account-signed-in-email')).toHaveTextContent('alice@example.com');
      expect(port.claimQrPairing).toHaveBeenCalledWith(
        'elviptv://pair?c=TV1234567890&k=CCCCCCCCCCCCCCCCCCCCCC',
      );
      expect(screen.getByTestId('account-claim-success')).toHaveTextContent(
        'Device paired securely.',
      );
    });
  });

  it('supports recovery code banner, Sync Now, Approve Device Pairing (without inverted Show Pairing QR card), Sign Out, and permanent Delete Account confirmation', async () => {
    const { port } = createStatefulSyncAccount({
      status: 'signed_in',
      email: 'viewer@example.com',
      lastSyncedAtIso: '2026-11-25T10:30:00Z',
      pendingRecoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    });

    await renderPanel(
      <AccountSettingsPanel syncAccount={port} syncServerUrl="https://sync.example.com" />,
    );

    // Inverted QR generator card MUST NOT be rendered when signed in
    expect(screen.queryByTestId('account-qr-card')).toBeNull();
    expect(screen.queryByTestId('account-show-qr-btn')).toBeNull();
    expect(port.createQrPairing).not.toHaveBeenCalled();

    // Recovery code banner visible & acknowledgeable
    expect(screen.getByTestId('account-recovery-code')).toHaveTextContent(
      'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    );
    await fireEvent.press(screen.getByTestId('account-recovery-saved-btn'));
    expect(port.acknowledgeRecoveryCode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('account-recovery-banner')).toBeNull());

    // Sync Now
    await fireEvent.press(screen.getByTestId('account-sync-now-btn'));
    expect(port.syncNow).toHaveBeenCalledTimes(1);

    // Approve Device Pairing works cleanly while signed in
    await fireEvent.changeText(
      screen.getByTestId('account-claim-input'),
      'elviptv://pair?c=TV9999888877&k=DDDDDDDDDDDDDDDDDDDDDD',
    );
    await fireEvent.press(screen.getByTestId('account-claim-submit'));
    await waitFor(() => {
      expect(port.claimQrPairing).toHaveBeenCalledWith(
        'elviptv://pair?c=TV9999888877&k=DDDDDDDDDDDDDDDDDDDDDD',
      );
      expect(screen.getByTestId('account-claim-success')).toHaveTextContent(
        'Device paired securely.',
      );
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
