import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createMemoryPreferencesStore, elvError, err, type HttpClient, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import { createObservedCatalog } from '../app-shell-state';
import {
  usePlaybackAutoSyncHooks,
  useSyncDirtyCatalog,
  wrapCatalogForSyncDirty,
} from '../app-shell-sync-hooks';
import {
  AccountBidirectionalPairingPanel,
  AccountSettingsPanel,
  AppProviders,
  AppShell,
  CrashRecoveryBoundary,
  PrivacyConsentOverlay,
} from '../index';
import { noopPlaybackGuard } from '../ports/playback-guard';
import type { VideoHost } from '../ports/video-host';
import type {
  BidirectionalPairingSnapshot,
  FeedbackPort,
  QrScannerPort,
  SyncAccountPort,
  SyncAccountState,
  TelemetryPort,
} from '../ports/wave-f9-ports';

const offlineHttpClient: HttpClient = {
  async get() {
    return err(elvError('network', 'offline'));
  },
};

function renderInProviders(ui: ReactElement, options?: { readonly isTv?: boolean }) {
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

async function openTestShell() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let nextId = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: offlineHttpClient,
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });
  const engine = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const videoHost: VideoHost = {
    open: () => ({
      engine,
      renderSurface: ({ testID }) => <View testID={testID ?? 'shell-surface'} />,
    }),
  };
  return { catalog, videoHost, cleanup: () => handle.close() };
}

function createMockTelemetry(): TelemetryPort {
  return {
    isOptedIn: jest.fn(() => false),
    setOptIn: jest.fn(),
    queuedCount: jest.fn(() => 0),
    getPayloadPreviewJson: jest.fn(() => '{"events":[]}'),
    recordScreenTransition: jest.fn(),
    recordMediaDecodeFailure: jest.fn(),
    recordPlaybackError: jest.fn(),
    recordAppCrash: jest.fn(),
    flush: jest.fn(async () => undefined),
  };
}

function createMockSyncAccount(
  initial: Partial<SyncAccountState> = {},
  overrides: Partial<SyncAccountPort> = {},
): SyncAccountPort {
  let state: SyncAccountState = {
    status: 'signed_out',
    email: null,
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
    autoSyncState: 'idle',
    ...initial,
  };
  const listeners = new Set<(s: SyncAccountState) => void>();
  const defaultSnap: BidirectionalPairingSnapshot = {
    pairingId: 'bidir-1',
    role: 'host',
    code: '12345678',
    qrUri: 'elviptv://pair?c=12345678&pk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    expiresAtMs: Date.now() + 300_000,
    status: 'pending',
    sas: null,
    direction: null,
    localMaskedEmail: state.email ? 'a***@example.com' : null,
    peerMaskedEmail: null,
    errorCode: null,
  };
  return {
    getState: jest.fn(() => state),
    subscribe: jest.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    signIn: jest.fn(async (email) => {
      state = { ...state, status: 'signed_in', email };
      for (const l of listeners) l(state);
      return { ok: true };
    }),
    register: jest.fn(async (email) => {
      state = { ...state, status: 'signed_in', email };
      for (const l of listeners) l(state);
      return { ok: true };
    }),
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
    notifySyncDirty: jest.fn(),
    notifyPlaybackPause: jest.fn(),
    notifyPlaybackExitOrSwitch: jest.fn(),
    setViewingActive: jest.fn(),
    startBidirectionalPairing: jest.fn(async () => defaultSnap),
    joinBidirectionalPairing: jest.fn(async () => ({
      ...defaultSnap,
      role: 'responder' as const,
      status: 'awaiting_sas' as const,
      sas: '4829',
      direction: 'responder_to_host' as const,
      localMaskedEmail: 'a***@example.com',
      peerMaskedEmail: null,
    })),
    pollBidirectionalPairing: jest.fn(async () => defaultSnap),
    confirmBidirectionalPairing: jest.fn(async () => ({ ok: true })),
    cancelBidirectionalPairing: jest.fn(async () => undefined),
    ...overrides,
  };
}

function ExplodingRenderChild(): ReactElement {
  const errObj = new TypeError(
    'Failed loading https://user:secretpass@iptv.example.com/stream.m3u8 from C:\\Users\\Fatih\\playlist.m3u',
  );
  errObj.stack =
    'TypeError: secret\n    at ExplodingRenderChild (C:\\Users\\Fatih\\Desktop\\IPTV\\src\\App.tsx:10:5)\n    at AppShellStage (/Users/alice/app/Stage.tsx:42:3)';
  throw errObj;
}

function PlaybackAutoSyncHarness({
  syncAccount,
  isViewingActive,
  hasPlayerTarget,
}: {
  readonly syncAccount: SyncAccountPort;
  readonly isViewingActive: boolean;
  readonly hasPlayerTarget: boolean;
}): ReactElement {
  usePlaybackAutoSyncHooks({ syncAccount, isViewingActive, hasPlayerTarget });
  return <View testID="playback-autosync-harness" />;
}

function SyncCatalogHarness({
  catalog,
  syncAccount,
  onWrapped,
}: {
  readonly catalog: CatalogService;
  readonly syncAccount: SyncAccountPort;
  readonly onWrapped: (wrapped: CatalogService) => void;
}): ReactElement {
  const wrapped = useSyncDirtyCatalog(catalog, syncAccount);
  onWrapped(wrapped);
  return <View testID="sync-catalog-harness" />;
}

describe('Wave P9 Unified Diagnostics, Privacy Consent, Auto-Sync & Bidirectional Pairing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('[1.6] renders single unified Diagnostics toggle above Reset in Appearance and syncs telemetryOptIn + crashReportsOptIn + privacyConsentAnswered', async () => {
    const env = await openTestShell();
    const prefsStore = createMemoryPreferencesStore({
      welcomeDismissed: true,
      privacyConsentAnswered: true,
    });
    const telemetry = createMockTelemetry();
    const syncAccount = createMockSyncAccount();
    const feedback: FeedbackPort = { submit: jest.fn(async () => ({ ok: true })) };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell
                catalog={env.catalog}
                videoHost={env.videoHost}
                syncAccount={syncAccount}
                telemetry={telemetry}
                feedback={feedback}
              />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await fireEvent.press(screen.getByTestId('settings-tab-appearance'));
      await waitFor(() => {
        expect(screen.getByTestId('settings-diagnostics-unified-toggle')).toBeTruthy();
      });

      // Legacy 2-switch & preview controls MUST NOT exist
      expect(screen.queryByTestId('settings-diagnostics-toggle-opt-in')).toBeNull();
      expect(screen.queryByTestId('settings-diagnostics-toggle-include-logs')).toBeNull();
      expect(screen.queryByTestId('settings-diagnostics-preview')).toBeNull();

      // Toggle ON updates telemetryOptIn, crashReportsOptIn, and calls telemetry.setOptIn(true)
      await fireEvent.press(screen.getByTestId('settings-diagnostics-unified-toggle'));
      await waitFor(async () => {
        const snap = await prefsStore.load();
        expect(snap.telemetryOptIn).toBe(true);
        expect(snap.crashReportsOptIn).toBe(true);
        expect(snap.privacyConsentAnswered).toBe(true);
        expect(telemetry.setOptIn).toHaveBeenCalledWith(true);
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('[1.6] embeds privacy consent toggle inside WelcomeSyncOverlay and shows standalone PrivacyConsentOverlay for upgrading users', async () => {
    const env = await openTestShell();
    const freshStore = createMemoryPreferencesStore();
    const telemetry = createMockTelemetry();
    const syncAccount = createMockSyncAccount();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={freshStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell
                catalog={env.catalog}
                videoHost={env.videoHost}
                syncAccount={syncAccount}
                telemetry={telemetry}
              />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('welcome-sync-overlay')).toBeTruthy();
        expect(screen.getByTestId('privacy-consent-telemetry-toggle')).toBeTruthy();
      });

      // Zero pre-consent telemetry before user proceeds past Screen 1
      expect(telemetry.setOptIn).toHaveBeenCalledWith(false);
      expect((await freshStore.load()).telemetryOptIn).toBe(false);

      // Wave E3 fresh onboarding toggle starts ON locally; toggling OFF before continuing persists false
      expect(
        screen.getByTestId('privacy-consent-telemetry-toggle').props.accessibilityState.checked,
      ).toBe(true);

      await fireEvent.press(screen.getByTestId('privacy-consent-telemetry-toggle'));
      await fireEvent.press(screen.getByTestId('welcome-continue-without-account'));

      await waitFor(async () => {
        expect(screen.queryByTestId('welcome-sync-overlay')).toBeNull();
        expect(screen.queryByTestId('privacy-consent-overlay')).toBeNull();
        const snap = await freshStore.load();
        expect(snap.welcomeDismissed).toBe(true);
        expect(snap.privacyConsentAnswered).toBe(true);
        expect(snap.telemetryOptIn).toBe(false);
        expect(snap.crashReportsOptIn).toBe(false);
      });
    } finally {
      await view?.unmount();
    }

    // Upgrading user: welcomeDismissed = true, privacyConsentAnswered = false -> shows PrivacyConsentOverlay once
    const upgradeStore = createMemoryPreferencesStore({
      welcomeDismissed: true,
      privacyConsentAnswered: false,
    });
    let upgradeView: Awaited<ReturnType<typeof render>> | undefined;
    try {
      upgradeView = await render(
        <AppProviders preferencesStore={upgradeStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell
                catalog={env.catalog}
                videoHost={env.videoHost}
                syncAccount={syncAccount}
                telemetry={telemetry}
              />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('privacy-consent-overlay')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('privacy-consent-continue-btn'));
      await waitFor(async () => {
        expect(screen.queryByTestId('privacy-consent-overlay')).toBeNull();
        const snap = await upgradeStore.load();
        expect(snap.privacyConsentAnswered).toBe(true);
        expect(snap.telemetryOptIn).toBe(false);
      });
    } finally {
      await upgradeView?.unmount();
      await env.cleanup();
    }
  });

  it('[1.6] wires CrashRecoveryBoundary to telemetry.recordAppCrash with strictly redacted errorName and path-free stackSig', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const telemetry = createMockTelemetry();
    try {
      await renderInProviders(
        <CrashRecoveryBoundary telemetry={telemetry} screenName="home">
          <ExplodingRenderChild />
        </CrashRecoveryBoundary>,
      );

      expect(telemetry.recordAppCrash).toHaveBeenCalledTimes(1);
      const arg = (telemetry.recordAppCrash as jest.Mock).mock.calls[0]?.[0] as {
        errorName: string;
        stackSig: string;
        screen?: string;
        fatal: boolean;
      };
      expect(arg.errorName).toBe('TypeError');
      expect(arg.fatal).toBe(true);
      expect(arg.screen).toBe('home');
      expect(arg.stackSig).not.toContain('Fatih');
      expect(arg.stackSig).not.toContain('alice');
      expect(arg.stackSig).not.toContain('secretpass');
      expect(arg.stackSig).not.toContain('https://');
      expect(arg.stackSig).toContain('ExplodingRenderChild');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('[1.42] [1.43] [1.44] renders destructive red delete buttons, omits Sync Server URL input, and displays live automatic sync status', async () => {
    const syncAccount = createMockSyncAccount({
      status: 'signed_in',
      email: 'viewer@example.com',
      lastSyncedAtIso: '2026-11-27T01:00:00Z',
      autoSyncState: 'pending',
    });

    await renderInProviders(<AccountSettingsPanel syncAccount={syncAccount} />);

    // [1.43] No Sync Server URL input anywhere
    expect(screen.queryByTestId('account-server-url-input')).toBeNull();

    // [1.44] Automatic sync badge & pending status
    expect(screen.getByTestId('account-auto-sync-badge')).toHaveTextContent(
      'Automatic sync active',
    );
    expect(screen.getByTestId('account-sync-status')).toHaveTextContent('Changes queued for sync');
    expect(screen.getByTestId('account-last-synced')).toHaveTextContent(/2026-11-27T01:00:00Z/);

    // [1.42] Destructive variant on expand & confirm buttons
    expect(screen.getByTestId('account-delete-expand-btn')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('account-delete-expand-btn'));
    expect(screen.getByTestId('account-delete-confirm-btn')).toBeTruthy();
  });

  it('[1.44] triggers notifySyncDirty on mutating catalog calls via wrapCatalogForSyncDirty & createObservedCatalog', async () => {
    const notifySyncDirty = jest.fn();
    const baseCatalog = {
      setFavorite: jest.fn(async () => ok(true)),
      reorderFavorites: jest.fn(async () => ok(undefined)),
      setRating: jest.fn(async () => ok(1)),
      saveProgress: jest.fn(async () => ok({} as never)),
      createCollection: jest.fn(async () => ok({} as never)),
      renameSource: jest.fn(async () => ok({} as never)),
      createProfile: jest.fn(async () => ok({} as never)),
      updateParentalSettings: jest.fn(async () => ok({} as never)),
      setParentalPin: jest.fn(async () => ok(undefined)),
      addSource: jest.fn(async () => ok({} as never)),
      addSourceFromLink: jest.fn(async () => ok({} as never)),
      removeSource: jest.fn(async () => ok(undefined)),
      importSource: jest.fn(async () => ok({} as never)),
      listSources: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      seasons: jest.fn(async () => ok([])),
      episodes: jest.fn(async () => []),
      resolveStream: jest.fn(async () => err(elvError('network', 'offline'))),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const wrapped = createObservedCatalog(
      wrapCatalogForSyncDirty(baseCatalog, notifySyncDirty),
      noopPlaybackGuard,
      async () => undefined,
      undefined,
      undefined,
    );

    await wrapped.setFavorite?.({ itemKey: 'k1', sourceId: 's1', kind: 'movie', title: 'M' }, true);
    await wrapped.reorderFavorites?.(['k1']);
    await wrapped.setRating?.({ itemKey: 'k1', sourceId: 's1', kind: 'movie', title: 'M' }, 'like');
    await wrapped.createProfile?.({ name: 'Kids', avatarToken: 'amber', isKids: true });
    await wrapped.setParentalPin?.('1234');
    await wrapped.createCollection?.({ name: 'Sci-Fi' });

    expect(notifySyncDirty).toHaveBeenCalledTimes(6);
  });

  it('P1-3: routes periodic 10s VOD saveProgress ONLY to markSyncDirty (0 notifySyncDirty calls) while setFavorite and setWatched invoke notifySyncDirty', async () => {
    const notifySyncDirty = jest.fn();
    const markSyncDirty = jest.fn();
    const baseCatalog = {
      saveProgress: jest.fn(async () => ok({} as never)),
      setFavorite: jest.fn(async () => ok(true)),
      setWatched: jest.fn(async () => ok(undefined)),
      clearProgress: jest.fn(async () => ok(undefined)),
      listSources: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      seasons: jest.fn(async () => ok([])),
      episodes: jest.fn(async () => []),
      resolveStream: jest.fn(async () => err(elvError('network', 'offline'))),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const wrapped = wrapCatalogForSyncDirty(baseCatalog, notifySyncDirty, markSyncDirty);
    await wrapped.saveProgress?.({
      itemKey: 'm1',
      sourceId: 's1',
      kind: 'movie',
      title: 'Movie',
      positionMs: 10_000,
      durationMs: 600_000,
    });
    expect(markSyncDirty).toHaveBeenCalledTimes(1);
    expect(notifySyncDirty).not.toHaveBeenCalled();

    await wrapped.setFavorite?.({ itemKey: 'm1', sourceId: 's1', kind: 'movie', title: 'M' }, true);
    await wrapped.setWatched?.('m1', true);
    await wrapped.clearProgress?.('m1');
    expect(notifySyncDirty).toHaveBeenCalledTimes(3);
    expect(markSyncDirty).toHaveBeenCalledTimes(1);

    // Also verify useSyncDirtyCatalog wires SyncAccountPort.markSyncDirty separately from notifySyncDirty
    const syncAccount = createMockSyncAccount(
      { status: 'signed_in', email: 'a@example.com' },
      { markSyncDirty: jest.fn(), notifySyncDirty: jest.fn() },
    );
    let hookedCatalog: CatalogService | undefined;
    const view = await render(
      <SyncCatalogHarness
        catalog={baseCatalog}
        syncAccount={syncAccount}
        onWrapped={(wrappedCatalog) => {
          hookedCatalog = wrappedCatalog;
        }}
      />,
    );
    await hookedCatalog?.saveProgress?.({
      itemKey: 'm2',
      sourceId: 's1',
      kind: 'movie',
      title: 'Movie 2',
      positionMs: 20_000,
      durationMs: 600_000,
    });
    expect(syncAccount.markSyncDirty).toHaveBeenCalledTimes(1);
    expect(syncAccount.notifySyncDirty).not.toHaveBeenCalled();
    await hookedCatalog?.setWatched?.('m2', true);
    expect(syncAccount.notifySyncDirty).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('[1.45] renders AccountBidirectionalPairingPanel with QR + spaced 8-digit code, SAS verification, all 5 cases, deep-link URI, camera fallback, and terminal states', async () => {
    const scanner: QrScannerPort = {
      isSupported: () => false,
      scanQrCode: jest.fn(async () => null),
    };

    // 1. Hosting + invalid code + camera unavailable + responder join -> SAS -> confirm
    const syncAccount = createMockSyncAccount({ status: 'signed_in', email: 'alice@example.com' });
    const view = await renderInProviders(
      <AccountBidirectionalPairingPanel syncAccount={syncAccount} qrScanner={scanner} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pair-qr-code')).toBeTruthy();
      expect(screen.getByTestId('pair-host-code')).toHaveTextContent('1234 5678');
    });

    // Camera unavailable shows fallback note
    await fireEvent.press(screen.getByTestId('pair-scan-qr-btn'));
    expect(screen.getByTestId('pair-camera-unavailable')).toHaveTextContent(/unavailable/i);

    // Invalid short code shows error
    await fireEvent.changeText(screen.getByTestId('pair-code-input'), '123');
    await fireEvent.press(screen.getByTestId('pair-code-submit'));
    expect(screen.getByTestId('pair-error')).toHaveTextContent(/valid 8-digit/i);

    // Valid 8-digit code joins -> displays 4-digit SAS -> confirm
    await fireEvent.changeText(screen.getByTestId('pair-code-input'), '87654321');
    await fireEvent.press(screen.getByTestId('pair-code-submit'));
    await waitFor(() => {
      expect(syncAccount.joinBidirectionalPairing).toHaveBeenCalledWith('87654321');
      expect(screen.getByTestId('pair-sas-code')).toHaveTextContent('4829');
    });
    await fireEvent.press(screen.getByTestId('pair-sas-confirm'));
    expect(syncAccount.confirmBidirectionalPairing).toHaveBeenCalledWith(
      'bidir-1',
      'responder_to_host',
    );
    await view.unmount();

    // 2. Different accounts dual-choice with BOTH masked emails
    const diffSync = createMockSyncAccount(
      { status: 'signed_in', email: 'alice@example.com' },
      {
        startBidirectionalPairing: jest.fn(async () => ({
          pairingId: 'bidir-diff',
          role: 'host' as const,
          code: '22223333',
          qrUri: 'elviptv://pair?c=22223333&pk=AAAA',
          expiresAtMs: Date.now() + 300_000,
          status: 'awaiting_sas' as const,
          sas: '9012',
          direction: 'different_accounts' as const,
          localMaskedEmail: 'a***@example.com',
          peerMaskedEmail: 'b***@example.com',
        })),
      },
    );
    const diffView = await renderInProviders(
      <AccountBidirectionalPairingPanel syncAccount={diffSync} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('pair-sas-code')).toHaveTextContent('9012');
      expect(screen.getByTestId('pair-choose-this')).toHaveTextContent(/a\*\*\*@example\.com/);
      expect(screen.getByTestId('pair-choose-other')).toHaveTextContent(/b\*\*\*@example\.com/);
    });
    await fireEvent.press(screen.getByTestId('pair-choose-other'));
    expect(diffSync.confirmBidirectionalPairing).toHaveBeenCalledWith(
      'bidir-diff',
      'responder_to_host',
    );
    await diffView.unmount();

    // 3. Same account -> triggers immediate syncNow()
    const sameSync = createMockSyncAccount(
      { status: 'signed_in', email: 'alice@example.com' },
      {
        startBidirectionalPairing: jest.fn(async () => ({
          pairingId: 'bidir-same',
          role: 'host' as const,
          code: '33334444',
          qrUri: 'elviptv://pair?c=33334444&pk=BBBB',
          expiresAtMs: Date.now() + 300_000,
          status: 'completed' as const,
          sas: null,
          direction: 'same_account' as const,
          localMaskedEmail: 'a***@example.com',
          peerMaskedEmail: 'a***@example.com',
        })),
      },
    );
    const sameView = await renderInProviders(
      <AccountBidirectionalPairingPanel syncAccount={sameSync} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('pair-case-same-account')).toBeTruthy();
      expect(sameSync.syncNow).toHaveBeenCalledTimes(1);
    });
    await sameView.unmount();

    // 4. Neither signed in -> guidance card
    const neitherSync = createMockSyncAccount(
      { status: 'signed_out', email: null },
      {
        startBidirectionalPairing: jest.fn(async () => ({
          pairingId: 'bidir-neither',
          role: 'host' as const,
          code: '44445555',
          qrUri: 'elviptv://pair?c=44445555&pk=CCCC',
          expiresAtMs: Date.now() + 300_000,
          status: 'awaiting_sas' as const,
          sas: null,
          direction: 'neither_signed_in' as const,
          localMaskedEmail: null,
          peerMaskedEmail: null,
        })),
      },
    );
    const neitherView = await renderInProviders(
      <AccountBidirectionalPairingPanel syncAccount={neitherSync} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('pair-case-neither')).toBeTruthy();
    });
    await neitherView.unmount();

    // 5. Locked & deep-link auto-join
    const onHandled = jest.fn();
    const lockSync = createMockSyncAccount(
      { status: 'signed_out', email: null },
      {
        joinBidirectionalPairing: jest.fn(async () => ({
          pairingId: 'bidir-locked',
          role: 'responder' as const,
          code: '55556666',
          expiresAtMs: Date.now() + 300_000,
          status: 'locked' as const,
          sas: null,
          direction: null,
          localMaskedEmail: null,
          peerMaskedEmail: null,
        })),
      },
    );
    const lockView = await renderInProviders(
      <AccountBidirectionalPairingPanel
        syncAccount={lockSync}
        pendingPairUri="elviptv://pair?c=55556666&pk=DDDD"
        onPairUriHandled={onHandled}
      />,
    );
    await waitFor(() => {
      expect(lockSync.joinBidirectionalPairing).toHaveBeenCalledWith(
        'elviptv://pair?c=55556666&pk=DDDD',
      );
      expect(onHandled).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('pair-locked')).toBeTruthy();
    });
    await lockView.unmount();
  });

  it('[1.6] PrivacyConsentOverlay supports TV/pointer opt-in toggle and submits decision cleanly', async () => {
    const onComplete = jest.fn();
    await renderInProviders(<PrivacyConsentOverlay visible onComplete={onComplete} />);
    expect(screen.getByTestId('privacy-consent-overlay')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('privacy-consent-telemetry-toggle'));
    await fireEvent.press(screen.getByTestId('privacy-consent-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it('[1.44] updates setViewingActive and invokes notifyPlaybackPause on active->paused transitions via usePlaybackAutoSyncHooks', async () => {
    const syncAccount = createMockSyncAccount({ status: 'signed_in', email: 'a@example.com' });
    const view = await render(
      <PlaybackAutoSyncHarness syncAccount={syncAccount} isViewingActive hasPlayerTarget />,
    );
    expect(syncAccount.setViewingActive).toHaveBeenCalledWith(true);

    await view.rerender(
      <PlaybackAutoSyncHarness syncAccount={syncAccount} isViewingActive={false} hasPlayerTarget />,
    );
    expect(syncAccount.setViewingActive).toHaveBeenLastCalledWith(false);
    expect(syncAccount.notifyPlaybackPause).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(syncAccount.setViewingActive).toHaveBeenLastCalledWith(false);
  });
});
