import type { CatalogService, ElvItemEnrichment, ElvTitleRecord } from '@elv/data';
import { createMemoryPreferencesStore } from '@elv/domain';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { AppProviders, AppShell, DETAIL_TRAILER_AUTOPLAY_DELAY_MS } from '../index';
import type { VideoHost } from '../ports/video-host';

const SHORT_SYNOPSIS =
  'An experienced archivist uncovers a long-forgotten reel of broadcast footage beneath a coastal lighthouse and begins restoring its missing frames.';

function makeEnrichedTitle(itemKey: string): {
  title: ElvTitleRecord;
  enrichment: ElvItemEnrichment;
} {
  const title: ElvTitleRecord = {
    imdbId: 'tt9901001',
    mediaType: 'movie',
    originalTitle: 'Beacon Horizon',
    englishTitle: 'Beacon Horizon',
    localizedTitles: {},
    year: 2026,
    rating: 8.3,
    votes: 420_000,
    runtimeMin: 150,
    genres: ['Sci-Fi'],
    posterUrl: 'https://img.example/poster.jpg',
    backdropUrl: 'https://img.example/backdrop.jpg',
    trailerStreamUrl: 'https://cdn.example.com/trailers/beacon.mp4',
    trailerYoutubeId: null,
    director: 'Elena Vance',
    cast: [],
    mltImdbIds: [],
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    synopses: { en: SHORT_SYNOPSIS },
    detailFetchedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  return {
    title,
    enrichment: {
      itemKey,
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: title.imdbId,
      confidence: 0.99,
      manualLock: false,
      title,
    },
  };
}

describe('Wave R2-B AppShell Detail Trailer Mute Preference Wiring', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('wires detailTrailerMuted preference from AppShell through DetailScreen into DetailHeroTrailerPreview', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    jest.useFakeTimers();

    const { title: titleRec, enrichment } = makeEnrichedTitle('x:s1:movie:201');
    const prefStore = createMemoryPreferencesStore({
      elvModeEnabled: true,
      elvEnrichMetadata: true,
      detailTrailerMuted: true,
    });
    const catalog = {
      listSources: jest.fn(async () => [{ id: 's1', kind: 'xtream', name: 'Demo', createdAt: 1 }]),
      categories: jest.fn(async () => [
        { id: 's1|movie|10', name: 'Cinema', kind: 'movie', itemCount: 1 },
      ]),
      items: jest.fn(async () => [
        {
          id: 1,
          key: 'x:s1:movie:201',
          sourceId: 's1',
          providerId: '201',
          kind: 'movie',
          name: 'Beacon Horizon',
          num: null,
          logo: 'https://img.example/poster.jpg',
          year: 2026,
          rating: 8.3,
        },
      ]),
      itemDetail: jest.fn(async () => ({
        id: 1,
        key: 'x:s1:movie:201',
        sourceId: 's1',
        providerId: '201',
        kind: 'movie',
        name: 'Beacon Horizon',
        logo: 'https://img.example/backdrop.jpg',
        year: 2026,
        rating: 8.3,
        num: null,
        plot: SHORT_SYNOPSIS,
      })),
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([['x:s1:movie:201', enrichment]]),
      ),
      getElvTitleDetail: jest.fn(async () => titleRec),
      listElvFranchiseItems: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      itemVersions: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
      listCollections: jest.fn(async () => []),
      getDismissedRecommendationKeys: jest.fn(async () => []),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

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

    const view = await render(
      <AppProviders
        preferencesStore={prefStore}
        viewport={{ width: 1280, height: 800, formFactor: 'desktop' }}
      >
        <AppShell catalog={catalog} videoHost={videoHost} />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('home-movies-item-0'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-screen')).toBeTruthy();
      expect(screen.getByTestId('detail-trailer')).toBeTruthy();
    });

    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS + 50);
    });

    const muteToggle = await waitFor(() => screen.getByTestId('detail-trailer-mute-toggle'));
    expect(muteToggle.props.accessibilityLabel).toBe('Unmute preview');

    await fireEvent.press(muteToggle);
    await waitFor(async () => {
      const snap = await prefStore.load();
      expect(snap.detailTrailerMuted).toBe(false);
    });
    expect(screen.getByTestId('detail-trailer-mute-toggle').props.accessibilityLabel).toBe(
      'Mute preview',
    );

    await view.unmount();
  });
});
