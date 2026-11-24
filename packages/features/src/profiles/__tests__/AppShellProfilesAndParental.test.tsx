import { createCatalogService, openCatalog } from '@elv/data';
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
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../../index';
import type { VideoHost } from '../../ports/video-host';

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
});
