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
import { WelcomeSyncOverlay } from '../WelcomeSyncOverlay';

function createMockSyncAccount(overrides: Partial<SyncAccountPort> = {}): SyncAccountPort {
  const state: SyncAccountState = {
    status: 'signed_out',
    email: null,
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
  };
  const session: SyncQrPairingSession = {
    pairingId: 'pair-1',
    code: 'ABCD1234EFGH',
    qrUri: 'elviptv://pair?c=ABCD1234EFGH&k=AAAAAAAAAAAAAAAAAAAAAA',
    expiresAtMs: Date.now() + 300_000,
    status: 'pending',
  };
  return {
    getState: jest.fn(() => state),
    subscribe: jest.fn((_listener) => () => undefined),
    signIn: jest.fn(async (_email, _password) => ({ ok: true })),
    register: jest.fn(async (_email, _password, _confirm) => ({
      ok: true,
      recoveryCode: 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ',
    })),
    acknowledgeRecoveryCode: jest.fn(),
    syncNow: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async (_password) => ({ ok: true })),
    createQrPairing: jest.fn(async () => session),
    pollQrPairing: jest.fn(async (_pairingId) => 'pending' as const),
    claimQrPairing: jest.fn(async (_codeOrUri) => ({ ok: true })),
    ...overrides,
  };
}

function renderWithProviders(
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

describe('WelcomeSyncOverlay', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns null when not visible', async () => {
    const syncAccount = createMockSyncAccount();
    await renderWithProviders(
      <WelcomeSyncOverlay
        visible={false}
        syncAccount={syncAccount}
        onContinueWithoutAccount={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('welcome-sync-overlay')).toBeNull();
  });

  it('shows Continue without account button and dismisses immediately when pressed', async () => {
    const syncAccount = createMockSyncAccount();
    const onContinue = jest.fn();
    await renderWithProviders(
      <WelcomeSyncOverlay
        visible
        syncAccount={syncAccount}
        onContinueWithoutAccount={onContinue}
      />,
    );

    expect(screen.getByTestId('welcome-title')).toHaveTextContent('Sync Across Every Screen');
    expect(screen.getByTestId('welcome-local-only-note')).toHaveTextContent(/100% locally/);

    await fireEvent.press(screen.getByTestId('welcome-continue-without-account'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('validates signup email, min 10-char password, matching confirm password, and shows recovery code', async () => {
    const syncAccount = createMockSyncAccount();
    const onContinue = jest.fn();
    await renderWithProviders(
      <WelcomeSyncOverlay
        visible
        syncAccount={syncAccount}
        onContinueWithoutAccount={onContinue}
      />,
    );

    await fireEvent.press(screen.getByTestId('welcome-tab-signup'));

    // Invalid email
    await fireEvent.changeText(screen.getByTestId('welcome-email-input'), 'not-an-email');
    await fireEvent.changeText(screen.getByTestId('welcome-password-input'), 'longenough123');
    await fireEvent.changeText(
      screen.getByTestId('welcome-confirm-password-input'),
      'longenough123',
    );
    await fireEvent.press(screen.getByTestId('welcome-signup-submit'));
    expect(screen.getByTestId('welcome-error')).toHaveTextContent('Enter a valid email address.');
    expect(syncAccount.register).not.toHaveBeenCalled();

    // Weak password (< 10 chars)
    await fireEvent.changeText(screen.getByTestId('welcome-email-input'), 'viewer@example.com');
    await fireEvent.changeText(screen.getByTestId('welcome-password-input'), 'short9');
    await fireEvent.changeText(screen.getByTestId('welcome-confirm-password-input'), 'short9');
    await fireEvent.press(screen.getByTestId('welcome-signup-submit'));
    expect(screen.getByTestId('welcome-error')).toHaveTextContent(/at least 10 characters/);

    // Mismatched confirm password
    await fireEvent.changeText(screen.getByTestId('welcome-password-input'), 'supersecret123');
    await fireEvent.changeText(
      screen.getByTestId('welcome-confirm-password-input'),
      'different1234',
    );
    await fireEvent.press(screen.getByTestId('welcome-signup-submit'));
    expect(screen.getByTestId('welcome-error')).toHaveTextContent('Passwords do not match.');

    // Valid signup -> shows recovery code confirmation
    await fireEvent.changeText(
      screen.getByTestId('welcome-confirm-password-input'),
      'supersecret123',
    );
    await fireEvent.press(screen.getByTestId('welcome-signup-submit'));

    await waitFor(() => {
      expect(syncAccount.register).toHaveBeenCalledWith(
        'viewer@example.com',
        'supersecret123',
        'supersecret123',
      );
      expect(screen.getByTestId('welcome-recovery-code')).toHaveTextContent(
        'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ',
      );
    });

    await fireEvent.press(screen.getByTestId('welcome-recovery-saved-btn'));
    expect(syncAccount.acknowledgeRecoveryCode).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('renders live QR pairing code, polls until claimed, and cleans up polling on unmount', async () => {
    jest.useFakeTimers();
    let pollCalls = 0;
    const syncAccount = createMockSyncAccount({
      pollQrPairing: jest.fn(async () => {
        pollCalls += 1;
        return pollCalls >= 2 ? 'claimed' : 'pending';
      }),
    });
    const onContinue = jest.fn();

    const view = await renderWithProviders(
      <WelcomeSyncOverlay
        visible
        syncAccount={syncAccount}
        onContinueWithoutAccount={onContinue}
        qrPollIntervalMs={500}
      />,
    );

    await fireEvent.press(screen.getByTestId('welcome-tab-qr'));

    await waitFor(() => {
      expect(syncAccount.createQrPairing).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('welcome-qr-code')).toBeTruthy();
      expect(screen.getByTestId('welcome-qr-short-code')).toHaveTextContent('ABCD1234EFGH');
    });

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(onContinue).toHaveBeenCalledTimes(1);
    });

    await view.unmount();
  });

  it('handles QR expiry and regenerates a fresh session', async () => {
    jest.useFakeTimers();
    const syncAccount = createMockSyncAccount({
      pollQrPairing: jest.fn(async () => 'expired' as const),
    });

    const view = await renderWithProviders(
      <WelcomeSyncOverlay
        visible
        syncAccount={syncAccount}
        onContinueWithoutAccount={jest.fn()}
        qrPollIntervalMs={500}
      />,
    );

    await fireEvent.press(screen.getByTestId('welcome-tab-qr'));
    await waitFor(() => expect(screen.getByTestId('welcome-qr-code')).toBeTruthy());

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(screen.getByTestId('welcome-qr-expired')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('welcome-qr-regenerate-btn'));
    await waitFor(() => {
      expect(syncAccount.createQrPairing).toHaveBeenCalledTimes(2);
    });

    await view.unmount();
  });

  it('traps TV focus without competing preferred-focus anchors and refuses to discard the recovery code on TV Back', async () => {
    const syncAccount = createMockSyncAccount();
    const onContinue = jest.fn();
    const dispatcher = createTvRemoteDispatcher();

    const view = await renderWithProviders(
      <WelcomeSyncOverlay
        visible
        syncAccount={syncAccount}
        onContinueWithoutAccount={onContinue}
      />,
      { isTv: true, dispatcher },
    );

    expect(screen.getByTestId('welcome-sync-focus-guide')).toBeTruthy();
    expect(screen.queryByTestId('welcome-tv-focus-anchor')).toBeNull();
    expect(screen.getByTestId('welcome-continue-without-account').props.hasTVPreferredFocus).toBe(
      true,
    );

    const countPreferredFocus = (tree: unknown): number => {
      if (tree === null || tree === undefined || typeof tree !== 'object') return 0;
      if (Array.isArray(tree)) {
        return tree.reduce((sum, item) => sum + countPreferredFocus(item), 0);
      }
      const node = tree as { props?: { hasTVPreferredFocus?: unknown }; children?: unknown[] };
      const self = node.props?.hasTVPreferredFocus === true ? 1 : 0;
      return self + countPreferredFocus(node.children);
    };

    // Ensure zero competing hasTVPreferredFocus={true} elements in the tree
    expect(countPreferredFocus(view.toJSON())).toBe(1);

    // Complete signup to enter the one-time recovery code screen
    await fireEvent.press(screen.getByTestId('welcome-tab-signup'));
    await fireEvent.changeText(screen.getByTestId('welcome-email-input'), 'tv@example.com');
    await fireEvent.changeText(screen.getByTestId('welcome-password-input'), 'supersecret123');
    await fireEvent.changeText(
      screen.getByTestId('welcome-confirm-password-input'),
      'supersecret123',
    );
    await fireEvent.press(screen.getByTestId('welcome-signup-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('welcome-recovery-banner')).toBeTruthy();
    });
    expect(screen.getByTestId('welcome-recovery-saved-btn').props.hasTVPreferredFocus).toBe(true);
    expect(countPreferredFocus(view.toJSON())).toBe(1);

    // TV Back MUST be consumed without acknowledging or discarding the recovery code
    let consumed = false;
    await act(async () => {
      consumed = dispatcher.dispatch({ key: 'back', action: 'press', time: 100 }, false);
    });
    expect(consumed).toBe(true);
    expect(syncAccount.acknowledgeRecoveryCode).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByTestId('welcome-recovery-banner')).toBeTruthy();

    // Only explicitly pressing the acknowledgment button completes onboarding
    await fireEvent.press(screen.getByTestId('welcome-recovery-saved-btn'));
    expect(syncAccount.acknowledgeRecoveryCode).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('dismisses the welcome overlay on TV Back when not showing a recovery code', async () => {
    const syncAccount = createMockSyncAccount();
    const onContinue = jest.fn();
    const dispatcher = createTvRemoteDispatcher();

    const view = await renderWithProviders(
      <WelcomeSyncOverlay
        visible
        syncAccount={syncAccount}
        onContinueWithoutAccount={onContinue}
      />,
      { isTv: true, dispatcher },
    );

    let consumed = false;
    await act(async () => {
      consumed = dispatcher.dispatch({ key: 'back', action: 'press', time: 50 }, false);
    });
    expect(consumed).toBe(true);
    expect(onContinue).toHaveBeenCalledTimes(1);

    await view.unmount();
  });
});
