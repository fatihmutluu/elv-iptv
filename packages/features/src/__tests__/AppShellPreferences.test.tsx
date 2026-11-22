import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createMemoryPreferencesStore, elvError, err, type HttpClient } from '@elv/domain';
import { UiAdaptersProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render, waitFor } from '@testing-library/react-native';
import { AppProviders, AppShell } from '../index';
import type { VideoHost } from '../ports/video-host';

const EMPTY_HTTP: HttpClient = {
  async get() {
    return err(elvError('network', 'http-404'));
  },
};

const EMPTY_VIDEO_HOST: VideoHost = {
  open() {
    return null;
  },
};

describe('AppShell preference synchronization (#405)', () => {
  it('syncs artworkCacheLimitMb preference to UiAdapters.artworkCache.setLimitBytes on mount and updates', async () => {
    const driver = testDb();
    await openCatalog(driver.db);
    let nextId = 1;
    const catalog = createCatalogService({
      db: driver.db,
      secrets: memorySecrets(),
      http: EMPTY_HTTP,
      scheduler: countingScheduler(),
      clock: () => 1_700_000_000_000,
      newId: () => `src-${nextId++}`,
    });
    const preferencesStore = createMemoryPreferencesStore({ artworkCacheLimitMb: 64 });
    const setLimitBytes = jest.fn(async () => undefined);
    const clear = jest.fn(async () => undefined);

    await render(
      <UiAdaptersProvider adapters={{ artworkCache: { setLimitBytes, clear } }}>
        <ViewportProvider
          value={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <AppProviders preferencesStore={preferencesStore}>
            <AppShell catalog={catalog} videoHost={EMPTY_VIDEO_HOST} />
          </AppProviders>
        </ViewportProvider>
      </UiAdaptersProvider>,
    );

    await waitFor(() => {
      expect(setLimitBytes).toHaveBeenCalledWith(64 * 1024 * 1024);
    });

    await act(async () => {
      await preferencesStore.update({ artworkCacheLimitMb: 256 });
    });

    await waitFor(() => {
      expect(setLimitBytes).toHaveBeenCalledWith(256 * 1024 * 1024);
    });

    await catalog.close();
    driver.close();
  });
});
