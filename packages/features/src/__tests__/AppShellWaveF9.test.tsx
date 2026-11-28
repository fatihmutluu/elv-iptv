import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createMemoryPreferencesStore, elvError, err, type HttpClient } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../index';
import type { VideoHost } from '../ports/video-host';
import type {
  FeedbackPort,
  SyncAccountPort,
  SyncAccountState,
  TelemetryPort,
} from '../ports/wave-f9-ports';

const offlineHttpClient: HttpClient = {
  async get() {
    return err(elvError('network', 'offline'));
  },
};

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
  return {
    catalog,
    videoHost,
    cleanup: () => handle.close(),
  };
}

function createSignedOutSyncPort(): SyncAccountPort {
  const state: SyncAccountState = {
    status: 'signed_out',
    email: null,
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
  };
  return {
    getState: jest.fn(() => state),
    subscribe: jest.fn((_listener) => () => undefined),
    signIn: jest.fn(async (_e, _p) => ({ ok: true })),
    register: jest.fn(async (_e, _p, _c) => ({ ok: true })),
    acknowledgeRecoveryCode: jest.fn(),
    syncNow: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async (_p) => ({ ok: true })),
    createQrPairing: jest.fn(async () => ({
      pairingId: 'p1',
      code: 'CODE12345678',
      qrUri: 'elviptv://pair?c=CODE12345678&k=AAAAAAAAAAAAAAAAAAAAAA',
      expiresAtMs: Date.now() + 60_000,
      status: 'pending' as const,
    })),
    pollQrPairing: jest.fn(async (_id) => 'pending' as const),
    claimQrPairing: jest.fn(async (_code) => ({ ok: true })),
  };
}

describe('AppShell Wave F9 integration', () => {
  it('shows first-run WelcomeSyncOverlay when syncAccount is signed out, dismisses on Continue without account, and wires Settings Account & Feedback panels', async () => {
    const env = await openTestShell();
    const prefsStore = createMemoryPreferencesStore();
    const syncAccount = createSignedOutSyncPort();
    const telemetry: TelemetryPort = {
      isOptedIn: jest.fn(() => false),
      setOptIn: jest.fn(),
      queuedCount: jest.fn(() => 0),
      getPayloadPreviewJson: jest.fn(() => '{"events":[]}'),
      recordScreenTransition: jest.fn(),
      recordMediaDecodeFailure: jest.fn(),
      recordPlaybackError: jest.fn(),
      flush: jest.fn(async () => undefined),
    };
    const feedback: FeedbackPort = {
      submit: jest.fn(async (_input) => ({ ok: true, id: 'fb-9' })),
    };

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

      // Welcome overlay appears on first run when signed out
      await waitFor(() => {
        expect(screen.getByTestId('welcome-sync-overlay')).toBeTruthy();
      });
      expect(telemetry.setOptIn).toHaveBeenCalledWith(false);

      // Clicking Continue without account persists welcomeDismissed and advances to Screen 2 (Source)
      await fireEvent.press(screen.getByTestId('welcome-continue-without-account'));
      await waitFor(() => {
        expect(screen.queryByTestId('welcome-sync-overlay')).toBeNull();
        expect(screen.getByTestId('onboarding-source-step')).toBeTruthy();
      });

      // Clicking Browse without a source exits onboarding cleanly into Settings
      await fireEvent.press(screen.getByTestId('onboarding-browse-without-source'));
      await waitFor(() => {
        expect(screen.queryByTestId('onboarding-flow-overlay')).toBeNull();
      });

      // Navigate Settings -> Account & Sync (Sync Server URL input removed in Wave P9)
      await fireEvent.press(screen.getByTestId('settings-tab-account'));
      await waitFor(() => {
        expect(screen.getByTestId('settings-panel-account')).toBeTruthy();
        expect(screen.queryByTestId('account-server-url-input')).toBeNull();
      });

      // Navigate Settings -> Feedback
      await fireEvent.press(screen.getByTestId('settings-tab-feedback'));
      await waitFor(() => {
        expect(screen.getByTestId('settings-panel-feedback')).toBeTruthy();
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('P1-2: forwards externalRefreshToken from AppShell into ProfileProvider so incoming synced profiles appear live without restart', async () => {
    const env = await openTestShell();
    const prefsStore = createMemoryPreferencesStore({
      welcomeDismissed: true,
      privacyConsentAnswered: true,
    });

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} externalRefreshToken={0} />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('nav-utility-profile')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('nav-utility-profile'));

      // Simulate incoming E2EE sync inserting a new profile directly in SQLite
      const created = await env.catalog.createProfile?.({
        name: 'SyncedGuest',
        avatarToken: 'emerald',
        isKids: false,
      });
      if (!created?.ok) throw new Error('createProfile failed');

      await view.rerender(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} externalRefreshToken={1} />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByText('SyncedGuest')).toBeTruthy();
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('calls syncAccount.signOut() when Sign out is pressed inside ProfileDropdownMenu while cloud account is signed in', async () => {
    const env = await openTestShell();
    const prefsStore = createMemoryPreferencesStore({
      welcomeDismissed: true,
      privacyConsentAnswered: true,
    });
    const signedInState: SyncAccountState = {
      status: 'signed_in',
      email: 'viewer@example.test',
      lastSyncedAtIso: '2026-11-28T00:00:00.000Z',
      pendingRecoveryCode: null,
      errorCode: null,
    };
    const syncAccount: SyncAccountPort = {
      ...createSignedOutSyncPort(),
      getState: jest.fn(() => signedInState),
    };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} syncAccount={syncAccount} />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('nav-utility-profile')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('nav-utility-profile'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-menu-sign-out')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('profile-menu-sign-out'));

      expect(syncAccount.signOut).toHaveBeenCalledTimes(1);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });
});
