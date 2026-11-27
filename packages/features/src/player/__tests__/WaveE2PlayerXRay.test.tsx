import type {
  CatalogService,
  ElvItemEnrichment,
  ElvPersonLibraryItem,
  ElvTitleRecord,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { EngineEvent, LoadCommand, PlayerEngine } from '@elv/playback';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

function makeControllableVideoHost(overlayMode: 'floating' | 'docked' = 'floating') {
  const listeners = new Set<(event: EngineEvent) => void>();
  let currentAttempt = 1;
  const pauseMock = jest.fn((attempt: number) => {
    for (const l of listeners) l({ attempt, type: 'state', state: 'paused' });
  });
  const playMock = jest.fn((attempt: number) => {
    for (const l of listeners) l({ attempt, type: 'state', state: 'playing' });
  });
  const loadMock = jest.fn((cmd: LoadCommand) => {
    currentAttempt = cmd.attempt;
    for (const l of listeners) {
      l({ attempt: cmd.attempt, type: 'state', state: 'playing' });
      l({ attempt: cmd.attempt, type: 'firstFrame', atMs: 100 });
      l({
        attempt: cmd.attempt,
        type: 'clock',
        anchor: { positionMs: 30_000, durationMs: 3_600_000, rate: 1, atMs: 100 },
      });
    }
  });
  const engine: PlayerEngine = {
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
    play: playMock,
    pause: pauseMock,
    seek: jest.fn(),
    stop: jest.fn(),
    recreate: jest.fn(),
    release: jest.fn(),
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
  const opened: OpenVideoEngine = {
    engine,
    overlayMode,
    renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
  };
  const emitState = (state: 'playing' | 'paused') => {
    for (const l of listeners) l({ attempt: currentAttempt, type: 'state', state });
  };
  const videoHost: VideoHost = { open: jest.fn(() => opened) };
  return { videoHost, pauseMock, playMock, emitState };
}

const TITLE_RECORD: ElvTitleRecord = {
  imdbId: 'tt5753856',
  mediaType: 'series',
  originalTitle: 'Dark',
  englishTitle: 'Dark',
  localizedTitles: {},
  year: 2017,
  rating: 8.7,
  votes: 450_000,
  runtimeMin: 53,
  genres: ['Sci-Fi', 'Mystery'],
  posterUrl: 'https://imdb.invalid/dark.jpg',
  backdropUrl: 'https://imdb.invalid/dark-bg.jpg',
  trailerStreamUrl: null,
  trailerYoutubeId: null,
  director: 'Baran bo Odar',
  cast: [
    {
      personId: 'nm3237945',
      name: 'Louis Hofmann',
      character: 'Jonas Kahnwald',
      portraitUrl: 'https://imdb.invalid/louis.jpg',
    },
    {
      personId: 'nm1234567',
      name: 'Lisa Vicari',
      character: 'Martha Nielsen',
      portraitUrl: null,
    },
  ],
  mltImdbIds: [],
  franchiseKey: null,
  franchiseName: null,
  franchiseOrder: null,
  synopses: {},
  detailFetchedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const ENRICHMENT: ElvItemEnrichment = {
  itemKey: 'x:src-1:series:7',
  sourceId: 'src-1',
  mediaType: 'series',
  imdbId: 'tt5753856',
  confidence: 0.99,
  manualLock: false,
  title: TITLE_RECORD,
};

const PERSON_LIBRARY_ITEMS: readonly ElvPersonLibraryItem[] = [
  {
    item: {
      id: 99,
      sourceId: 'src-1',
      kind: 'movie',
      providerId: '99',
      key: 'x:src-1:movie:99',
      name: 'Land of Mine',
      num: null,
      logo: 'https://imdb.invalid/lom.jpg',
      year: 2015,
      rating: 7.8,
    },
    enrichment: {
      ...ENRICHMENT,
      itemKey: 'x:src-1:movie:99',
      mediaType: 'movie',
      imdbId: 'tt3841424',
      title: {
        ...TITLE_RECORD,
        imdbId: 'tt3841424',
        mediaType: 'movie',
        originalTitle: 'Land of Mine',
        englishTitle: 'Land of Mine',
      },
    },
    role: 'cast',
    character: 'Sebastian Schumann',
  },
];

function makeCatalog() {
  const getElvEnrichmentForKeys = jest.fn(
    async () => new Map<string, ElvItemEnrichment>([[ENRICHMENT.itemKey, ENRICHMENT]]),
  );
  const getElvTitleDetail = jest.fn(async () => TITLE_RECORD);
  const listElvPersonLibraryItems = jest.fn(async () => PERSON_LIBRARY_ITEMS);
  const catalog = {
    resolveStream: jest.fn(async () =>
      ok({ url: 'https://stream.invalid/dark-s1e1.mp4', headers: {} }),
    ),
    getProgress: jest.fn(async () => null),
    saveProgress: jest.fn(async () => ok(undefined)),
    getElvEnrichmentForKeys,
    getElvTitleDetail,
    listElvPersonLibraryItems,
  } as unknown as CatalogService;
  return { catalog, getElvEnrichmentForKeys, getElvTitleDetail, listElvPersonLibraryItems };
}

describe('Wave E2 In-Player X-Ray (#352)', () => {
  it('auto-shows X-Ray on VOD pause, toggles cleanly, pauses playback on cast click, and navigates to Detail from PersonLibraryModal', async () => {
    const { videoHost, pauseMock, emitState } = makeControllableVideoHost('floating');
    const { catalog, getElvEnrichmentForKeys, getElvTitleDetail } = makeCatalog();
    const onOpenDetail = jest.fn();
    const onExit = jest.fn();

    const episodeTarget: PlayTarget = {
      itemKey: 'x:src-1:ep:101',
      sourceId: 'src-1',
      kind: 'vod',
      itemKind: 'episode',
      seriesKey: 'x:src-1:series:7',
      season: 1,
      episode: 1,
      title: 'Dark — Secrets',
      subtitle: 'S1 E1 · Secrets',
    };

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
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={episodeTarget}
              elvModeEnabled
              elvXrayEnabled
              onOpenDetail={onOpenDetail}
              onExit={onExit}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(getElvEnrichmentForKeys).toHaveBeenCalledWith(['x:src-1:series:7']);
      expect(getElvTitleDetail).toHaveBeenCalledWith(
        'tt5753856',
        expect.objectContaining({ lang: 'en' }),
      );
      expect(screen.getByTestId('player-xray-button')).toBeTruthy();
    });

    // Hidden while actively playing
    expect(screen.queryByTestId('player-xray-strip')).toBeNull();

    // Auto-shows when paused
    await act(async () => {
      emitState('paused');
    });
    await waitFor(() => {
      expect(screen.getByTestId('player-xray-strip')).toBeTruthy();
      expect(screen.getByTestId('player-xray-director')).toBeTruthy();
      expect(screen.getByTestId('player-xray-cast-0')).toBeTruthy();
    });
    expect(screen.getByText('Baran bo Odar')).toBeTruthy();
    expect(screen.getByText('Louis Hofmann')).toBeTruthy();

    // Dismissing while paused keeps it closed
    await fireEvent.press(screen.getByTestId('player-xray-close'));
    expect(screen.queryByTestId('player-xray-strip')).toBeNull();

    // Resume playing, open X-Ray manually via OSD button, click cast -> pauses playback & opens PersonLibraryModal
    await act(async () => {
      emitState('playing');
    });
    await fireEvent.press(screen.getByTestId('player-xray-button'));
    await waitFor(() => {
      expect(screen.getByTestId('player-xray-cast-0')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('player-xray-cast-0'));
    expect(pauseMock).toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId('person-library-modal')).toBeTruthy();
      expect(screen.getByTestId('person-library-item-0')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('person-library-item-0'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'x:src-1:movie:99', title: 'Land of Mine' }),
    );

    await view.unmount();
  });

  it('never fetches or renders X-Ray on Live TV playback', async () => {
    const { videoHost } = makeControllableVideoHost('floating');
    const { catalog, getElvEnrichmentForKeys } = makeCatalog();
    const liveTarget: PlayTarget = {
      itemKey: 'x:src-1:live:1',
      sourceId: 'src-1',
      kind: 'live',
      title: 'News HD',
    };

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
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={liveTarget}
              elvModeEnabled
              elvXrayEnabled
              onExit={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('player-screen')).toBeTruthy();
    });
    expect(getElvEnrichmentForKeys).not.toHaveBeenCalled();
    expect(screen.queryByTestId('player-xray-button')).toBeNull();
    expect(screen.queryByTestId('player-xray-strip')).toBeNull();

    await view.unmount();
  });

  it('renders X-Ray strip and PersonLibraryModal in HWND-safe docked flex layout on Desktop docked mode', async () => {
    const { videoHost, emitState } = makeControllableVideoHost('docked');
    const { catalog } = makeCatalog();
    const movieTarget: PlayTarget = {
      itemKey: 'x:src-1:series:7',
      sourceId: 'src-1',
      kind: 'vod',
      itemKind: 'movie',
      title: 'Dark',
    };

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
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={movieTarget}
              elvModeEnabled
              elvXrayEnabled
              onOpenDetail={jest.fn()}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('player-desktop-stage')).toBeTruthy();
    });

    await act(async () => {
      emitState('paused');
    });
    await waitFor(() => {
      expect(screen.getByTestId('player-xray-strip-docked')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('player-xray-cast-0'));
    await waitFor(() => {
      expect(screen.getByTestId('person-library-docked-host')).toBeTruthy();
    });

    await view.unmount();
  });

  it('supports full 10-ft TV D-pad traversal on X-Ray OSD button and PlayerXRayStrip without exiting PlayerScreen on Back (P0 #2)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const keyListeners = new Set<(e: AndroidKeyEvent) => void>();
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListeners.add(l);
        return {
          remove: () => {
            keyListeners.delete(l);
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        for (const l of [...keyListeners]) {
          l({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        }
        for (const l of [...keyListeners]) {
          l({ keyCode, action: 'up', canceled: false, ageMs: 10 });
        }
      });
    };

    const { videoHost, emitState } = makeControllableVideoHost('floating');
    const { catalog } = makeCatalog();
    const onExit = jest.fn();
    const movieTarget: PlayTarget = {
      itemKey: 'x:src-1:series:7',
      sourceId: 'src-1',
      kind: 'vod',
      itemKind: 'movie',
      title: 'Dark',
    };

    const view = await render(
      <RemoteKeysProvider android={androidSource}>
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
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={movieTarget}
                elvModeEnabled
                elvXrayEnabled
                onOpenDetail={jest.fn()}
                onExit={onExit}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('player-xray-button')).toBeTruthy();
    });

    // Pause -> X-Ray auto-shows with TV anchor
    await act(async () => {
      emitState('paused');
    });
    await waitFor(() => {
      expect(screen.getByTestId('player-xray-strip')).toBeTruthy();
      expect(
        screen.getByTestId('player-xray-tv-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();
    });

    // Back dismisses X-Ray cleanly without exiting PlayerScreen
    await pressKey(KEYCODE_BACK);
    expect(screen.queryByTestId('player-xray-strip')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    // Resume playing -> focus TV OSD bar ('playPause') -> Right -> Right ('xray') -> Select opens X-Ray strip
    await act(async () => {
      emitState('playing');
    });
    await pressKey(KEYCODE_DPAD_DOWN); // focuses TV OSD bar ('playPause')
    await pressKey(KEYCODE_DPAD_RIGHT); // moves to 'seekForward'
    await pressKey(KEYCODE_DPAD_RIGHT); // moves to 'xray'
    await pressKey(KEYCODE_DPAD_CENTER); // opens X-Ray strip
    await waitFor(() => {
      expect(screen.getByTestId('player-xray-strip')).toBeTruthy();
    });

    // Inside X-Ray strip: initial focus on director (idx 0), Right -> cast 0 (Louis Hofmann) -> Select opens PersonLibraryModal
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('person-library-modal')).toBeTruthy();
      expect(screen.getByText('Louis Hofmann')).toBeTruthy();
    });

    // Back closes PersonLibraryModal without exiting PlayerScreen
    await pressKey(KEYCODE_BACK);
    expect(screen.queryByTestId('person-library-modal')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    // Left returns from cast 0 to director, Left stays clamped; Right all the way to close button -> Select closes X-Ray
    await pressKey(KEYCODE_DPAD_LEFT);
    await pressKey(KEYCODE_DPAD_RIGHT); // cast 0
    await pressKey(KEYCODE_DPAD_RIGHT); // cast 1
    await pressKey(KEYCODE_DPAD_RIGHT); // close button
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(screen.queryByTestId('player-xray-strip')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('resets transient X-Ray UI state across episode transitions while reusing cached titleDetail (P2 #3)', async () => {
    const { videoHost, emitState } = makeControllableVideoHost('floating');
    const { catalog, getElvTitleDetail } = makeCatalog();
    const ep1: PlayTarget = {
      itemKey: 'x:src-1:ep:101',
      sourceId: 'src-1',
      kind: 'vod',
      itemKind: 'episode',
      seriesKey: 'x:src-1:series:7',
      season: 1,
      episode: 1,
      title: 'Dark — Secrets',
      subtitle: 'S1 E1 · Secrets',
    };
    const ep2: PlayTarget = {
      itemKey: 'x:src-1:ep:102',
      sourceId: 'src-1',
      kind: 'vod',
      itemKind: 'episode',
      seriesKey: 'x:src-1:series:7',
      season: 1,
      episode: 2,
      title: 'Dark — Lies',
      subtitle: 'S1 E2 · Lies',
    };

    const wrap = (target: PlayTarget) => (
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
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={target}
              elvModeEnabled
              elvXrayEnabled
              onOpenDetail={jest.fn()}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(wrap(ep1));
    await waitFor(() => {
      expect(getElvTitleDetail).toHaveBeenCalledTimes(1);
    });

    // Pause on S1E1 -> dismiss X-Ray
    await act(async () => {
      emitState('paused');
    });
    await waitFor(() => {
      expect(screen.getByTestId('player-xray-strip')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('player-xray-close'));
    expect(screen.queryByTestId('player-xray-strip')).toBeNull();

    // Advance to S1E2 of same series: dismissedOnPause must reset so pausing shows X-Ray again, WITHOUT refetching titleDetail
    await view.rerender(wrap(ep2));
    await act(async () => {
      emitState('paused');
    });
    await waitFor(() => {
      expect(screen.getByTestId('player-xray-strip')).toBeTruthy();
    });
    expect(getElvTitleDetail).toHaveBeenCalledTimes(1);

    await view.unmount();
  });
});
