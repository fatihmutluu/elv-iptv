import type { ElvItemEnrichment, ElvSearchCandidate, ElvTitleRecord } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import type { EngineEvent } from '@elv/playback';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, ScrollView, TextInput, View } from 'react-native';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import { DetailFixMatchModal } from '../DetailFixMatchModal';
import { DetailTrailerModal } from '../DetailTrailerModal';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

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
    cast: [],
    mltImdbIds: [],
    franchiseKey: 'dune',
    franchiseName: 'Dune',
    franchiseOrder: 1,
    synopses: {},
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

describe('Wave E2 DetailTrailerModal & DetailFixMatchModal regressions (#512)', () => {
  it('does not reopen or release DetailTrailerModal native VideoHost when parent rerenders with a new onClose reference (P0 #1)', async () => {
    const { videoHost, loadMock, stopMock, releaseMock } = makeFakeVideoHost();
    const openSpy = videoHost.open as jest.Mock;
    const onClose1 = jest.fn();
    const onClose2 = jest.fn();

    const wrap = (onClose: () => void) => (
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
            <DetailTrailerModal
              visible
              title="Dune"
              trailerStreamUrl="https://imdb-video.media-imdb.com/vi123/dune.mp4"
              trailerYoutubeId="8g18jFHCLXk"
              videoHost={videoHost}
              onClose={onClose}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(wrap(onClose1));
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(loadMock).toHaveBeenCalledTimes(1);
    });

    await view.rerender(wrap(onClose2));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(stopMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('falls back from failed direct stream to YouTube iframe and reacts to async onOverlayModeChange (P1 #6)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    let eventListener: ((ev: EngineEvent) => void) | undefined;
    let overlayListener: ((mode: 'floating' | 'docked') => void) | undefined;
    const releaseMock = jest.fn();
    const opened: OpenVideoEngine = {
      overlayMode: 'floating',
      onOverlayModeChange: (listener) => {
        overlayListener = listener;
        return () => {
          overlayListener = undefined;
        };
      },
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
        load: jest.fn(),
        retry: jest.fn(),
        play: jest.fn(),
        pause: jest.fn(),
        seek: jest.fn(),
        stop: jest.fn(),
        recreate: jest.fn(),
        release: releaseMock,
        subscribe: (l) => {
          eventListener = l;
          return () => {
            eventListener = undefined;
          };
        },
      },
      renderSurface: (props) => <View testID={props.testID ?? 'trailer-surface'} />,
    };
    const videoHost: VideoHost = { open: jest.fn(() => opened) };

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
            <DetailTrailerModal
              visible
              title="Dune"
              trailerStreamUrl="https://imdb-video.media-imdb.com/vi123/dune.mp4"
              trailerYoutubeId="8g18jFHCLXk"
              videoHost={videoHost}
              onClose={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-trailer-loading-overlay')).toBeTruthy();
    });

    await act(async () => {
      overlayListener?.('docked');
    });
    expect(screen.queryByTestId('detail-trailer-loading-overlay')).toBeNull();

    await act(async () => {
      eventListener?.({ attempt: 1, type: 'error', error: { code: 'network' } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('detail-trailer-iframe-wrap')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-trailer-unavailable')).toBeNull();
    expect(releaseMock).toHaveBeenCalled();

    await view.unmount();
  });

  it('handles TV select on YouTube external fallback without closing and closes cleanly when failed stream has no YouTube fallback (P0 #2)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        keyListener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
      });
    };

    const openExternalUrl = jest.fn(async () => true);
    const onClose = jest.fn();

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
              <DetailTrailerModal
                visible
                title="Dune"
                trailerStreamUrl={null}
                trailerYoutubeId="8g18jFHCLXk"
                trailerExternal={{ openExternalUrl }}
                onClose={onClose}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await pressKey(KEYCODE_DPAD_CENTER);
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.youtube.com/watch?v=8g18jFHCLXk');
    expect(onClose).not.toHaveBeenCalled();

    await pressKey(KEYCODE_BACK);
    expect(onClose).toHaveBeenCalledTimes(1);
    await view.unmount();

    let eventListener: ((ev: EngineEvent) => void) | undefined;
    const playMock = jest.fn();
    const pauseMock = jest.fn();
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
        load: jest.fn(),
        retry: jest.fn(),
        play: playMock,
        pause: pauseMock,
        seek: jest.fn(),
        stop: jest.fn(),
        recreate: jest.fn(),
        release: jest.fn(),
        subscribe: (l) => {
          eventListener = l;
          return () => {
            eventListener = undefined;
          };
        },
      },
      renderSurface: (props) => <View testID={props.testID ?? 'trailer-surface'} />,
    };
    const onCloseFailed = jest.fn();
    const view2 = await render(
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
              <DetailTrailerModal
                visible
                title="Dune"
                trailerStreamUrl="https://imdb-video.media-imdb.com/vi123/broken.mp4"
                trailerYoutubeId={null}
                videoHost={{ open: () => opened }}
                onClose={onCloseFailed}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await act(async () => {
      eventListener?.({ attempt: 1, type: 'error', error: { code: 'network' } });
    });
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(playMock).not.toHaveBeenCalled();
    expect(pauseMock).not.toHaveBeenCalled();
    expect(onCloseFailed).toHaveBeenCalledTimes(1);

    await view2.unmount();
  });

  it('allows TV D-pad to reach Fix Match search input & button, auto-scrolls candidates, and guards mid-apply close (P1 #5)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        keyListener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
      });
    };

    const candidates: readonly ElvSearchCandidate[] = [
      {
        imdbId: 'tt1',
        title: 'Dune',
        year: 2021,
        mediaType: 'movie',
        posterUrl: null,
        stars: null,
      },
      {
        imdbId: 'tt2',
        title: 'Dune: Part Two',
        year: 2024,
        mediaType: 'movie',
        posterUrl: null,
        stars: null,
      },
      {
        imdbId: 'tt3',
        title: 'Dune (1984)',
        year: 1984,
        mediaType: 'movie',
        posterUrl: null,
        stars: null,
      },
    ];
    let resolveApply: ((value: ElvItemEnrichment | null) => void) | undefined;
    const searchElvMatchCandidates = jest.fn(async () => candidates);
    const applyElvFixMatch = jest.fn(
      () =>
        new Promise<ElvItemEnrichment | null>((resolve) => {
          resolveApply = resolve;
        }),
    );
    const onApplied = jest.fn();
    const onClose = jest.fn();
    const scrollToSpy = jest
      .spyOn(ScrollView.prototype, 'scrollTo')
      .mockImplementation(() => undefined);
    const focusSpy = jest.spyOn(TextInput.prototype, 'focus').mockImplementation(() => undefined);

    const wrap = (visible: boolean) => (
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
              <DetailFixMatchModal
                visible={visible}
                itemKey="x:src-1:movie:1"
                sourceId="src-1"
                mediaType="movie"
                initialQuery="Dune"
                catalog={{ searchElvMatchCandidates, applyElvFixMatch }}
                onApplied={onApplied}
                onClose={onClose}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>
    );

    const view = await render(wrap(true));
    await waitFor(() => {
      expect(screen.getByTestId('detail-fix-match-candidate-0')).toBeTruthy();
    });

    await pressKey(KEYCODE_DPAD_UP);
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(focusSpy).toHaveBeenCalled();

    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(searchElvMatchCandidates).toHaveBeenCalledTimes(2);
    });

    scrollToSpy.mockClear();
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ y: expect.any(Number) }));

    await pressKey(KEYCODE_DPAD_CENTER);
    expect(applyElvFixMatch).toHaveBeenCalledTimes(1);
    await view.rerender(wrap(false));
    await act(async () => {
      resolveApply?.({
        itemKey: 'x:src-1:movie:1',
        sourceId: 'src-1',
        mediaType: 'movie',
        imdbId: 'tt2',
        confidence: 1,
        manualLock: true,
        title: makeTitleRecord({ imdbId: 'tt2' }),
      });
    });
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    scrollToSpy.mockRestore();
    focusSpy.mockRestore();
    await view.unmount();
  });
});
