import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type {
  BidirectionalPairingSnapshot,
  SyncAccountPort,
  SyncAccountState,
} from '../../ports/wave-f9-ports';
import { AccountBidirectionalPairingPanel } from '../AccountBidirectionalPairingPanel';
import { WelcomeSyncOverlay } from '../WelcomeSyncOverlay';

function renderPanel(ui: ReactElement, options?: { readonly isTv?: boolean }) {
  const isTv = options?.isTv ?? false;
  return render(
    <TvRemoteProvider>
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
          <ThemeProvider reduceMotion>{ui}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>,
  );
}

function makeSnapshot(
  overrides: Partial<BidirectionalPairingSnapshot> = {},
): BidirectionalPairingSnapshot {
  return {
    pairingId: 'host-1',
    role: 'host',
    code: '12345678',
    qrUri: 'elviptv://pair?c=12345678&pk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    expiresAtMs: Date.now() + 300_000,
    status: 'pending',
    sas: null,
    direction: null,
    localMaskedEmail: 'a***@example.com',
    peerMaskedEmail: null,
    errorCode: null,
    ...overrides,
  };
}

function createMockSyncAccount(
  overrides: Partial<SyncAccountPort> = {},
  stateOverrides: Partial<SyncAccountState> = {},
): SyncAccountPort {
  const state: SyncAccountState = {
    status: 'signed_in',
    email: 'alice@example.com',
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
    autoSyncState: 'idle',
    ...stateOverrides,
  };
  return {
    getState: jest.fn(() => state),
    subscribe: jest.fn(() => () => undefined),
    signIn: jest.fn(async () => ({ ok: true })),
    register: jest.fn(async () => ({ ok: true })),
    acknowledgeRecoveryCode: jest.fn(),
    syncNow: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async () => ({ ok: true })),
    createQrPairing: jest.fn(async () => ({
      pairingId: 'legacy-1',
      code: '12345678',
      qrUri: 'elviptv://pair?c=12345678',
      expiresAtMs: Date.now() + 300_000,
      status: 'pending' as const,
    })),
    pollQrPairing: jest.fn(async () => 'pending' as const),
    claimQrPairing: jest.fn(async () => ({ ok: true })),
    startBidirectionalPairing: jest.fn(async () => makeSnapshot()),
    joinBidirectionalPairing: jest.fn(async () =>
      makeSnapshot({
        pairingId: 'resp-1',
        role: 'responder',
        status: 'awaiting_sas',
        sas: '4829',
        direction: 'responder_to_host',
        localMaskedEmail: 'a***@example.com',
        peerMaskedEmail: null,
      }),
    ),
    pollBidirectionalPairing: jest.fn(async () => makeSnapshot()),
    confirmBidirectionalPairing: jest.fn(async () => ({ ok: true })),
    cancelBidirectionalPairing: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('AccountBidirectionalPairingPanel security, lifecycle & TV focus regressions (P0-1, P1-8, P1-10)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('P0-1: deep-link pendingPairUri runs Phase 1 only (SAS + masked email + Confirm/Cancel) and NEVER auto-confirms', async () => {
    const onHandled = jest.fn();
    const syncAccount = createMockSyncAccount({
      joinBidirectionalPairing: jest.fn(async () =>
        makeSnapshot({
          pairingId: 'dl-resp-1',
          role: 'responder',
          status: 'responder_joined',
          sas: '6194',
          direction: 'host_to_responder',
          localMaskedEmail: null,
          peerMaskedEmail: 'h***@example.com',
        }),
      ),
    });

    const view = await renderPanel(
      <AccountBidirectionalPairingPanel
        syncAccount={syncAccount}
        pendingPairUri="elviptv://pair?c=87654321&pk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        onPairUriHandled={onHandled}
      />,
    );

    await waitFor(() => {
      expect(syncAccount.joinBidirectionalPairing).toHaveBeenCalledWith(
        'elviptv://pair?c=87654321&pk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      expect(onHandled).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('pair-sas-card')).toBeTruthy();
      expect(screen.getByTestId('pair-sas-code')).toHaveTextContent('6194');
      expect(screen.getByTestId('pair-sas-confirm')).toBeTruthy();
      expect(screen.getByTestId('pair-sas-cancel')).toBeTruthy();
    });

    // Zero 1-click auto-transfer: confirmBidirectionalPairing MUST NOT have been called yet
    expect(syncAccount.confirmBidirectionalPairing).not.toHaveBeenCalled();

    // Only explicit Confirm triggers Phase 2
    await fireEvent.press(screen.getByTestId('pair-sas-confirm'));
    await waitFor(() => {
      expect(syncAccount.confirmBidirectionalPairing).toHaveBeenCalledWith(
        'dl-resp-1',
        'host_to_responder',
      );
    });
    await view.unmount();
  });

  it('P1-8: cancels prior active host session on handleJoin and cancels active non-terminal session on unmount', async () => {
    const syncAccount = createMockSyncAccount({
      startBidirectionalPairing: jest.fn(async () =>
        makeSnapshot({ pairingId: 'host-active-1', status: 'pending' }),
      ),
      joinBidirectionalPairing: jest.fn(async () =>
        makeSnapshot({
          pairingId: 'resp-active-2',
          role: 'responder',
          status: 'awaiting_sas',
          sas: '2468',
          direction: 'responder_to_host',
        }),
      ),
    });

    const view = await renderPanel(<AccountBidirectionalPairingPanel syncAccount={syncAccount} />);

    await waitFor(() => {
      expect(screen.getByTestId('pair-host-code')).toHaveTextContent('1234 5678');
    });

    // Joining another code while hosting must cancel the prior host session first
    await fireEvent.changeText(screen.getByTestId('pair-code-input'), '87654321');
    await fireEvent.press(screen.getByTestId('pair-code-submit'));

    await waitFor(() => {
      expect(syncAccount.cancelBidirectionalPairing).toHaveBeenCalledWith('host-active-1');
      expect(screen.getByTestId('pair-sas-code')).toHaveTextContent('2468');
    });

    // Unmounting while responder session is still non-terminal must cancel it cleanly
    await view.unmount();
    expect(syncAccount.cancelBidirectionalPairing).toHaveBeenCalledWith('resp-active-2');
  });

  it('P1-10: keeps pair-case-neither visible and NEVER invokes onPaired or dismisses WelcomeSyncOverlay', async () => {
    const onContinue = jest.fn();
    const syncAccount = createMockSyncAccount(
      {
        startBidirectionalPairing: jest.fn(async () =>
          makeSnapshot({
            pairingId: 'neither-1',
            role: 'host',
            status: 'completed',
            sas: null,
            direction: 'neither_signed_in',
            localMaskedEmail: null,
            peerMaskedEmail: null,
          }),
        ),
      },
      { status: 'signed_out', email: null },
    );

    const view = await renderPanel(
      <WelcomeSyncOverlay
        visible
        syncAccount={syncAccount}
        onContinueWithoutAccount={onContinue}
      />,
    );

    await fireEvent.press(screen.getByTestId('welcome-tab-qr'));
    await waitFor(() => {
      expect(screen.getByTestId('pair-case-neither')).toBeTruthy();
    });
    expect(screen.getByTestId('welcome-sync-overlay')).toBeTruthy();
    expect(onContinue).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('P0-1 & P1-10: renders SAS card for host & responder across awaiting_sas, responder_joined, responder_transferred, and responder approved with hasTVPreferredFocus on TV', async () => {
    const cases: readonly {
      readonly snapshot: BidirectionalPairingSnapshot;
      readonly expectedSas: string;
      readonly expectedPreferredTestId: string;
    }[] = [
      {
        snapshot: makeSnapshot({
          pairingId: 's-joined',
          role: 'host',
          status: 'responder_joined',
          sas: '1122',
          direction: 'host_to_responder',
        }),
        expectedSas: '1122',
        expectedPreferredTestId: 'pair-sas-confirm',
      },
      {
        snapshot: makeSnapshot({
          pairingId: 's-transferred',
          role: 'host',
          status: 'responder_transferred' as BidirectionalPairingSnapshot['status'],
          sas: '3344',
          direction: 'responder_to_host',
          peerMaskedEmail: 'r***@example.com',
        }),
        expectedSas: '3344',
        expectedPreferredTestId: 'pair-sas-confirm',
      },
      {
        snapshot: makeSnapshot({
          pairingId: 's-resp-approved',
          role: 'responder',
          status: 'approved',
          sas: '5566',
          direction: 'host_to_responder',
          peerMaskedEmail: 'h***@example.com',
        }),
        expectedSas: '5566',
        expectedPreferredTestId: 'pair-sas-confirm',
      },
      {
        snapshot: makeSnapshot({
          pairingId: 's-diff',
          role: 'host',
          status: 'awaiting_sas',
          sas: '7788',
          direction: 'different_accounts',
          localMaskedEmail: 'a***@example.com',
          peerMaskedEmail: 'b***@example.com',
        }),
        expectedSas: '7788',
        expectedPreferredTestId: 'pair-choose-this',
      },
    ];

    for (const c of cases) {
      const syncAccount = createMockSyncAccount({
        startBidirectionalPairing: jest.fn(async () => c.snapshot),
      });
      const view = await renderPanel(
        <AccountBidirectionalPairingPanel syncAccount={syncAccount} />,
        {
          isTv: true,
        },
      );
      await waitFor(() => {
        expect(screen.getByTestId('pair-sas-card')).toBeTruthy();
        expect(screen.getByTestId('pair-sas-code')).toHaveTextContent(c.expectedSas);
      });
      expect(screen.getByTestId(c.expectedPreferredTestId).props.hasTVPreferredFocus).toBe(true);
      await view.unmount();
    }

    // Waiting-approval card and terminal expired/locked cards also keep TV focus anchored
    const waitingSync = createMockSyncAccount({
      startBidirectionalPairing: jest.fn(async () =>
        makeSnapshot({
          pairingId: 's-wait',
          role: 'responder',
          status: 'waiting_approval',
          sas: '9900',
          direction: 'host_to_responder',
        }),
      ),
    });
    const waitingView = await renderPanel(
      <AccountBidirectionalPairingPanel syncAccount={waitingSync} />,
      { isTv: true },
    );
    await waitFor(() => {
      expect(screen.getByTestId('pair-waiting-approval')).toBeTruthy();
    });
    expect(screen.getByTestId('pair-sas-cancel').props.hasTVPreferredFocus).toBe(true);
    await waitingView.unmount();

    const expiredSync = createMockSyncAccount({
      startBidirectionalPairing: jest.fn(async () =>
        makeSnapshot({ pairingId: 's-exp', status: 'expired' }),
      ),
    });
    const expiredView = await renderPanel(
      <AccountBidirectionalPairingPanel syncAccount={expiredSync} />,
      { isTv: true },
    );
    await waitFor(() => {
      expect(screen.getByTestId('pair-expired')).toBeTruthy();
    });
    expect(screen.getByTestId('pair-regenerate-btn').props.hasTVPreferredFocus).toBe(true);
    await expiredView.unmount();
  });
});
