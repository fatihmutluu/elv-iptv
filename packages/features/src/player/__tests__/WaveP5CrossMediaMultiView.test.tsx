import type { CatalogService, EpisodeRow, ItemRow, SourceRow } from '@elv/data';
import { type DownloadManagerPort, type DownloadRecord, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createConnectionTracker } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { DownloadsProvider } from '../../shared';
import { MultiViewChannelPicker } from '../MultiViewChannelPicker';
import { MultiViewStage } from '../MultiViewStage';
import { PlayerScreen } from '../PlayerScreen';

const SOURCE_SINGLE_CONN: SourceRow = {
  id: 'src-1',
  kind: 'xtream',
  name: 'SingleConn Provider',
  createdAt: 1_000,
  needsImport: false,
  accountMeta: { maxConnections: 1 },
};

function makeFakeEngine() {
  return createFakePlayerEngine({
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
}

const LIVE_ITEM: ItemRow = {
  id: 1,
  key: 'src-1:live:101',
  kind: 'live',
  sourceId: 'src-1',
  providerId: '101',
  name: 'News Live HD',
  logo: null,
  num: 1,
  year: null,
  rating: null,
};

const MOVIE_ITEM: ItemRow = {
  id: 2,
  key: 'src-1:movie:201',
  kind: 'movie',
  sourceId: 'src-1',
  providerId: '201',
  name: 'Solar Horizon',
  logo: null,
  num: null,
  year: 2026,
  rating: 8.4,
};

const SERIES_ITEM: ItemRow = {
  id: 30,
  key: 'src-1:series:301',
  kind: 'series',
  sourceId: 'src-1',
  providerId: '301',
  name: 'Northern Signal',
  logo: null,
  num: null,
  year: 2025,
  rating: 8.9,
};

const SERIES_EPISODE: EpisodeRow = {
  id: 301,
  key: 'src-1:episode:3011',
  season: 1,
  episode: 2,
  title: 'Cold Broadcast',
  durationSec: 2700,
};

const COMPLETED_DOWNLOAD: DownloadRecord = {
  id: 'dl-1',
  profileId: 'default',
  sourceId: 'src-1',
  itemKey: 'src-1:episode:9991',
  kind: 'episode',
  title: 'Night Signal',
  seriesTitle: 'Northern Signal',
  season: 1,
  episodeNum: 1,
  poster: 'https://cdn.example/poster.jpg',
  localFileName: 'night-signal.mp4',
  localUri: 'file:///app-downloads/night-signal.mp4',
  bytesDownloaded: 150_000_000,
  totalBytes: 150_000_000,
  status: 'completed',
  createdAt: 1_000,
  updatedAt: 2_000,
  completedAt: 2_000,
};

function createFakeDownloadManager(records: readonly DownloadRecord[]): DownloadManagerPort {
  return {
    supported: true,
    list: async () => records,
    get: async (itemKey) => records.find((r) => r.itemKey === itemKey) ?? null,
    subscribe: () => () => undefined,
    enqueue: async () => ok(records[0] ?? COMPLETED_DOWNLOAD),
    pause: async () => ok(undefined),
    resume: async () => ok(undefined),
    cancel: async () => ok(undefined),
    remove: async () => ok(undefined),
  };
}

function createCrossMediaCatalog() {
  const resolveStream = jest.fn(async (itemKey: string) =>
    ok({
      url: `https://stream.example/${encodeURIComponent(itemKey)}.m3u8`,
      headers: {},
      sourceId: 'src-1',
      accountKey: 'src-1',
      maxConnections: 1,
    }),
  );
  const catalog: Pick<
    CatalogService,
    'resolveStream' | 'categories' | 'items' | 'allSourcesItems' | 'getProgress' | 'saveProgress'
  > &
    Partial<Pick<CatalogService, 'seasons' | 'episodes' | 'itemDetail'>> = {
    resolveStream,
    getProgress: async () => null,
    saveProgress: async (input) =>
      ok({
        profileId: 'default',
        itemKey: input.itemKey,
        sourceId: input.sourceId,
        kind: input.kind,
        title: input.title,
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: input.positionMs,
        durationMs: input.durationMs,
        updatedAt: 0,
        watched: false,
      }),
    categories: async () => [],
    items: async () => [],
    allSourcesItems: async (kind) => {
      if (kind === 'live') return [LIVE_ITEM];
      if (kind === 'movie') return [MOVIE_ITEM];
      return [SERIES_ITEM];
    },
    seasons: async (seriesId) =>
      seriesId === SERIES_ITEM.id ? ok([{ season: 1, episodeCount: 1 }]) : ok([]),
    episodes: async (seriesId, season) =>
      seriesId === SERIES_ITEM.id && season === 1 ? [SERIES_EPISODE] : [],
  };
  return { catalog, resolveStream };
}

function wrap(node: ReactNode, downloads: readonly DownloadRecord[] = [COMPLETED_DOWNLOAD]) {
  const i18n = createAppI18n('en');
  return (
    <ThemeProvider>
      <FormFactorProvider value="desktop">
        <ViewportProvider
          value={{
            width: 1280,
            height: 720,
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
          }}
        >
          <I18nProvider i18n={i18n}>
            <DownloadsProvider manager={createFakeDownloadManager(downloads)}>
              {node}
            </DownloadsProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>
    </ThemeProvider>
  );
}

describe('Wave P5 — Cross-Media Multi-View & Offline Downloads Picker', () => {
  it('enables Multi-View entry from Live TV, Movies, and Series Episodes and plays offline downloads without resolveStream', async () => {
    const targets: readonly PlayTarget[] = [
      {
        itemKey: LIVE_ITEM.key,
        sourceId: 'src-1',
        title: LIVE_ITEM.name,
        kind: 'live',
        itemKind: 'live',
      },
      {
        itemKey: MOVIE_ITEM.key,
        sourceId: 'src-1',
        title: MOVIE_ITEM.name,
        kind: 'vod',
        itemKind: 'movie',
      },
      {
        itemKey: COMPLETED_DOWNLOAD.itemKey,
        sourceId: 'src-1',
        title: 'Northern Signal · S1E1 Night Signal',
        kind: 'vod',
        itemKind: 'episode',
        isLocalOffline: true,
        localFileUri: COMPLETED_DOWNLOAD.localUri,
      },
    ];

    for (const target of targets) {
      const { catalog, resolveStream } = createCrossMediaCatalog();
      const engine = makeFakeEngine();
      const loadSpy = jest.spyOn(engine, 'load');
      const onEnterMultiView = jest.fn();
      const videoHost: VideoHost = {
        supportsMultiView: true,
        open: () => ({
          engine,
          renderSurface: ({ testID }) => <View testID={testID ?? 'player-surface'} />,
        }),
      };

      const view = await render(
        wrap(
          <PlayerScreen
            catalog={catalog as unknown as CatalogService}
            videoHost={videoHost}
            target={target}
            multiViewSupported
            onEnterMultiView={onEnterMultiView}
            onExit={jest.fn()}
          />,
        ),
      );

      await waitFor(() => expect(screen.getByTestId('player-settings-button')).toBeTruthy());
      expect(screen.queryByTestId('player-multiview-button')).toBeNull();

      // Overflow settings menu exposes Multi-View on VOD as well as Live TV
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      await waitFor(() => expect(screen.getByTestId('player-settings-multiview')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('player-settings-multiview'));
      expect(onEnterMultiView).toHaveBeenCalledWith(target);

      if (target.isLocalOffline === true) {
        await waitFor(() => expect(loadSpy).toHaveBeenCalled());
        expect(resolveStream).not.toHaveBeenCalled();
        expect(loadSpy.mock.calls[0]?.[0].url).toBe(COMPLETED_DOWNLOAD.localUri);
      }

      await view.unmount();
    }
  });

  it('switches MultiViewChannelPicker across Live TV, Movies, Series (with episode drill-down), and Downloads', async () => {
    const { catalog } = createCrossMediaCatalog();
    const onSelect = jest.fn();
    const i18n = createAppI18n('en');

    const view = await render(
      wrap(
        <MultiViewChannelPicker
          visible
          title={i18n.t('multiview.picker.title')}
          catalog={catalog}
          sources={[SOURCE_SINGLE_CONN]}
          excludeItemKeys={new Set()}
          isTv={false}
          i18n={i18n}
          onSelect={onSelect}
          onClose={jest.fn()}
        />,
      ),
    );

    // 1. Live TV tab (default)
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    expect(screen.getByText('News Live HD')).toBeTruthy();

    // 2. Movies tab
    await fireEvent.press(screen.getByTestId('multiview-picker-tab-movie'));
    await waitFor(() => expect(screen.getByText('Solar Horizon')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: MOVIE_ITEM.key,
        kind: 'vod',
        itemKind: 'movie',
      }),
    );

    // 3. Series tab + episode drill-down + back button
    await fireEvent.press(screen.getByTestId('multiview-picker-tab-series'));
    await waitFor(() => expect(screen.getByText('Northern Signal')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-series-back')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText('Northern Signal · S1E2 Cold Broadcast')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: SERIES_EPISODE.key,
        kind: 'vod',
        itemKind: 'episode',
        seriesKey: SERIES_ITEM.key,
        season: 1,
        episode: 2,
      }),
    );

    // Back-to-Series returns to series list
    await fireEvent.press(screen.getByTestId('multiview-picker-series-back'));
    await waitFor(() => expect(screen.queryByTestId('multiview-picker-series-back')).toBeNull());

    // 4. Downloads tab shows hint banner, Offline badge, and returns isLocalOffline: true
    await fireEvent.press(screen.getByTestId('multiview-picker-tab-downloads'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-downloads-hint')).toBeTruthy());
    expect(screen.getByTestId('multiview-picker-offline-badge-0')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: COMPLETED_DOWNLOAD.itemKey,
        kind: 'vod',
        itemKind: 'episode',
        isLocalOffline: true,
        localFileUri: COMPLETED_DOWNLOAD.localUri,
      }),
    );

    await view.unmount();
  });

  it('pairs 1 Live TV tile + 1 Downloaded Episode on max_connections=1 with 0 extra slots and preserves offline VOD metadata on auto-solo exit', async () => {
    const { catalog, resolveStream } = createCrossMediaCatalog();
    const tracker = createConnectionTracker();
    const openedEngines: ReturnType<typeof createFakePlayerEngine>[] = [];
    const videoHost: VideoHost = {
      supportsMultiView: true,
      open: () => {
        const engine = makeFakeEngine();
        openedEngines.push(engine);
        return {
          engine,
          renderSurface: ({ testID }) => <View testID={testID ?? 'mv-surface'} />,
        };
      },
    };
    const onExit = jest.fn();
    const initialSeed: PlayableEntry = {
      itemKey: LIVE_ITEM.key,
      sourceId: 'src-1',
      title: LIVE_ITEM.name,
      kind: 'live',
      itemKind: 'live',
    };

    const view = await render(
      wrap(
        <MultiViewStage
          catalog={catalog}
          videoHost={videoHost}
          tracker={tracker}
          sources={[SOURCE_SINGLE_CONN]}
          initialSeed={initialSeed}
          onExit={onExit}
        />,
      ),
    );

    // Tile 0 (Live TV) mounts and consumes the single connection slot
    await waitFor(() => expect(screen.getByTestId('multiview-tile-0')).toBeTruthy());
    expect(tracker.activeCount('src-1')).toBe(1);
    expect(resolveStream).toHaveBeenCalledTimes(1);

    // Open picker -> Downloads tab -> add completed offline episode
    await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
    await fireEvent.press(screen.getByTestId('multiview-picker-tab-downloads'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));

    // Tile 1 mounts with zero connection-limit rejection and shows Offline badge
    await waitFor(() => expect(screen.getByTestId('multiview-tile-1')).toBeTruthy());
    expect(screen.queryByTestId('multiview-banner-connection-limit')).toBeNull();
    expect(screen.getByTestId('multiview-tile-offline-badge-1')).toBeTruthy();
    expect(tracker.activeCount('src-1')).toBe(1);
    // Offline tile loaded directly from localFileUri without calling catalog.resolveStream again
    expect(resolveStream).toHaveBeenCalledTimes(1);
    expect(openedEngines).toHaveLength(2);

    // Hover Tile 0 (Live TV) and close it -> auto-solo hands off Tile 1 (offline episode) to fullscreen PlayerScreen
    await act(async () => {
      fireEvent(screen.getByTestId('multiview-tile-0'), 'hoverIn');
    });
    await waitFor(() => expect(screen.getByTestId('multiview-tile-remove-btn-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-tile-remove-btn-0'));

    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    const [resumeTarget] = onExit.mock.calls[0] as [PlayTarget | null];
    expect(resumeTarget).toEqual(
      expect.objectContaining({
        itemKey: COMPLETED_DOWNLOAD.itemKey,
        kind: 'vod',
        itemKind: 'episode',
        isLocalOffline: true,
        localFileUri: COMPLETED_DOWNLOAD.localUri,
      }),
    );

    await view.unmount();
  });

  it('handles null season/episodeNum on downloaded episodes without rendering SnullEnull or spreading null', async () => {
    const nullMetaEpisode: DownloadRecord = {
      ...COMPLETED_DOWNLOAD,
      id: 'dl-null-meta',
      itemKey: 'src-1:episode:null-meta',
      title: 'Pilot',
      seriesTitle: 'Northern Signal',
      season: null,
      episodeNum: null,
    };
    const { catalog } = createCrossMediaCatalog();
    const onSelect = jest.fn();
    const i18n = createAppI18n('en');

    const view = await render(
      wrap(
        <MultiViewChannelPicker
          visible
          title={i18n.t('multiview.picker.title')}
          catalog={catalog}
          sources={[SOURCE_SINGLE_CONN]}
          excludeItemKeys={new Set()}
          isTv={false}
          i18n={i18n}
          onSelect={onSelect}
          onClose={jest.fn()}
        />,
        [nullMetaEpisode],
      ),
    );

    await fireEvent.press(screen.getByTestId('multiview-picker-tab-downloads'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    expect(screen.getByText('Northern Signal · Pilot')).toBeTruthy();
    expect(screen.queryByText(/null/i)).toBeNull();

    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    const entry = onSelect.mock.calls[0]?.[0] as PlayableEntry;
    expect(entry.title).toBe('Northern Signal · Pilot');
    expect('season' in entry).toBe(false);
    expect('episode' in entry).toBe(false);

    await view.unmount();
  });

  it('reports online stream active when offline-seeded MultiViewStage adds a Live TV tile', async () => {
    const { catalog } = createCrossMediaCatalog();
    const tracker = createConnectionTracker();
    const videoHost: VideoHost = {
      supportsMultiView: true,
      open: () => ({
        engine: makeFakeEngine(),
        renderSurface: ({ testID }) => <View testID={testID ?? 'mv-surface'} />,
      }),
    };
    const onOnlineStreamActiveChange = jest.fn();
    const offlineSeed: PlayableEntry = {
      itemKey: COMPLETED_DOWNLOAD.itemKey,
      sourceId: 'src-1',
      title: 'Night Signal',
      kind: 'vod',
      itemKind: 'episode',
      isLocalOffline: true,
      localFileUri: COMPLETED_DOWNLOAD.localUri,
    };

    const view = await render(
      wrap(
        <MultiViewStage
          catalog={catalog}
          videoHost={videoHost}
          tracker={tracker}
          sources={[SOURCE_SINGLE_CONN]}
          initialSeed={offlineSeed}
          onOnlineStreamActiveChange={onOnlineStreamActiveChange}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByTestId('multiview-tile-0')).toBeTruthy());
    await waitFor(() => expect(onOnlineStreamActiveChange).toHaveBeenLastCalledWith(false));

    await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));

    await waitFor(() => expect(screen.getByTestId('multiview-tile-1')).toBeTruthy());
    await waitFor(() => expect(onOnlineStreamActiveChange).toHaveBeenLastCalledWith(true));

    await view.unmount();
    expect(onOnlineStreamActiveChange).toHaveBeenLastCalledWith(false);
  });
});
