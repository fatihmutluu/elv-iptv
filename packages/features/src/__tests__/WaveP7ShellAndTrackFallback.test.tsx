import { type CatalogService, createCatalogService, openCatalog, type SourceRow } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { type HttpClient, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text, View } from 'react-native';
import { createObservedCatalog } from '../app-shell-state';
import {
  AppProviders,
  AppShell,
  PlayerScreen,
  type PlayerScreenProps,
  usePreferences,
  type VideoHost,
} from '../index';
import { createPlaybackGuard } from '../ports/playback-guard';

function CacheLimitProbe(): ReactElement {
  const { preferences } = usePreferences();
  return <Text testID="probe-artwork-limit">{String(preferences.artworkCacheLimitMb)}</Text>;
}

function createTwoSourceHttp(): HttpClient {
  return {
    async get(url) {
      const m3u = url.includes('adult-only')
        ? '#EXTM3U\n#EXTINF:-1 group-title="Adult News",Source A News\nhttp://127.0.0.1/a.ts\n'
        : '#EXTM3U\n#EXTINF:-1 group-title="Kids Cartoons",Source B Cartoons\nhttp://127.0.0.1/b.ts\n';
      const bytes = new TextEncoder().encode(m3u);
      return ok({
        status: 200,
        headers: {},
        body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    },
  };
}

describe('Wave P7 AppProviders platform defaults, AppShell per-profile source filtering & Player fallbackLocale', () => {
  it('initializes pre-ready artworkCacheLimitMb with platform defaults (Desktop 512, TV 128, Mobile 256) with zero blink', async () => {
    const desktopView = await render(
      <AppProviders
        viewport={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
      >
        <CacheLimitProbe />
      </AppProviders>,
    );
    expect(screen.getByTestId('probe-artwork-limit')).toHaveTextContent('512');
    await desktopView.unmount();

    const tvView = await render(
      <AppProviders
        viewport={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
      >
        <CacheLimitProbe />
      </AppProviders>,
    );
    expect(screen.getByTestId('probe-artwork-limit')).toHaveTextContent('128');
    await tvView.unmount();

    const phoneView = await render(
      <AppProviders
        viewport={{ formFactor: 'phone', orientation: 'portrait', width: 393, height: 852 }}
      >
        <CacheLimitProbe />
      </AppProviders>,
    );
    expect(screen.getByTestId('probe-artwork-limit')).toHaveTextContent('256');
    await phoneView.unmount();
  });

  it('hides excluded source channels from Home/Live on Kids profile while keeping ALL sources visible in Settings -> Sources', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    let clockTick = 10_000;
    const catalog = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: createTwoSourceHttp(),
      clock: () => {
        clockTick += 10;
        return clockTick;
      },
    });

    const addA = await catalog.addSourceFromLink({
      name: 'Source A',
      url: 'http://127.0.0.1/adult-only.m3u',
    });
    const addB = await catalog.addSourceFromLink({
      name: 'Source B',
      url: 'http://127.0.0.1/family.m3u',
    });
    expect(addA.ok && addB.ok).toBe(true);
    if (!addA.ok || !addB.ok) return;
    await catalog.importSource(addA.value.id);
    await catalog.importSource(addB.value.id);

    const kids = await catalog.createProfile?.({
      name: 'Kids',
      isKids: true,
      avatarToken: 'emerald',
    });
    expect(kids?.ok).toBe(true);
    if (!kids?.ok) return;
    await catalog.setSourceExcludedProfiles?.(addA.value.id, [kids.value.id]);

    const videoHost: VideoHost = {
      open: () => ({
        engine: createFakePlayerEngine({
          now: () => performance.now(),
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        }),
        overlayMode: 'floating',
        renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
      }),
    };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders
          i18n={createAppI18n('en')}
          viewport={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
        >
          <AppShell catalog={catalog} videoHost={videoHost} />
        </AppProviders>,
      );

      // Adult (default) profile sees Source A on Home and BOTH sources' categories in Live -> Channels
      await waitFor(() => {
        expect(screen.getByTestId('profile-picker-close')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('profile-picker-close'));

      await waitFor(() => {
        expect(screen.getByText('Source A News')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => expect(screen.getByTestId('live-screen')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('live-mode-channels'));
      await waitFor(() => {
        expect(screen.getByText(/Adult News/)).toBeTruthy();
        expect(screen.getByText(/Kids Cartoons/)).toBeTruthy();
      });

      // Switch to Kids profile via top-right avatar utility menu
      await fireEvent.press(screen.getByTestId('nav-utility-profile'));
      await waitFor(() =>
        expect(screen.getByTestId(`profile-menu-item-${kids.value.id}`)).toBeTruthy(),
      );
      await fireEvent.press(screen.getByTestId(`profile-menu-item-${kids.value.id}`));

      // Kids profile resets live sub-mode on switch; opening Channels hides Source A while keeping Source B visible
      await waitFor(() => expect(screen.getByTestId('live-mode-channels')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('live-mode-channels'));
      await waitFor(() => {
        expect(screen.queryByText(/Adult News/)).toBeNull();
        expect(screen.queryByText('Source A News')).toBeNull();
        expect(screen.getByText('Source B Cartoons')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('nav-tab-home'));
      await waitFor(() => {
        expect(screen.queryByText('Source A News')).toBeNull();
        expect(screen.getByText('Source B Cartoons')).toBeTruthy();
      });

      // Settings -> Sources STILL lists BOTH Source A and Source B so adults can manage sharing
      await fireEvent.press(screen.getByTestId('nav-utility-profile'));
      await fireEvent.press(screen.getByTestId('profile-menu-settings'));
      await waitFor(() => expect(screen.getByTestId('settings-tab-sources')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('settings-tab-sources'));
      await waitFor(() => {
        expect(screen.getByTestId(`source-row-${addA.value.id}`)).toBeTruthy();
        expect(screen.getByTestId(`source-row-${addB.value.id}`)).toBeTruthy();
      });
    } finally {
      await view?.unmount();
      await catalog.close();
      handle.close();
    }
  });

  it('passes i18n.locale as fallbackLocale into resolveInitialTrackSelection in PlayerScreen', async () => {
    let nowMs = 1_000;
    const engine = createFakePlayerEngine({
      now: () => nowMs,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const selectSubtitleSpy = jest.spyOn(engine, 'selectSubtitleTrack');
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'floating',
        renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
      }),
    };
    const catalog: PlayerScreenProps['catalog'] = {
      resolveStream: jest.fn(async () => ok({ url: 'http://127.0.0.1/film.mp4', headers: {} })),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok(undefined as never)),
    };

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <ViewportProvider
          value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 720 }}
        >
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('tr')}>
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={{
                  itemKey: 'x:s1:movie:77',
                  sourceId: 's1',
                  title: 'English Film',
                  kind: 'vod',
                  itemKind: 'movie',
                }}
                clock={{ now: () => nowMs }}
                preferredAudioLanguages={[]}
                preferredSubtitleLanguages={[]}
                subtitleMode="smart"
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;

    await act(async () => {
      nowMs += 100;
      engine.emit({
        attempt,
        type: 'tracks',
        tracks: {
          audio: [{ id: 'a-en', language: 'eng', label: 'English', isDefault: true }],
          subtitles: [
            { id: 's-en', language: 'eng', label: 'English' },
            { id: 's-tr', language: 'tur', label: 'Türkçe' },
          ],
          selectedAudioId: 'a-en',
          selectedSubtitleId: null,
        },
      });
    });

    // Empty preferred languages + Turkish UI locale + smart subtitle mode -> auto-selects Turkish subtitle on English audio
    await waitFor(() => {
      expect(selectSubtitleSpy).toHaveBeenCalledWith(attempt, 's-tr');
    });

    await view.unmount();
  });

  it('stops active playback immediately in createObservedCatalog when setSourceExcludedProfiles hides a source from activeProfileId', async () => {
    const stopForSource = jest.fn();
    const playbackGuard = createPlaybackGuard(stopForSource);
    const syncSourcesAndBump = jest.fn(async () => undefined);
    const onUserStateMutated = jest.fn();
    let activeProfileId = 'kids';

    const setSourceExcludedProfiles = jest.fn(
      async (sourceId: string, excludedProfileIds: readonly string[]) =>
        ok({
          id: sourceId,
          kind: 'm3u',
          name: 'Source A',
          createdAt: 1,
          needsImport: false,
          excludedProfileIds,
        } as SourceRow),
    );

    const base = {
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      listSources: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      seasons: jest.fn(async () => ok([])),
      episodes: jest.fn(async () => []),
      resolveStream: jest.fn(),
      setSourceExcludedProfiles,
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const observed = createObservedCatalog(
      base,
      playbackGuard,
      syncSourcesAndBump,
      onUserStateMutated,
      () => activeProfileId,
    );

    // Excluding another profile does NOT stop active playback
    await observed.setSourceExcludedProfiles?.('src-1', ['other-profile']);
    expect(stopForSource).not.toHaveBeenCalled();

    // Excluding the active profile immediately calls stopIfUsingSource('src-1')
    await observed.setSourceExcludedProfiles?.('src-1', ['kids']);
    expect(stopForSource).toHaveBeenCalledTimes(1);
    expect(stopForSource).toHaveBeenCalledWith('src-1');
    expect(syncSourcesAndBump).toHaveBeenCalledTimes(2);
    expect(onUserStateMutated).toHaveBeenCalledTimes(2);

    // Changing activeProfileId dynamically uses the latest profile
    activeProfileId = 'adult';
    await observed.setSourceExcludedProfiles?.('src-2', ['adult']);
    expect(stopForSource).toHaveBeenCalledWith('src-2');
  });
});
