import type {
  CatalogService,
  CategoryRow,
  ElvItemEnrichment,
  ItemRow,
  MergedVodVariant,
  SourceRow,
} from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { CatalogDiscoveryScreen, DetailScreen, type DetailTarget, SearchScreen } from '../index';
import { DownloadsProvider } from '../shared';

const ELV_ON: ElvModePreferences = {
  ...DEFAULT_ELV_MODE_PREFERENCES,
  elvModeEnabled: true,
  elvTitleFormat: 'system_original',
};

const INCEPTION_ENRICHMENT: ElvItemEnrichment = {
  itemKey: 'x:s1:movie:1',
  sourceId: 's1',
  mediaType: 'movie',
  imdbId: 'tt1375666',
  confidence: 0.96,
  manualLock: false,
  title: {
    imdbId: 'tt1375666',
    mediaType: 'movie',
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
    synopses: {
      en: 'A skilled thief steals secrets from dreams.',
      tr: 'Rüyalardan sır çalan yetenekli bir hırsız.',
    },
    detailFetchedAt: 1000,
    updatedAt: 1000,
  },
};

function Providers({
  locale = 'tr',
  children,
}: {
  readonly locale?: 'en' | 'tr';
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
            <DownloadsProvider>{children}</DownloadsProvider>
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

describe('Wave E1 Feature Integration (#511)', () => {
  it('CatalogDiscoveryScreen deduplicates merged IMDb copies and substitutes clean IMDb poster + formatted title', async () => {
    const sources: SourceRow[] = [
      {
        id: 's1',
        kind: 'xtream',
        name: 'Provider A',
        createdAt: 1,
        needsImport: false,
      },
    ];
    const cat: CategoryRow = {
      id: 's1|movie|1',
      sourceId: 's1',
      kind: 'movie',
      name: 'Movies',
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
      getElvEnrichmentForKeys: jest.fn(async () => {
        return new Map<string, ElvItemEnrichment>([
          ['x:s1:movie:1', INCEPTION_ENRICHMENT],
          ['x:s1:movie:2', { ...INCEPTION_ENRICHMENT, itemKey: 'x:s1:movie:2' }],
        ]);
      }),
    });

    await render(
      <Providers locale="tr">
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
      expect(screen.getByText('Başlangıç (Inception)')).toBeTruthy();
    });
    expect(screen.queryByText('TR | INCEPTION 4K')).toBeNull();
    expect(screen.queryByText('EN | Inception 1080p')).toBeNull();
  });

  it('DetailScreen uses listMergedVodVersions with source attribution, verified resolution, fake-4K, and unreliable badges plus IMDb formatted title', async () => {
    const mergedVariants: MergedVodVariant[] = [
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        sourceName: 'Cinema Plus',
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
      {
        itemKey: 'x:s2:movie:9',
        sourceId: 's2',
        sourceName: 'Backup IPTV',
        rawTitle: 'Inception UHD',
        versionLabel: '4K',
        verifiedResolution: '1080p',
        actualVideoCodec: 'h264',
        actualAudioCodec: 'aac',
        isFake4k: true,
        failCount: 2,
        qualityRank: 40,
        score: -9750,
      },
    ];
    const listMergedVodVersions = jest.fn(async () => mergedVariants);
    const catalog = makeBaseCatalog({
      listMergedVodVersions,
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([['x:s1:movie:1', INCEPTION_ENRICHMENT]]),
      ),
      getElvTitleDetail: jest.fn(async () => INCEPTION_ENRICHMENT.title),
      itemDetail: jest.fn(async () => null),
      getProgress: jest.fn(async () => null),
      getRating: jest.fn(async () => null),
    });

    const target: DetailTarget = {
      kind: 'movie',
      itemKey: 'x:s1:movie:1',
      sourceId: 's1',
      title: 'TR | INCEPTION 4K',
      posterUri: 'https://iptv.example/raw.jpg',
      backdropUri: null,
      year: 2010,
      rating: 4.5,
    };

    await render(
      <Providers locale="en">
        <DetailScreen
          target={target}
          catalog={catalog}
          refreshToken={1}
          elvPreferences={{ ...ELV_ON, elvTitleFormat: 'original' }}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(listMergedVodVersions).toHaveBeenCalledWith('x:s1:movie:1');
      expect(screen.getByTestId('detail-title')).toHaveTextContent('Inception');
      expect(screen.getByTestId('detail-preplay-version')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('detail-preplay-version'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-preplay-version-source-0')).toHaveTextContent(
        'from Cinema Plus',
      );
      expect(screen.getByTestId('detail-preplay-version-verified-0')).toHaveTextContent(
        'Verified 4K',
      );
      expect(screen.getByTestId('detail-preplay-version-source-1')).toHaveTextContent(
        'from Backup IPTV',
      );
      expect(screen.getByTestId('detail-preplay-version-fake4k-1')).toHaveTextContent(
        'Actual 1080p (labeled 4K)',
      );
      expect(screen.getByTestId('detail-preplay-version-unreliable-1')).toHaveTextContent(
        'Unreliable',
      );
    });
  });

  it('SearchScreen applies ELV presentation to matched movies and series', async () => {
    const movieHit: ItemRow = {
      id: 1,
      key: 'x:s1:movie:1',
      sourceId: 's1',
      providerId: '1',
      kind: 'movie',
      name: 'TR | INCEPTION 4K',
      logo: 'https://iptv.example/raw.jpg',
      rating: 4.0,
      year: 2010,
      num: null,
    };
    const catalog = makeBaseCatalog({
      search: jest.fn(async () => ({
        live: [],
        epg: [],
        movies: [movieHit],
        series: [],
        episodes: [],
      })),
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([['x:s1:movie:1', INCEPTION_ENRICHMENT]]),
      ),
    });

    await render(
      <Providers locale="tr">
        <SearchScreen
          catalog={catalog}
          refreshToken={1}
          initialQuery="inception"
          elvPreferences={ELV_ON}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />
      </Providers>,
    );

    await waitFor(
      () => {
        expect(screen.getByText('Başlangıç (Inception)')).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });
});
