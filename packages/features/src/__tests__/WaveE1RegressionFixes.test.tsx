import type {
  CatalogService,
  CategoryRow,
  ElvItemEnrichment,
  EpisodeRow,
  ItemDetailRow,
  ItemRow,
  MergedVodVariant,
  SourceRow,
} from '@elv/data';
import {
  DEFAULT_ELV_MODE_PREFERENCES,
  type DownloadManagerPort,
  type ElvModePreferences,
  ok,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { CatalogDiscoveryScreen, DetailScreen, type DetailTarget, SearchScreen } from '../index';
import { DownloadsProvider } from '../shared';

const ELV_ON: ElvModePreferences = {
  ...DEFAULT_ELV_MODE_PREFERENCES,
  elvModeEnabled: true,
  elvTitleFormat: 'original',
};

const INCEPTION_TITLE = {
  imdbId: 'tt1375666',
  mediaType: 'movie' as const,
  originalTitle: 'Inception',
  englishTitle: 'Inception',
  localizedTitles: { tr: 'Başlangıç' },
  year: 2010,
  rating: 8.8,
  votes: 2_500_000,
  runtimeMin: 148,
  genres: ['Action', 'Sci-Fi'],
  posterUrl: 'https://imdb.example/inception_clean.jpg',
  backdropUrl: 'https://imdb.example/inception_backdrop.jpg',
  trailerStreamUrl: null,
  trailerYoutubeId: null,
  director: 'Christopher Nolan',
  cast: [],
  mltImdbIds: [],
  franchiseKey: null,
  franchiseName: null,
  franchiseOrder: null,
  synopses: { en: 'A skilled thief steals secrets from dreams.' },
  detailFetchedAt: 1000,
  updatedAt: 1000,
};

const INCEPTION_ENRICHMENT: ElvItemEnrichment = {
  itemKey: 'x:s1:movie:1',
  sourceId: 's1',
  mediaType: 'movie',
  imdbId: 'tt1375666',
  confidence: 0.96,
  manualLock: false,
  title: INCEPTION_TITLE,
};

function collectRenderedImageUris(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectRenderedImageUris(child, out);
    return out;
  }
  const rec = node as { props?: { source?: { uri?: unknown } }; children?: unknown };
  if (typeof rec.props?.source?.uri === 'string') out.push(rec.props.source.uri);
  if (rec.children !== undefined) collectRenderedImageUris(rec.children, out);
  return out;
}

function Providers({
  locale = 'en',
  downloadManager,
  catalog,
  children,
}: {
  readonly locale?: 'en' | 'tr';
  readonly downloadManager?: DownloadManagerPort;
  readonly catalog?: CatalogService;
  readonly children: ReactElement;
}): ReactElement {
  const i18n = createAppI18n(locale);
  return (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <DownloadsProvider
              {...(downloadManager !== undefined ? { manager: downloadManager } : {})}
              {...(catalog !== undefined ? { catalog } : {})}
            >
              {children}
            </DownloadsProvider>
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

function makeBaseCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
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
    close: jest.fn(async () => undefined),
    listContinueWatching: jest.fn(async () => []),
    listProgressByKeys: jest.fn(async () => []),
    listFavoriteKeys: jest.fn(async () => []),
    listRatingMap: jest.fn(async () => ({})),
    ...overrides,
  } as unknown as CatalogService;
}

describe('Wave E1 Regression Fixes (P1-5, P1-6, P1-11, P2 #511)', () => {
  it('suppresses raw IPTV poster until local getElvEnrichmentForKeys resolves in CatalogDiscoveryScreen (P1-5)', async () => {
    const sources: SourceRow[] = [
      { id: 's1', kind: 'xtream', name: 'Provider A', createdAt: 1, needsImport: false },
    ];
    const cat: CategoryRow = {
      id: 's1|movie|1',
      sourceId: 's1',
      kind: 'movie',
      name: 'Movies',
      position: 0,
      itemCount: 1,
    };
    const items: ItemRow[] = [
      {
        id: 1,
        key: 'x:s1:movie:1',
        sourceId: 's1',
        providerId: '1',
        kind: 'movie',
        name: 'TR | INCEPTION 4K',
        logo: 'https://iptv.example/throwaway-raw.jpg',
        rating: 4.5,
        year: 2010,
        num: null,
      },
    ];
    let resolveLookup!: (map: Map<string, ElvItemEnrichment>) => void;
    const getElvEnrichmentForKeys = jest.fn(
      () =>
        new Promise<Map<string, ElvItemEnrichment>>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const catalog = makeBaseCatalog({
      categories: jest.fn(async () => [cat]),
      items: jest.fn(async () => items),
      getElvEnrichmentForKeys,
    });

    const view = await render(
      <Providers locale="en">
        <CatalogDiscoveryScreen
          kind="movie"
          catalog={catalog}
          sources={sources}
          refreshToken={1}
          elvPreferences={ELV_ON}
          onOpenDetail={jest.fn()}
          onOpenSources={jest.fn()}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(getElvEnrichmentForKeys).toHaveBeenCalledWith(['x:s1:movie:1']);
    });

    expect(collectRenderedImageUris(view.toJSON())).not.toContain(
      'https://iptv.example/throwaway-raw.jpg',
    );

    await act(async () => {
      resolveLookup(new Map([['x:s1:movie:1', INCEPTION_ENRICHMENT]]));
    });

    await waitFor(() => {
      const urisAfter = collectRenderedImageUris(view.toJSON());
      expect(urisAfter).toContain('https://imdb.example/inception_clean.jpg');
      expect(urisAfter).not.toContain('https://iptv.example/throwaway-raw.jpg');
    });
  });

  it('SearchScreen queries searchElvItemKeysByAlias and hydrates "La Casa de Papel" when searching "Money Heist" (P1-6)', async () => {
    const laCasaEnrichment: ElvItemEnrichment = {
      itemKey: 'x:s1:series:42',
      sourceId: 's1',
      mediaType: 'series',
      imdbId: 'tt6468322',
      confidence: 0.98,
      manualLock: false,
      title: {
        ...INCEPTION_TITLE,
        imdbId: 'tt6468322',
        mediaType: 'series',
        originalTitle: 'La Casa de Papel',
        englishTitle: 'Money Heist',
        localizedTitles: { en: 'Money Heist', tr: 'La Casa de Papel' },
        posterUrl: 'https://imdb.example/lacasa_clean.jpg',
      },
    };
    const laCasaDetail: ItemDetailRow = {
      id: 42,
      key: 'x:s1:series:42',
      sourceId: 's1',
      providerId: '42',
      kind: 'series',
      name: 'ES | La Casa de Papel 4K',
      logo: 'https://iptv.example/lacasa_raw.jpg',
      rating: 8.2,
      year: 2017,
      num: null,
      plot: null,
      cast: null,
      director: null,
    };
    const searchElvItemKeysByAlias = jest.fn(async () => ['x:s1:series:42']);
    const itemDetail = jest.fn(async (key: string) =>
      key === 'x:s1:series:42' ? laCasaDetail : null,
    );
    const catalog = makeBaseCatalog({
      search: jest.fn(async () => ({
        live: [],
        epg: [],
        movies: [],
        series: [],
        episodes: [],
      })),
      searchElvItemKeysByAlias,
      itemDetail,
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([['x:s1:series:42', laCasaEnrichment]]),
      ),
    });

    await render(
      <Providers locale="en">
        <SearchScreen
          catalog={catalog}
          refreshToken={1}
          initialQuery="Money Heist"
          elvPreferences={ELV_ON}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />
      </Providers>,
    );

    await waitFor(
      () => {
        expect(searchElvItemKeysByAlias).toHaveBeenCalledWith('Money Heist', { limit: 40 });
        expect(itemDetail).toHaveBeenCalledWith('x:s1:series:42');
        expect(screen.getByText('La Casa de Papel')).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it('DetailScreen uses activeVersion.sourceId when downloading a merged movie from Source B (P1-11)', async () => {
    const mergedVariants: MergedVodVariant[] = [
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        sourceName: 'Source A',
        rawTitle: 'Inception 1080p',
        versionLabel: '1080p',
        verifiedResolution: '1080p',
        actualVideoCodec: 'h264',
        actualAudioCodec: 'aac',
        isFake4k: false,
        failCount: 0,
        qualityRank: 30,
        score: 800,
      },
      {
        itemKey: 'x:s2:movie:9',
        sourceId: 's2',
        sourceName: 'Source B',
        rawTitle: 'Inception 4K',
        versionLabel: '4K',
        verifiedResolution: '4K',
        actualVideoCodec: 'hevc',
        actualAudioCodec: 'aac',
        isFake4k: false,
        failCount: 0,
        qualityRank: 40,
        score: 1005,
      },
    ];
    const enqueue = jest.fn(async (input) =>
      ok({
        id: 'dl-1',
        profileId: 'default',
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        status: 'queued' as const,
        bytesDownloaded: 0,
        totalBytes: 100,
        localFileName: 'dl.mp4',
        localUri: 'file:///dl.mp4',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const downloadManager: DownloadManagerPort = {
      supported: true,
      list: jest.fn(async () => []),
      get: jest.fn(async () => null),
      enqueue,
      pause: jest.fn(async () => ok(undefined)),
      resume: jest.fn(async () => ok(undefined)),
      cancel: jest.fn(async () => ok(undefined)),
      remove: jest.fn(async () => ok(undefined)),
      subscribe: jest.fn(() => () => undefined),
      notifyOnlinePlaybackActive: jest.fn(),
    };
    const catalog = makeBaseCatalog({
      listMergedVodVersions: jest.fn(async () => mergedVariants),
      resolveStream: jest.fn(async () =>
        ok({ url: 'https://source-b.invalid/movie.mp4', headers: {} }),
      ),
      itemDetail: jest.fn(async () => null),
      getProgress: jest.fn(async () => null),
      getRating: jest.fn(async () => null),
    });

    const target: DetailTarget = {
      kind: 'movie',
      itemKey: 'x:s1:movie:1',
      sourceId: 's1',
      title: 'Inception',
      posterUri: 'https://iptv.example/raw.jpg',
      backdropUri: null,
      year: 2010,
      rating: 8.8,
    };

    await render(
      <Providers locale="en" downloadManager={downloadManager} catalog={catalog}>
        <DetailScreen
          target={target}
          catalog={catalog}
          refreshToken={1}
          elvPreferences={{ ...ELV_ON, elvEnrichMetadata: false }}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-preplay-version')).toBeTruthy();
      expect(screen.getByTestId('detail-download')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('detail-preplay-version'));
    await fireEvent.press(screen.getByTestId('detail-preplay-version-option-1'));
    await fireEvent.press(screen.getByTestId('detail-download'));

    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 's2',
          itemKey: 'x:s2:movie:9',
        }),
      );
    });
  });

  it('DetailScreen reloads seasons & episodes and plays from selected source when switching multi-source series version (P1-11)', async () => {
    const mergedSeriesVersions: MergedVodVariant[] = [
      {
        itemKey: 'x:s1:series:10',
        sourceId: 's1',
        sourceName: 'Source A',
        rawTitle: 'Dark (Source A)',
        versionLabel: '1080p',
        verifiedResolution: '1080p',
        actualVideoCodec: 'h264',
        actualAudioCodec: 'aac',
        isFake4k: false,
        failCount: 0,
        qualityRank: 30,
        score: 800,
      },
      {
        itemKey: 'x:s2:series:99',
        sourceId: 's2',
        sourceName: 'Source B',
        rawTitle: 'Dark (Source B)',
        versionLabel: '4K',
        verifiedResolution: '4K',
        actualVideoCodec: 'hevc',
        actualAudioCodec: 'aac',
        isFake4k: false,
        failCount: 0,
        qualityRank: 40,
        score: 1005,
      },
    ];
    const epA: EpisodeRow = {
      id: 101,
      key: 'x:s1:ep:101',
      season: 1,
      episode: 1,
      title: 'Source A Pilot',
      durationSec: 3000,
    };
    const epB: EpisodeRow = {
      id: 991,
      key: 'x:s2:ep:991',
      season: 1,
      episode: 1,
      title: 'Source B Pilot',
      durationSec: 3200,
    };
    const seasons = jest.fn(async () => ok([{ season: 1, episodeCount: 1 }]));
    const episodes = jest.fn(async (seriesId: number) => (seriesId === 99 ? [epB] : [epA]));
    const itemDetail = jest.fn(async (key: string): Promise<ItemDetailRow | null> => {
      if (key === 'x:s2:series:99') {
        return {
          id: 99,
          key: 'x:s2:series:99',
          sourceId: 's2',
          providerId: '99',
          kind: 'series',
          name: 'Dark (Source B)',
          logo: null,
          rating: 8.7,
          year: 2017,
          num: null,
          plot: null,
          cast: null,
          director: null,
        };
      }
      return null;
    });
    const catalog = makeBaseCatalog({
      listMergedVodVersions: jest.fn(async () => mergedSeriesVersions),
      seasons,
      episodes,
      itemDetail,
      getRating: jest.fn(async () => null),
    });
    const onPlay = jest.fn();

    const target: DetailTarget = {
      kind: 'series',
      itemKey: 'x:s1:series:10',
      sourceId: 's1',
      catalogId: 10,
      title: 'Dark',
      posterUri: null,
      backdropUri: null,
      year: 2017,
      rating: 8.7,
    };

    await render(
      <Providers locale="en">
        <DetailScreen
          target={target}
          catalog={catalog}
          refreshToken={1}
          elvPreferences={{ ...ELV_ON, elvEnrichMetadata: false }}
          onBack={jest.fn()}
          onPlay={onPlay}
          onOpenDetail={jest.fn()}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Source A Pilot/)).toBeTruthy();
      expect(screen.getByTestId('detail-preplay-version')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('detail-preplay-version'));
    await fireEvent.press(screen.getByTestId('detail-preplay-version-option-1'));

    await waitFor(() => {
      expect(itemDetail).toHaveBeenCalledWith('x:s2:series:99');
      expect(seasons).toHaveBeenCalledWith(99);
      expect(episodes).toHaveBeenCalledWith(99, 1);
      expect(screen.getByText(/Source B Pilot/)).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('detail-play'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:s2:ep:991',
        sourceId: 's2',
        seriesKey: 'x:s2:series:99',
      }),
    );
  });

  it('CategoryGridView deduplicates merged IMDb copies when elvModeEnabled && elvMergeVersions is true (P2)', async () => {
    const sources: SourceRow[] = [
      { id: 's1', kind: 'xtream', name: 'Provider A', createdAt: 1, needsImport: false },
    ];
    const cat: CategoryRow = {
      id: 's1|movie|1',
      sourceId: 's1',
      kind: 'movie',
      name: 'Sci-Fi',
      position: 0,
      itemCount: 2,
    };
    const items: ItemRow[] = [
      {
        id: 1,
        key: 'x:s1:movie:1',
        sourceId: 's1',
        providerId: '1',
        kind: 'movie',
        name: 'TR | INCEPTION 4K',
        logo: 'https://iptv.example/raw1.jpg',
        rating: 4.5,
        year: 2010,
        num: null,
      },
      {
        id: 2,
        key: 'x:s1:movie:2',
        sourceId: 's1',
        providerId: '2',
        kind: 'movie',
        name: 'EN | Inception 1080p',
        logo: 'https://iptv.example/raw2.jpg',
        rating: 4.5,
        year: 2010,
        num: null,
      },
    ];
    const catalog = makeBaseCatalog({
      categories: jest.fn(async () => [cat]),
      items: jest.fn(async () => items),
      getElvEnrichmentForKeys: jest.fn(
        async () =>
          new Map<string, ElvItemEnrichment>([
            ['x:s1:movie:1', INCEPTION_ENRICHMENT],
            ['x:s1:movie:2', { ...INCEPTION_ENRICHMENT, itemKey: 'x:s1:movie:2' }],
          ]),
      ),
    });

    await render(
      <Providers locale="en">
        <CatalogDiscoveryScreen
          kind="movie"
          catalog={catalog}
          sources={sources}
          refreshToken={1}
          memory={{ selectedCategoryId: 's1|movie|1', visibleCategoryCount: 6 }}
          elvPreferences={ELV_ON}
          onOpenDetail={jest.fn()}
          onOpenSources={jest.fn()}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid')).toBeTruthy();
      expect(screen.getByTestId('catalog-grid-item-0')).toBeTruthy();
      expect(screen.getByText('Inception')).toBeTruthy();
    });
    expect(screen.queryByTestId('catalog-grid-item-1')).toBeNull();
  });
});
