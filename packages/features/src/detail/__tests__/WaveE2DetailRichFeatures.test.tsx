import type {
  CatalogService,
  ElvFranchiseLibraryItem,
  ElvItemEnrichment,
  ElvPersonLibraryItem,
  ElvTitleRecord,
} from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { TrailerExternalPort } from '../../ports/trailer-port';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import type { DetailTarget } from '../../shared';
import { DetailScreen } from '../DetailScreen';

const ELV_ON: ElvModePreferences = {
  ...DEFAULT_ELV_MODE_PREFERENCES,
  elvModeEnabled: true,
  elvEnrichMetadata: true,
  elvMergeVersions: true,
};

const MOVIE_TARGET: DetailTarget = {
  kind: 'movie',
  sourceId: 'src-1',
  itemKey: 'x:src-1:movie:1',
  title: 'Raw Dune 4K',
  posterUri: 'https://provider.invalid/raw.jpg',
  backdropUri: 'https://provider.invalid/raw.jpg',
  year: 2021,
  rating: 7.5,
};

function makeTitleRecord(overrides: Partial<ElvTitleRecord> = {}): ElvTitleRecord {
  return {
    imdbId: 'tt1160419',
    mediaType: 'movie',
    originalTitle: 'Dune',
    englishTitle: 'Dune',
    localizedTitles: { tr: 'Dune: Çöl Gezegeni' },
    year: 2021,
    rating: 8.0,
    votes: 850_000,
    runtimeMin: 155,
    genres: ['Sci-Fi', 'Adventure'],
    posterUrl: 'https://imdb.invalid/dune-poster.jpg',
    backdropUrl: 'https://imdb.invalid/dune-backdrop.jpg',
    trailerStreamUrl: 'https://imdb-video.media-imdb.com/vi123/dune.mp4',
    trailerYoutubeId: '8g18jFHCLXk',
    director: 'Denis Villeneuve',
    cast: [
      {
        personId: 'nm3154303',
        name: 'Timothée Chalamet',
        character: 'Paul Atreides',
        portraitUrl: 'https://imdb.invalid/timothee.jpg',
      },
      {
        personId: 'nm0272581',
        name: 'Rebecca Ferguson',
        character: 'Lady Jessica',
        portraitUrl: null,
      },
    ],
    mltImdbIds: [],
    franchiseKey: 'dune',
    franchiseName: 'Dune',
    franchiseOrder: 1,
    synopses: {
      en: 'A noble family becomes embroiled in a war for control over Arrakis.',
      tr: 'Soylu bir aile Arrakis için verilen savaşın ortasında kalır.',
    },
    detailFetchedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeFakeVideoHost(): {
  videoHost: VideoHost;
  loadMock: jest.Mock;
  stopMock: jest.Mock;
  releaseMock: jest.Mock;
} {
  const loadMock = jest.fn();
  const stopMock = jest.fn();
  const releaseMock = jest.fn();
  const opened: OpenVideoEngine = {
    engine: {
      capabilities: {
        mpegTsOverHttp: true,
        hls: true,
        liveSeek: false,
        softwareAudioFallback: false,
        recreate: false,
        audioTrackSelection: false,
        subtitleTrackSelection: false,
      },
      load: loadMock,
      retry: jest.fn(),
      play: jest.fn(),
      pause: jest.fn(),
      seek: jest.fn(),
      stop: stopMock,
      recreate: jest.fn(),
      release: releaseMock,
      subscribe: jest.fn(() => () => undefined),
    },
    renderSurface: (props) => <View testID={props.testID ?? 'trailer-surface'} />,
  };
  return {
    videoHost: { open: jest.fn(() => opened) },
    loadMock,
    stopMock,
    releaseMock,
  };
}

describe('Wave E2 Rich Detail, Trailers, Cast Modal, Franchise Strip & Fix Match (#512)', () => {
  it('hydrates rich ELV metadata, opens PersonLibraryModal from director/cast, shows Franchise strip, and plays direct trailer without saving watch progress', async () => {
    const titleRec = makeTitleRecord();
    const enrichment: ElvItemEnrichment = {
      itemKey: MOVIE_TARGET.itemKey,
      sourceId: MOVIE_TARGET.sourceId,
      mediaType: 'movie',
      imdbId: titleRec.imdbId,
      confidence: 0.99,
      manualLock: false,
      title: titleRec,
    };
    const duneTwoItem = {
      id: 2,
      sourceId: 'src-1',
      kind: 'movie' as const,
      providerId: '2',
      key: 'x:src-1:movie:2',
      name: 'Dune: Part Two',
      num: null,
      logo: 'https://imdb.invalid/dune2.jpg',
      year: 2024,
      rating: 8.5,
    };
    const duneTwoEnrichment: ElvItemEnrichment = {
      ...enrichment,
      itemKey: 'x:src-1:movie:2',
      imdbId: 'tt15239678',
      title: makeTitleRecord({
        imdbId: 'tt15239678',
        originalTitle: 'Dune: Part Two',
        englishTitle: 'Dune: Part Two',
        year: 2024,
        rating: 8.5,
        franchiseOrder: 2,
      }),
    };
    const franchiseEntries: readonly ElvFranchiseLibraryItem[] = [
      {
        item: {
          id: 1,
          sourceId: 'src-1',
          kind: 'movie',
          providerId: '1',
          key: MOVIE_TARGET.itemKey,
          name: 'Dune',
          num: null,
          logo: titleRec.posterUrl,
          year: 2021,
          rating: 8.0,
        },
        enrichment,
        franchiseKey: 'dune',
        franchiseName: 'Dune',
        franchiseOrder: 1,
      },
      {
        item: duneTwoItem,
        enrichment: duneTwoEnrichment,
        franchiseKey: 'dune',
        franchiseName: 'Dune',
        franchiseOrder: 2,
      },
    ];
    const personEntries: readonly ElvPersonLibraryItem[] = [
      {
        item: duneTwoItem,
        enrichment: duneTwoEnrichment,
        role: 'cast',
        character: 'Paul Atreides',
      },
    ];
    const saveProgress = jest.fn();
    const catalog = {
      itemDetail: jest.fn(async () => null),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      saveProgress,
      itemVersions: jest.fn(async () => []),
      listMergedVodVersions: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([[MOVIE_TARGET.itemKey, enrichment]]),
      ),
      getElvTitleDetail: jest.fn(async () => titleRec),
      listElvFranchiseItems: jest.fn(async () => franchiseEntries),
      listElvPersonLibraryItems: jest.fn(async () => personEntries),
    } as unknown as CatalogService;

    const { videoHost, loadMock, releaseMock } = makeFakeVideoHost();
    const onOpenDetail = jest.fn();

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailScreen
              target={MOVIE_TARGET}
              catalog={catalog}
              videoHost={videoHost}
              refreshToken={1}
              elvPreferences={ELV_ON}
              onBack={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={onOpenDetail}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-votes')).toBeTruthy();
      expect(screen.getByTestId('detail-runtime')).toBeTruthy();
      expect(screen.getByTestId('detail-director-link')).toBeTruthy();
      expect(screen.queryByTestId('detail-hero-director')).toBeNull();
      expect(screen.getByTestId('detail-trailer')).toBeTruthy();
      expect(screen.getByTestId('detail-franchise-strip')).toBeTruthy();
    });

    expect(screen.getByText('850K votes')).toBeTruthy();
    expect(screen.getByText('155 min')).toBeTruthy();
    expect(screen.getByText('Timothée Chalamet')).toBeTruthy();
    expect(screen.getByText('Paul Atreides')).toBeTruthy();
    expect(screen.getByText('More in this series in your library')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();

    // Clicking franchise item opens its detail
    await fireEvent.press(screen.getByTestId('detail-franchise-item-1'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'x:src-1:movie:2', title: 'Dune: Part Two' }),
    );

    // Clicking cast member opens PersonLibraryModal
    await fireEvent.press(screen.getByTestId('detail-cast-item-0'));
    await waitFor(() => {
      expect(screen.getByTestId('person-library-modal')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('person-library-close'));

    // Clicking trailer opens DetailTrailerModal with direct stream via videoHost and zero saveProgress calls
    await fireEvent.press(screen.getByTestId('detail-trailer'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-trailer-modal')).toBeTruthy();
      expect(loadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://imdb-video.media-imdb.com/vi123/dune.mp4',
          kind: 'vod',
        }),
      );
    });
    expect(saveProgress).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('detail-trailer-close'));
    expect(releaseMock).toHaveBeenCalled();

    await view.unmount();
  });

  it('hands off YouTube trailer via TrailerExternalPort on 10-ft TV when no direct stream exists', async () => {
    const titleRec = makeTitleRecord({ trailerStreamUrl: null, trailerYoutubeId: '8g18jFHCLXk' });
    const enrichment: ElvItemEnrichment = {
      itemKey: MOVIE_TARGET.itemKey,
      sourceId: MOVIE_TARGET.sourceId,
      mediaType: 'movie',
      imdbId: titleRec.imdbId,
      confidence: 0.99,
      manualLock: false,
      title: titleRec,
    };
    const openExternalUrl = jest.fn(async () => true);
    const trailerExternal: TrailerExternalPort = { openExternalUrl };
    const catalog = {
      itemDetail: jest.fn(async () => null),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      itemVersions: jest.fn(async () => []),
      listMergedVodVersions: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([[MOVIE_TARGET.itemKey, enrichment]]),
      ),
      getElvTitleDetail: jest.fn(async () => titleRec),
      listElvFranchiseItems: jest.fn(async () => []),
    } as unknown as CatalogService;

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailScreen
              target={MOVIE_TARGET}
              catalog={catalog}
              trailerExternal={trailerExternal}
              refreshToken={1}
              elvPreferences={ELV_ON}
              onBack={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-trailer')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('detail-trailer'));
    await waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledWith('https://www.youtube.com/watch?v=8g18jFHCLXk');
    });

    await view.unmount();
  });

  it('declutters Detail hero (omits Fix Match, Enriched badge, and movie kind pill) and cleans unmatched titles locally offline', async () => {
    const applyElvFixMatch = jest.fn();
    const catalog = {
      itemDetail: jest.fn(async () => null),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      itemVersions: jest.fn(async () => []),
      listMergedVodVersions: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
      getElvEnrichmentForKeys: jest.fn(async () => new Map<string, ElvItemEnrichment>()),
      listElvFranchiseItems: jest.fn(async () => []),
      applyElvFixMatch,
    } as unknown as CatalogService;

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailScreen
              target={{
                ...MOVIE_TARGET,
                title: 'TR : INCEPTION [2010 - HEVC] 4K',
                posterUri: 'https://provider.invalid/poster.jpg',
                backdropUri: null,
                year: null,
              }}
              catalog={catalog}
              refreshToken={1}
              elvPreferences={ELV_ON}
              onBack={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-title')).toHaveTextContent('INCEPTION');
      expect(screen.getByTestId('detail-year')).toHaveTextContent('2010');
    });

    expect(screen.queryByTestId('detail-fix-match-btn')).toBeNull();
    expect(screen.queryByTestId('detail-fix-match-locked')).toBeNull();
    expect(screen.queryByTestId('detail-fix-match-modal')).toBeNull();
    expect(screen.queryByTestId('detail-enrichment-badge')).toBeNull();
    expect(screen.queryByTestId('detail-kind-pill')).toBeNull();
    expect(
      screen.getByTestId('detail-hero-backdrop-ambient', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.getByTestId('detail-hero-poster')).toBeTruthy();
    expect(
      screen.queryByTestId('detail-hero-backdrop', { includeHiddenElements: true }),
    ).toBeNull();

    await view.unmount();
  });

  it('splits co-director strings into individual clickable buttons and queries each name separately (P1 #7)', async () => {
    const titleRec = makeTitleRecord({ director: 'Joel Coen, Ethan Coen' });
    const enrichment: ElvItemEnrichment = {
      itemKey: MOVIE_TARGET.itemKey,
      sourceId: MOVIE_TARGET.sourceId,
      mediaType: 'movie',
      imdbId: titleRec.imdbId,
      confidence: 0.99,
      manualLock: false,
      title: titleRec,
    };
    const listElvPersonLibraryItems = jest.fn(async () => []);
    const catalog = {
      itemDetail: jest.fn(async () => null),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      itemVersions: jest.fn(async () => []),
      listMergedVodVersions: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([[MOVIE_TARGET.itemKey, enrichment]]),
      ),
      getElvTitleDetail: jest.fn(async () => titleRec),
      listElvFranchiseItems: jest.fn(async () => []),
      listElvPersonLibraryItems,
    } as unknown as CatalogService;

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailScreen
              target={MOVIE_TARGET}
              catalog={catalog}
              refreshToken={1}
              elvPreferences={ELV_ON}
              onBack={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-director-link')).toBeTruthy();
      expect(screen.getByTestId('detail-director-link-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-hero-director')).toBeNull();

    await fireEvent.press(screen.getByTestId('detail-director-link-1'));
    await waitFor(() => {
      expect(listElvPersonLibraryItems).toHaveBeenCalledWith({ name: 'Ethan Coen' });
    });

    await view.unmount();
  });
});
