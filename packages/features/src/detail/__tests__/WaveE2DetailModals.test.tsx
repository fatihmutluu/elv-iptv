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
import { Platform, View } from 'react-native';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import { DetailTrailerModal } from '../DetailTrailerModal';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_CENTER = 23;

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

describe('Wave E2 DetailTrailerModal regressions (#512)', () => {
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
});
