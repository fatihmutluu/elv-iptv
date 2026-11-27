import { createCatalogService, openCatalog, type SourceRow } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import {
  createMemoryPreferencesStore,
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../index';
import type { VideoHost } from '../ports/video-host';
import type { SyncAccountPort, SyncAccountState, TelemetryPort } from '../ports/wave-f9-ports';
import { ONBOARDING_PROFILE_NAMES_EN } from '../shared';

function textResponse(text: string): HttpResponse {
  const bytes = new TextEncoder().encode(text);
  return {
    status: 200,
    headers: { 'content-type': 'audio/x-mpegurl' },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

function createFakeHost(): VideoHost {
  const engine = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return {
    open: () => ({
      engine,
      renderSurface: ({ testID }) => <View testID={testID ?? 'shell-surface'} />,
    }),
  };
}

async function openTestCatalog(http?: HttpClient, clock?: () => number) {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let seq = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: http ?? {
      async get() {
        return ok(
          textResponse(
            '#EXTM3U\n#EXTINF:-1 group-title="Cinema",Demo Channel\nhttp://a.test/1.ts\n',
          ),
        );
      },
    },
    clock:
      clock ??
      (() => {
        now += 10;
        return now;
      }),
    newId: () => `src-${seq++}`,
  });
  return {
    catalog,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function createSyncMock(overrides: Partial<SyncAccountPort> = {}): SyncAccountPort {
  const state: SyncAccountState = {
    status: 'signed_out',
    email: null,
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
  };
  return {
    getState: jest.fn(() => state),
    subscribe: jest.fn(() => () => undefined),
    checkEmail: jest.fn(async () => 'unknown' as const),
    supportedOAuthProviders: [],
    signIn: jest.fn(async () => ({ ok: true })),
    register: jest.fn(async () => ({ ok: true })),
    acknowledgeRecoveryCode: jest.fn(),
    syncNow: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async () => ({ ok: true })),
    createQrPairing: jest.fn(),
    pollQrPairing: jest.fn(),
    claimQrPairing: jest.fn(),
    ...overrides,
  };
}

function createTelemetryMock(): TelemetryPort {
  return {
    isOptedIn: jest.fn(() => false),
    setOptIn: jest.fn(),
    queuedCount: jest.fn(() => 0),
    getPayloadPreviewJson: jest.fn(() => '{}'),
    recordScreenTransition: jest.fn(),
    recordMediaDecodeFailure: jest.fn(),
    recordPlaybackError: jest.fn(),
    flush: jest.fn(async () => undefined),
  };
}

describe('Wave E3 AppShell Smart Onboarding, Auto-Migration & Returning-User Startup (#513)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('waits strictly for preferences, profiles, and sources before mounting onboarding and quietly personalizes the untouched default profile in place', async () => {
    const env = await openTestCatalog();
    const prefsStore = createMemoryPreferencesStore();
    const syncAccount = createSyncMock();
    const telemetry = createTelemetryMock();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell
                catalog={env.catalog}
                videoHost={createFakeHost()}
                syncAccount={syncAccount}
                telemetry={telemetry}
              />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('welcome-sync-overlay')).toBeTruthy();
        expect(screen.getByTestId('onboarding-welcome-step')).toBeTruthy();
      });

      // Zero pre-consent telemetry before user proceeds past Screen 1
      expect(telemetry.setOptIn).toHaveBeenCalledWith(false);
      expect((await prefsStore.load()).telemetryOptIn).toBe(false);

      // Guest flow -> quietly customizes untouched default profile IN PLACE (still 1 profile!)
      await fireEvent.press(screen.getByTestId('welcome-continue-without-account'));
      await waitFor(() => {
        expect(screen.getByTestId('onboarding-source-step')).toBeTruthy();
      });

      await waitFor(async () => {
        const profiles = (await env.catalog.listProfiles?.()) ?? [];
        expect(profiles).toHaveLength(1);
        expect(profiles[0]?.id).toBe('default');
        expect(ONBOARDING_PROFILE_NAMES_EN).toContain(profiles[0]?.name);
      });

      const prefsAfterScreen1 = await prefsStore.load();
      expect(prefsAfterScreen1.telemetryOptIn).toBe(true);
      expect(prefsAfterScreen1.privacyConsentAnswered).toBe(true);
      expect(prefsAfterScreen1.welcomeDismissed).toBe(true);
      expect(prefsAfterScreen1.themePreset).toBe('obsidianCrimson');

      // Browse without source completes onboarding cleanly into Sources
      await fireEvent.press(screen.getByTestId('onboarding-browse-without-source'));
      await waitFor(async () => {
        expect(screen.queryByTestId('onboarding-flow-overlay')).toBeNull();
        expect((await prefsStore.load()).onboardingCompleted).toBe(true);
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('auto-migrates upgrading users with existing sources or welcomeDismissed without ever flashing onboarding', async () => {
    const now = Date.now();
    const env = await openTestCatalog(undefined, () => now);
    const added = await env.catalog.addSourceFromLink({
      name: 'Existing M3U',
      url: 'https://demo.example.test/list.m3u8',
    });
    if (!added.ok) throw new Error('addSource failed');
    await env.catalog.importSource(added.value.id);

    const prefsStore = createMemoryPreferencesStore({
      onboardingCompleted: false,
      welcomeDismissed: false,
    });
    const syncAccount = createSyncMock();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell
                catalog={env.catalog}
                videoHost={createFakeHost()}
                syncAccount={syncAccount}
              />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      expect(screen.queryByTestId('onboarding-flow-overlay')).toBeNull();
      expect(screen.queryByTestId('welcome-sync-overlay')).toBeNull();

      await waitFor(async () => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
        expect((await prefsStore.load()).onboardingCompleted).toBe(true);
      });
      expect(screen.queryByTestId('onboarding-flow-overlay')).toBeNull();
      // 1 profile never auto-opens Who's Watching?
      expect(screen.queryByTestId('profile-picker-overlay')).toBeNull();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('runs returning-user StartupRefreshOverlay for stale sources, hides on cancel WITHOUT aborting background refresh, then opens Who is Watching for 2+ profiles', async () => {
    let resolveFetch!: (res: ReturnType<typeof ok<HttpResponse>>) => void;
    let firstImport = true;
    const controlledHttp: HttpClient = {
      get(_url, opts) {
        if (firstImport) {
          firstImport = false;
          return Promise.resolve(
            ok(
              textResponse(
                '#EXTM3U\n#EXTINF:-1 group-title="Cinema",Initial Channel\nhttp://a.test/1.ts\n',
              ),
            ),
          );
        }
        return new Promise((resolve) => {
          resolveFetch = resolve;
          opts?.signal?.addEventListener('abort', () => {
            resolve(err(elvError('network', 'aborted')));
          });
        });
      },
    };

    let clockTime = Date.now() - 36 * 3_600_000;
    const env = await openTestCatalog(controlledHttp, () => clockTime);
    const added = await env.catalog.addSourceFromLink({
      name: 'Stale Provider',
      url: 'https://demo.example.test/stale.m3u8',
    });
    if (!added.ok) throw new Error('addSource failed');
    await env.catalog.importSource(added.value.id);
    // Advance simulated clock 36h forward to represent cold startup the next day
    clockTime = Date.now();

    // Create a 2nd profile so "Who's Watching?" opens automatically AFTER startup refresh settles
    const secondProfile = await env.catalog.createProfile?.({
      name: 'Family',
      avatarToken: 'emerald',
      isKids: false,
    });
    if (!secondProfile?.ok) throw new Error('createProfile failed');

    const importSpy = jest.spyOn(env.catalog, 'importSource');
    const prefsStore = createMemoryPreferencesStore({
      onboardingCompleted: true,
      welcomeDismissed: true,
      privacyConsentAnswered: true,
      catalogRefreshHours: 24,
      guideRefreshHours: 0,
    });

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={createFakeHost()} />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      // Startup refresh overlay appears while ProfilePicker is suppressed
      await waitFor(() => {
        expect(screen.getByTestId('startup-refresh-overlay')).toBeTruthy();
      });
      expect(screen.queryByTestId('profile-picker-overlay')).toBeNull();
      expect(importSpy).toHaveBeenCalledTimes(1);
      const signal = importSpy.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);

      // Clicking Cancel / Continue hides overlay immediately WITHOUT aborting background refresh!
      await fireEvent.press(screen.getByTestId('startup-refresh-cancel'));
      await waitFor(() => {
        expect(screen.queryByTestId('startup-refresh-overlay')).toBeNull();
        // Now 2+ profiles opens Who's Watching? automatically once!
        expect(screen.getByTestId('profile-picker-overlay')).toBeTruthy();
      });
      expect(signal?.aborted).toBe(false);

      // Let background refresh complete quietly
      await act(async () => {
        resolveFetch(
          ok(
            textResponse(
              '#EXTM3U\n#EXTINF:-1 group-title="Cinema",Updated Channel\nhttp://a.test/2.ts\n',
            ),
          ),
        );
        await Promise.resolve();
      });

      // Verify zero duplicate overlapping refresh from useGuideAutoRefresh
      expect(importSpy).toHaveBeenCalledTimes(1);
      const sourcesAfter: readonly SourceRow[] = await env.catalog.listSources();
      expect(sourcesAfter).toHaveLength(1);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('handles offline error gracefully when startup refresh fails', async () => {
    const staleTime = Date.now() - 48 * 3_600_000;
    let shouldFail = false;
    const env = await openTestCatalog(
      {
        async get() {
          if (shouldFail) return err(elvError('network', 'offline'));
          return ok(
            textResponse(
              '#EXTM3U\n#EXTINF:-1 group-title="News",Offline Safe\nhttp://a.test/1.ts\n',
            ),
          );
        },
      },
      () => staleTime,
    );
    const added = await env.catalog.addSourceFromLink({
      name: 'Offline Provider',
      url: 'https://demo.example.test/offline.m3u8',
    });
    if (!added.ok) throw new Error('addSource failed');
    await env.catalog.importSource(added.value.id);
    shouldFail = true;

    const importSpy = jest.spyOn(env.catalog, 'importSource');
    const prefsStore = createMemoryPreferencesStore({
      onboardingCompleted: true,
      welcomeDismissed: true,
      privacyConsentAnswered: true,
      catalogRefreshHours: 24,
      guideRefreshHours: 0,
    });

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={createFakeHost()} />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.queryByTestId('startup-refresh-overlay')).toBeNull();
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      // Allow any follow-up timers from useGuideAutoRefresh to tick — shared 1h failure backoff MUST prevent duplicate failing import!
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(importSpy).toHaveBeenCalledTimes(1);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('auto-migrates 2+ profile restarts without re-entering onboarding or re-prompting privacy consent (#513)', async () => {
    const env = await openTestCatalog();
    const created = await env.catalog.createProfile?.({
      name: 'Second Profile',
      avatarToken: 'emerald',
      isKids: false,
    });
    if (!created?.ok) throw new Error('createProfile failed');

    const telemetry = createTelemetryMock();
    const prefsStore = createMemoryPreferencesStore({
      onboardingCompleted: false,
      welcomeDismissed: false,
      privacyConsentAnswered: false,
    });

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={createFakeHost()} telemetry={telemetry} />
            </I18nProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(async () => {
        const snap = await prefsStore.load();
        expect(snap.onboardingCompleted).toBe(true);
        expect(snap.welcomeDismissed).toBe(true);
        expect(snap.privacyConsentAnswered).toBe(true);
      });
      expect(screen.queryByTestId('onboarding-flow-overlay')).toBeNull();
      expect(screen.queryByTestId('privacy-consent-overlay')).toBeNull();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });
});
