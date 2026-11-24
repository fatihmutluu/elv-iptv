import type { CatalogService, FavoriteRow, ItemDetailRow, WatchProgressRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../index';
import type { TvHomeChannelsPort } from '../ports/tv-home-channels';
import type { VideoHost } from '../ports/video-host';

function createStubVideoHost(): VideoHost {
  const engine = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return {
    open: jest.fn(() => ({
      engine,
      renderSurface: ({ testID }) => <View testID={testID ?? 'stub-video-surface'} />,
    })),
  };
}

describe('AppShell Wave F2 (#273 Android TV Home Channels & Deep-Link + #60 Settings Entry)', () => {
  it('syncs parental-filtered Continue Watching & Favorites to TvHomeChannelsPort and handles deep-link playback', async () => {
    const continueRows: WatchProgressRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: 'Test Movie',
        subtitle: null,
        logo: 'https://cdn.example.test/m1.png',
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 45_000,
        durationMs: 300_000,
        watched: false,
        updatedAt: 100,
      },
    ];
    const favRows: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:live:1',
        kind: 'live',
        title: 'News 1',
        logo: 'https://cdn.example.test/n1.png',
        year: null,
        rating: null,
        addedAt: 200,
      },
    ];
    const liveDetail: ItemDetailRow = {
      id: 1,
      key: 'x:s1:live:1',
      kind: 'live',
      sourceId: 's1',
      providerId: '1',
      name: 'News 1',
      logo: 'https://cdn.example.test/n1.png',
      rating: null,
      year: null,
      num: 1,
      plot: null,
    };

    const catalog = {
      listSources: jest.fn(async () => [
        {
          id: 's1',
          kind: 'm3u',
          name: 'Demo',
          createdAt: 1,
          needsImport: false,
          settings: {},
        },
      ]),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      allSourcesItems: jest.fn(async () => []),
      itemDetail: jest.fn(async (key: string) => (key === 'x:s1:live:1' ? liveDetail : null)),
      listContinueWatching: jest.fn(async () => continueRows),
      listFavorites: jest.fn(async () => favRows),
      listFavoriteKeys: jest.fn(async () => ['x:s1:live:1']),
      listProfiles: jest.fn(async () => [
        {
          id: 'default',
          name: 'Default',
          avatarToken: 'crimson',
          isKids: false,
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ]),
      getParentalSettings: jest.fn(async () => ({
        profileId: 'default',
        enabled: false,
        blockAdultKeywords: true,
        maxRatingAge: null,
        unlockTimeoutMin: 30,
        updatedAt: 0,
      })),
      listParentalLocks: jest.fn(async () => []),
      hasParentalPin: jest.fn(async () => false),
      resolveStream: jest.fn(async () => ok({ url: 'http://127.0.0.1/live.ts' })),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(async () => ok([])),
      episodes: jest.fn(async () => []),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const syncChannels = jest.fn(async () => ({
      supported: true,
      syncedChannels: 2,
      syncedPrograms: 2,
    }));
    const tvHomeChannels: TvHomeChannelsPort = {
      isSupported: () => true,
      syncChannels,
      clearChannels: jest.fn(async () => undefined),
    };
    const onDeepLinkHandled = jest.fn();

    await render(
      <AppProviders
        i18n={createAppI18n('en')}
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <AppShell
          catalog={catalog}
          videoHost={createStubVideoHost()}
          tvHomeChannels={tvHomeChannels}
          pendingDeepLink={{ itemKey: 'x:s1:live:1', kind: 'live' }}
          onDeepLinkHandled={onDeepLinkHandled}
        />
      </AppProviders>,
    );

    await waitFor(
      () => {
        expect(syncChannels).toHaveBeenCalledTimes(1);
      },
      { timeout: 2_000 },
    );

    const syncedPayload = (syncChannels.mock.calls[0] as unknown[])[0] as Array<{
      internalId: string;
      programs: Array<{ itemKey: string }>;
    }>;
    expect(syncedPayload[0]?.internalId).toBe('continue_watching');
    expect(syncedPayload[0]?.programs[0]?.itemKey).toBe('x:s1:movie:1');
    expect(syncedPayload[1]?.internalId).toBe('favorites');
    expect(syncedPayload[1]?.programs[0]?.itemKey).toBe('x:s1:live:1');

    await waitFor(() => {
      expect(onDeepLinkHandled).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('player-screen')).toBeTruthy();
    });
  });

  it('prompts for parental PIN when a deep-link targets a parental-locked item', async () => {
    const lockedMovie: ItemDetailRow = {
      id: 99,
      key: 'x:s1:movie:99',
      kind: 'movie',
      sourceId: 's1',
      providerId: '99',
      name: 'Restricted Movie',
      logo: null,
      rating: null,
      year: 2025,
      num: null,
      plot: null,
    };
    const catalog = {
      listSources: jest.fn(async () => [
        { id: 's1', kind: 'm3u', name: 'Demo', createdAt: 1, needsImport: false, settings: {} },
      ]),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      allSourcesItems: jest.fn(async () => []),
      itemDetail: jest.fn(async (key: string, opts?: { parentalUnlocked?: boolean }) =>
        key === 'x:s1:movie:99' && opts?.parentalUnlocked === true ? lockedMovie : null,
      ),
      listProfiles: jest.fn(async () => [
        {
          id: 'kids',
          name: 'Kids',
          avatarToken: 'emerald',
          isKids: true,
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ]),
      getParentalSettings: jest.fn(async () => ({
        profileId: 'kids',
        enabled: true,
        blockAdultKeywords: true,
        maxRatingAge: 12,
        unlockTimeoutMin: 30,
        updatedAt: 0,
      })),
      listParentalLocks: jest.fn(async () => []),
      hasParentalPin: jest.fn(async () => true),
      verifyParentalPin: jest.fn(async () => ({ ok: true, remainingAttempts: 5 })),
      resolveStream: jest.fn(async () => ok({ url: 'http://127.0.0.1/m.mp4' })),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(async () => ok([])),
      episodes: jest.fn(async () => []),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;
    const onDeepLinkHandled = jest.fn();

    await render(
      <AppProviders
        i18n={createAppI18n('en')}
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <AppShell
          catalog={catalog}
          videoHost={createStubVideoHost()}
          pendingDeepLink={{ itemKey: 'x:s1:movie:99', kind: 'movie' }}
          onDeepLinkHandled={onDeepLinkHandled}
        />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(onDeepLinkHandled).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
    });
  });

  it('opens ChannelManagementOverlay from Settings -> Live TV -> Manage channels', async () => {
    const catalog = {
      listSources: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      allSourcesItems: jest.fn(async () => []),
      listCustomGroups: jest.fn(async () => []),
      resolveStream: jest.fn(),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(async () => ok([])),
      episodes: jest.fn(async () => []),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    await render(
      <AppProviders
        i18n={createAppI18n('en')}
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <AppShell catalog={catalog} videoHost={createStubVideoHost()} />
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByTestId('settings-tab-liveTv')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-tab-liveTv'));
    });
    await waitFor(() => expect(screen.getByTestId('settings-livetv-manage-channels')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('settings-livetv-manage-channels'));
    await waitFor(() => expect(screen.getByTestId('channel-management-overlay')).toBeTruthy());
  });
});
