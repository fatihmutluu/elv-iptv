import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import {
  createProfilePreferencesManager,
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
  type PreferencesKvBackend,
} from '@elv/domain';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { createObservedCatalog } from '../../app-shell-state';
import { AppProviders, AppShell } from '../../index';
import { createPlaybackGuard } from '../../ports/playback-guard';
import type { VideoHost } from '../../ports/video-host';
import { ProfileProvider, useProfile } from '../../shared';

function ProfileContextProbe({
  snapshots,
  ctxRef,
}: {
  readonly snapshots: Array<{ id: string; enabled: boolean; rev: number }>;
  readonly ctxRef: { current: ReturnType<typeof useProfile> | undefined };
}): null {
  const ctx = useProfile();
  ctxRef.current = ctx;
  snapshots.push({
    id: ctx.activeProfileId,
    enabled: ctx.parentalSettings.enabled,
    rev: ctx.profileRevision,
  });
  return null;
}

function jsonResponse(payload: unknown): HttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

function createParentalHttpClient(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') {
        return err(elvError('network', 'http-404'));
      }
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          jsonResponse({
            user_info: { auth: 1, status: 'Active', allowed_output_formats: ['ts', 'm3u8'] },
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_live_categories') {
        return ok(
          jsonResponse([
            { category_id: '1', category_name: 'General' },
            { category_id: '2', category_name: '18+ Adult' },
          ]),
        );
      }
      if (action === 'get_live_streams') {
        return ok(
          jsonResponse([
            { stream_id: 101, name: 'Family News', category_id: '1', num: 1 },
            { stream_id: 102, name: 'Late Night 18+', category_id: '2', num: 2 },
          ]),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

function createMemBackend(): PreferencesKvBackend {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    delete: (k) => {
      map.delete(k);
    },
  };
}

async function openIntegrationEnv() {
  const handle = testDb();
  await openCatalog(handle.db);
  let now = 1_700_000_000_000;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createParentalHttpClient(),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => 'src-1',
  });
  const added = await catalog.addSource({
    kind: 'xtream',
    name: 'Demo Provider',
    server: 'http://sim.example.test:8080',
    username: 'demo',
    password: ['de', 'mo'].join(''),
  });
  if (!added.ok) throw new Error('addSource failed');
  await catalog.importSource(added.value.id);

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
  const profilePreferences = createProfilePreferencesManager(createMemBackend(), { coalesceMs: 0 });
  return {
    catalog,
    engine,
    videoHost,
    profilePreferences,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

async function enterPin(digits: string) {
  for (const d of digits) {
    await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
  }
  await fireEvent.press(screen.getByTestId('pin-entry-submit'));
}

describe('AppShell Profiles & Parental Integration (#15, #31)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('switches profiles via ProfilePickerOverlay, switches per-profile preferences, and filters restricted categories', async () => {
    const env = await openIntegrationEnv();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const kids = await env.catalog.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      if (!kids?.ok) throw new Error('createProfile failed');
      const kidsId = kids.value.id;

      // Save distinct Turkish locale preference on Kids profile while Default stays English
      await env.profilePreferences.switchProfile(kidsId);
      await env.profilePreferences.update({ locale: 'tr' });
      await env.profilePreferences.switchProfile('default');
      await env.profilePreferences.update({ locale: 'en' });

      view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          systemLocale="en"
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <AppShell
            catalog={env.catalog}
            videoHost={env.videoHost}
            profilePreferences={env.profilePreferences}
          />
        </AppProviders>,
      );

      // Default profile is English and sees both General and 18+ Adult categories in Live -> Channels
      await waitFor(() => {
        expect(screen.getByTestId('nav-tab-profile')).toBeTruthy();
        expect(screen.getByTestId('nav-tab-home')).toHaveTextContent('Home');
      });

      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => expect(screen.getByTestId('live-mode-channels')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('live-mode-channels'));
      await waitFor(() => {
        expect(screen.getByText('General')).toBeTruthy();
        expect(screen.getByText('18+ Adult')).toBeTruthy();
      });

      // Open ProfilePickerOverlay from top-right utility avatar and switch to Kids
      await fireEvent.press(screen.getByTestId('nav-tab-profile'));
      expect(screen.getByTestId('profile-picker-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId(`profile-picker-card-${kidsId}`));

      // Locale flips to Turkish (Kids preference) and 18+ Adult category is filtered out cleanly!
      await waitFor(() => {
        expect(screen.queryByTestId('profile-picker-overlay')).toBeNull();
        expect(screen.getByTestId('nav-tab-home')).toHaveTextContent('Ana Sayfa');
      });

      await fireEvent.press(screen.getByTestId('live-mode-channels'));
      await waitFor(() => {
        expect(screen.getByText('General')).toBeTruthy();
        expect(screen.queryByText('18+ Adult')).toBeNull();
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('prompts PinEntryOverlay when Player encounters auth/parental-locked and retries playback on unlock', async () => {
    const env = await openIntegrationEnv();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      await env.catalog.setParentalPin?.('4321', 'default');

      // Wrap resolveStream so the first locked resolution returns auth/parental-locked until unlocked
      const baseResolve = env.catalog.resolveStream.bind(env.catalog);
      const resolveSpy = jest
        .spyOn(env.catalog, 'resolveStream')
        .mockImplementation(async (itemKey, opts) => {
          if (!opts?.parentalUnlocked) {
            return err(elvError('auth', 'parental-locked'));
          }
          return baseResolve(itemKey, opts);
        });

      view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          systemLocale="en"
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <AppShell
            catalog={env.catalog}
            videoHost={env.videoHost}
            profilePreferences={env.profilePreferences}
          />
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });

      // Attempt to play channel -> resolveStream returns auth/parental-locked -> PinEntryOverlay opens automatically!
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => {
        expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      });
      expect(env.engine.openMedias()).toBe(0);

      // Enter valid PIN -> unlocks parental state and automatically retries playback!
      await enterPin('4321');
      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
        expect(env.engine.openMedias()).toBe(1);
      });
      expect(resolveSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parentalUnlocked: true }),
      );
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('holds AppShell on boot canvas until profilesReady so saved Kids profile never renders or prewarms Adult content on frame 1', async () => {
    const env = await openIntegrationEnv();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const kids = await env.catalog.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      if (!kids?.ok) throw new Error('createProfile failed');
      const kidsId = kids.value.id;
      await env.profilePreferences.saveActiveProfileId(kidsId);

      // Gate loadActiveProfileId so we can inspect frame 1 before profile hydration settles
      let resolveSavedId!: (id: string) => void;
      const gatedPrefs: typeof env.profilePreferences = {
        ...env.profilePreferences,
        getActiveProfileId: () => 'default',
        loadActiveProfileId: () =>
          new Promise<string>((r) => {
            resolveSavedId = r;
          }),
      };
      const categoriesSpy = jest.spyOn(env.catalog, 'categories');

      view = await render(
        <AppProviders
          profilePreferences={gatedPrefs}
          systemLocale="en"
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <AppShell
            catalog={env.catalog}
            videoHost={env.videoHost}
            profilePreferences={gatedPrefs}
          />
        </AppProviders>,
      );

      // While profile hydration is pending, boot canvas holds and NO Adult categories are queried
      await waitFor(() => {
        expect(screen.getByTestId('app-shell-boot')).toBeTruthy();
      });
      expect(categoriesSpy).not.toHaveBeenCalled();

      // Resolve saved Kids profile -> Home renders directly under Kids profile (zero Adult leaks)
      await act(async () => {
        resolveSavedId(kidsId);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('app-shell-boot')).toBeNull();
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });
      expect(screen.queryByText('Late Night 18+')).toBeNull();
      expect(categoriesSpy).toHaveBeenCalledWith(
        expect.any(String),
        'live',
        expect.objectContaining({ profileId: kidsId, parentalUnlocked: false }),
      );
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('commits ProfileContext.switchProfile atomically and drops stale overlapping switch responses', async () => {
    const env = await openIntegrationEnv();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const kids = await env.catalog.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      if (!kids?.ok) throw new Error('createProfile failed');
      const kidsId = kids.value.id;

      let resolveSlowKids!: () => void;
      const slowGate = new Promise<void>((r) => {
        resolveSlowKids = r;
      });
      const baseGetSettings = env.catalog.getParentalSettings?.bind(env.catalog);
      let delayedOnce = false;
      jest.spyOn(env.catalog, 'getParentalSettings').mockImplementation(async (pid) => {
        if (pid === kidsId && !delayedOnce) {
          delayedOnce = true;
          await slowGate;
        }
        return (
          baseGetSettings?.(pid) ?? {
            profileId: pid ?? 'default',
            enabled: false,
            blockAdultKeywords: true,
            maxRatingAge: null,
            unlockTimeoutMin: 30,
            updatedAt: 0,
          }
        );
      });

      const onChange = jest.fn();
      const snapshots: Array<{ id: string; enabled: boolean; rev: number }> = [];
      const ctxRef: { current: ReturnType<typeof useProfile> | undefined } = { current: undefined };

      view = await render(
        <ProfileProvider
          catalog={env.catalog}
          profilePreferences={env.profilePreferences}
          onProfileOrLockChange={onChange}
        >
          <ProfileContextProbe snapshots={snapshots} ctxRef={ctxRef} />
        </ProfileProvider>,
      );

      await waitFor(() => expect(ctxRef.current?.profilesReady).toBe(true));
      snapshots.length = 0;

      // Start slow switch to Kids, then immediately overlap with switch back to Default
      let pKids!: Promise<void>;
      let pDefault!: Promise<void>;
      await act(async () => {
        const ctx = ctxRef.current;
        if (!ctx) throw new Error('missing ProfileContext');
        pKids = ctx.switchProfile(kidsId);
        pDefault = ctx.switchProfile('default');
        await pDefault;
        resolveSlowKids();
        await pKids;
      });

      // Stale Kids switch was dropped; active profile remains 'default' with single commit
      expect(ctxRef.current?.activeProfileId).toBe('default');
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ activeProfileId: 'default', reason: 'profile-switch' }),
      );

      // Now do a clean switch to Kids -> single atomic commit (enabled === true on first render with kidsId)
      snapshots.length = 0;
      await act(async () => {
        const ctx = ctxRef.current;
        if (!ctx) throw new Error('missing ProfileContext');
        await ctx.switchProfile(kidsId);
      });
      const kidsRenders = snapshots.filter((s) => s.id === kidsId);
      expect(kidsRenders.length).toBeGreaterThanOrEqual(1);
      expect(kidsRenders[0]?.enabled).toBe(true);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('auto-relocks parental controls on desktop documentVisible=false and stops Live embedded preview on relock', async () => {
    const env = await openIntegrationEnv();
    jest.replaceProperty(Platform, 'OS', 'web');
    const docListeners = new Map<string, Set<() => void>>();
    const origDoc = (globalThis as Record<string, unknown>).document;
    let visibilityState: 'visible' | 'hidden' = 'visible';
    (globalThis as Record<string, unknown>).document = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (type: string, fn: () => void) => {
        const set = docListeners.get(type) ?? new Set();
        set.add(fn);
        docListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        docListeners.get(type)?.delete(fn);
      },
    };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      await env.catalog.setParentalPin?.('1234', 'default');
      await env.catalog.updateParentalSettings?.(
        { enabled: true, blockAdultKeywords: true },
        'default',
      );

      // Favorite the adult channel so Favorites embedded preview opens it while unlocked
      const allCats = await env.catalog.categories('src-1', 'live', {
        includeHidden: true,
        parentalUnlocked: true,
      });
      const adultCat = allCats.find((c) => c.name === '18+ Adult');
      const adultItems = await env.catalog.items(adultCat?.id ?? '', 0, 10, {
        parentalUnlocked: true,
      });
      const adultChannel = adultItems[0];
      if (!adultChannel) throw new Error('missing adult channel');
      await env.catalog.setFavorite?.(
        {
          sourceId: adultChannel.sourceId,
          itemKey: adultChannel.key,
          kind: 'live',
          title: adultChannel.name,
        },
        true,
      );

      const releaseSpy = jest.spyOn(env.engine, 'release');

      view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          systemLocale="en"
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <AppShell
            catalog={env.catalog}
            videoHost={env.videoHost}
            profilePreferences={env.profilePreferences}
          />
        </AppProviders>,
      );

      // Go to Settings -> Profiles & Parental and unlock with PIN 1234
      await waitFor(() => expect(screen.getByTestId('nav-tab-settings')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('nav-tab-settings'));
      await waitFor(() => expect(screen.getByTestId('settings-tab-profiles')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('settings-tab-profiles'));
      await waitFor(() => expect(screen.getByTestId('parental-unlock-button')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('parental-unlock-button'));
      await enterPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Unlocked');
      });

      // Switch to Live (Favorites stage opens embedded preview on adult favorite while unlocked)
      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => {
        expect(env.engine.openMedias()).toBeGreaterThanOrEqual(1);
      });

      // Simulate Desktop window minimize/hide (document.visibilityState = 'hidden' -> visibilitychange)
      await act(async () => {
        visibilityState = 'hidden';
        for (const fn of docListeners.get('visibilitychange') ?? []) fn();
      });

      // Embedded preview engine MUST be stopped/released immediately & parental controls re-locked!
      await waitFor(() => {
        expect(releaseSpy).toHaveBeenCalled();
      });
      await fireEvent.press(screen.getByTestId('nav-tab-settings'));
      await waitFor(() => {
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Locked');
      });
    } finally {
      (globalThis as Record<string, unknown>).document = origDoc;
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('forwards parental options through createObservedCatalog for liveVariants, itemVersions, seasons, episodes, and queryNextEpisode', async () => {
    const liveVariants = jest.fn(async () => []);
    const itemVersions = jest.fn(async () => []);
    const seasons = jest.fn(async () => ok([]));
    const episodes = jest.fn(async () => []);
    const queryNextEpisode = jest.fn(async () => null);
    const base = {
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      listSources: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      liveVariants,
      itemVersions,
      seasons,
      episodes,
      queryNextEpisode,
      resolveStream: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const observed = createObservedCatalog(
      base,
      createPlaybackGuard(() => undefined),
      async () => undefined,
    );
    const opts = { profileId: 'kids-1', parentalUnlocked: false };
    await observed.liveVariants?.('ch:1', 'cat:1', opts);
    await observed.itemVersions?.('mov:1', opts);
    await observed.seasons(10, opts);
    await observed.episodes(10, 2, opts);
    await observed.queryNextEpisode?.('ser:10', 'ep:1', 'kids-1', { parentalUnlocked: false });

    expect(liveVariants).toHaveBeenCalledWith('ch:1', 'cat:1', opts);
    expect(itemVersions).toHaveBeenCalledWith('mov:1', opts);
    expect(seasons).toHaveBeenCalledWith(10, opts);
    expect(episodes).toHaveBeenCalledWith(10, 2, opts);
    expect(queryNextEpisode).toHaveBeenCalledWith('ser:10', 'ep:1', 'kids-1', {
      parentalUnlocked: false,
    });
  });
});
