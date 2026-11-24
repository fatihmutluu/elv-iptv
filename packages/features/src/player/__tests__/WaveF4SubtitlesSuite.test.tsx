import {
  createMemoryPreferencesStore,
  DEFAULT_SUBTITLE_STYLE,
  elvError,
  err,
  ok,
  type SubtitleStyleConfig,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { ExternalSubtitleTrack, MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost, VideoSurfaceProps } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEY_DOWN = 20;
const KEY_RIGHT = 22;
const KEY_SELECT = 23;
const KEY_BACK = 4;

const VOD_TARGET: PlayTarget = {
  itemKey: 'vod:src-1:movie-99',
  sourceId: 'src-1',
  title: 'Cinema Feature',
  kind: 'vod',
};

const DUAL_TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng', label: 'English' }],
  subtitles: [
    { id: 's:1', language: 'eng', label: 'English' },
    { id: 's:2', language: 'tur', label: 'Turkish' },
    { id: 'ext:1', language: 'deu', label: 'Sidecar DE', external: true },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
  selectedSecondarySubtitleId: null,
};

function makeCatalog(): PlayerScreenProps['catalog'] {
  return {
    resolveStream: jest.fn(async () =>
      ok({ url: 'http://example.invalid/vod/movie-99.m3u8', headers: {} }),
    ),
    getProgress: jest.fn(async () => null),
    saveProgress: jest.fn(async () => err(elvError('storage', 'test-noop'))),
  };
}

function wrapDesktop(node: ReactElement): ReactElement {
  return (
    <ThemeProvider preset="obsidianCrimson">
      <I18nProvider i18n={createAppI18n('en')}>
        <FormFactorProvider value="desktop">
          <ViewportProvider
            value={{
              formFactor: 'desktop',
              orientation: 'landscape',
              inputModality: 'pointer',
              width: 1280,
              height: 720,
            }}
          >
            {node}
          </ViewportProvider>
        </FormFactorProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

describe('Wave F4 Subtitles Suite UI (#32, #402)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders dual subtitle picker with External badge, disables colliding primary track, and supports selecting/clearing secondary track on TV D-pad (#402)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const manual = createManualClock();
    const keys = createFakeAndroidKeys();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      capabilities: {
        dualSubtitles: true,
        externalSubtitles: true,
        subtitleStyling: true,
      },
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      }),
    };

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <TvRemoteProvider>
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <FormFactorProvider value="tv">
                <ViewportProvider
                  value={{
                    formFactor: 'tv',
                    orientation: 'landscape',
                    width: 1920,
                    height: 1080,
                  }}
                >
                  <PlayerScreen
                    catalog={makeCatalog()}
                    videoHost={videoHost}
                    target={VOD_TARGET}
                    clock={{ now: manual.now }}
                    timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                    onExit={jest.fn()}
                  />
                </ViewportProvider>
              </FormFactorProvider>
            </I18nProvider>
          </ThemeProvider>
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });

    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({ attempt: 1, type: 'tracks', tracks: DUAL_TRACKS });
    });

    // Open TrackPickerModal directly via button press
    await fireEvent.press(view.getByTestId('player-tracks-button'));

    // External badge rendered beside external track
    expect(view.getByTestId('player-subtitle-external-badge-ext:1')).toHaveTextContent('External');

    // Secondary subtitle section renders right below primary subtitles
    expect(view.getByTestId('player-secondary-subtitle-header')).toHaveTextContent(
      'Secondary subtitle',
    );
    // Primary track s:1 is disabled in secondary list with 'Active as primary' hint
    expect(
      view.getByTestId('player-secondary-subtitle-track-s:1').props.accessibilityState,
    ).toMatchObject({
      disabled: true,
    });
    expect(view.getByTestId('player-secondary-subtitle-primary-hint-s:1')).toHaveTextContent(
      'Active as primary',
    );

    // Pressing disabled s:1 does NOT call selectSecondarySubtitleTrack
    await fireEvent.press(view.getByTestId('player-secondary-subtitle-track-s:1'));
    expect(engine.commands.filter((c) => c.name === 'selectSecondarySubtitleTrack')).toHaveLength(
      0,
    );

    // Navigate via TV D-pad: Right into subtitles column (lands on selected s:1 at index 1),
    // Down x5 -> index 6 (secondary track s:2 Turkish), Select -> selects s:2!
    await act(async () => {
      keys.tap(KEY_RIGHT);
      for (let i = 0; i < 5; i += 1) keys.tap(KEY_DOWN);
      manual.advance(300);
      keys.tap(KEY_SELECT);
    });

    expect(
      engine.commands.filter((c) => c.name === 'selectSecondarySubtitleTrack').at(-1),
    ).toMatchObject({ trackId: 's:2' });

    // Clear secondary subtitle by pressing Secondary Off
    await fireEvent.press(view.getByTestId('player-secondary-subtitle-off'));
    expect(
      engine.commands.filter((c) => c.name === 'selectSecondarySubtitleTrack').at(-1),
    ).toMatchObject({ trackId: null });

    await view.unmount();
  });

  it('supports desktop external subtitle file picker and in-tree URL overlay with strict http(s) validation & feedback (#32)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      capabilities: {
        externalSubtitles: true,
        subtitleStyling: true,
      },
    });
    const pickedTrack: ExternalSubtitleTrack = {
      id: 'ext-file-1',
      uri: 'file:///Users/demo/movie.srt',
      label: 'movie.srt',
      mimeType: 'application/x-subrip',
    };
    const pickSubtitleFile = jest.fn(async () => pickedTrack);
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        pickSubtitleFile,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      }),
    };

    const view = await render(
      wrapDesktop(
        <PlayerScreen
          catalog={makeCatalog()}
          videoHost={videoHost}
          target={VOD_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({ attempt: 1, type: 'tracks', tracks: DUAL_TRACKS });
    });

    // Open TrackPickerModal -> Choose subtitle file triggers pickSubtitleFile() and attaches track
    await fireEvent.press(view.getByTestId('player-tracks-button'));
    expect(view.getByTestId('player-external-subtitle-pick-file')).toBeTruthy();
    expect(view.getByTestId('player-external-subtitle-from-url')).toBeTruthy();

    await fireEvent.press(view.getByTestId('player-external-subtitle-pick-file'));
    await waitFor(() => {
      expect(pickSubtitleFile).toHaveBeenCalledTimes(1);
      expect(
        engine.commands.some(
          (c) =>
            c.name === 'addExternalSubtitle' &&
            c.externalSubtitle?.uri === 'file:///Users/demo/movie.srt',
        ),
      ).toBe(true);
    });
    // Must NOT flash optimistic "External subtitle loaded" before track arrives in tracks.subtitles
    expect(view.queryByTestId('player-external-subtitle-feedback')).toBeNull();

    // Once engine reports the newly attached external track, feedback fires 'loaded'
    await act(async () => {
      engine.emit({
        attempt: 1,
        type: 'tracks',
        tracks: {
          ...DUAL_TRACKS,
          subtitles: [
            ...DUAL_TRACKS.subtitles,
            { id: 'ext:ext-file-1', label: 'movie.srt', external: true },
          ],
        },
      });
    });
    expect(view.getByTestId('player-external-subtitle-feedback')).toHaveTextContent(
      'External subtitle loaded',
    );

    // Open "Load from URL" in-tree overlay
    await fireEvent.press(view.getByTestId('player-external-subtitle-from-url'));
    expect(view.getByTestId('external-subtitle-url-overlay')).toBeTruthy();

    // Reject javascript: URI
    await fireEvent.changeText(
      view.getByTestId('external-subtitle-url-input'),
      'javascript:alert(1)',
    );
    await fireEvent.press(view.getByTestId('external-subtitle-url-submit'));
    expect(view.getByTestId('external-subtitle-url-error')).toHaveTextContent(
      'Enter a valid http(s) subtitle URL.',
    );

    // Reject file:// URI in URL input (must be http/https only)
    await fireEvent.changeText(
      view.getByTestId('external-subtitle-url-input'),
      'file:///tmp/local.srt',
    );
    await fireEvent.press(view.getByTestId('external-subtitle-url-submit'));
    expect(view.getByTestId('external-subtitle-url-error')).toHaveTextContent(
      'Enter a valid http(s) subtitle URL.',
    );

    // Accept valid https:// URL with optional label
    await fireEvent.changeText(
      view.getByTestId('external-subtitle-url-input'),
      'https://example.invalid/captions/french.vtt',
    );
    await fireEvent.changeText(view.getByTestId('external-subtitle-label-input'), 'French WebVTT');
    await fireEvent.press(view.getByTestId('external-subtitle-url-submit'));

    await waitFor(() => {
      expect(view.queryByTestId('external-subtitle-url-overlay')).toBeNull();
    });
    const addedUrlTrack = engine.commands.find(
      (c) =>
        c.name === 'addExternalSubtitle' &&
        c.externalSubtitle?.uri === 'https://example.invalid/captions/french.vtt',
    )?.externalSubtitle;
    expect(addedUrlTrack).toMatchObject({
      uri: 'https://example.invalid/captions/french.vtt',
      label: 'French WebVTT',
    });

    // Advance past the earlier feedback toast hide timer (3s) — still pending until track arrives
    await act(async () => {
      manual.advance(3_500);
    });
    expect(view.queryByTestId('player-external-subtitle-feedback')).toBeNull();

    // Engine reports the URL track (matching pendingId directly) -> fires 'loaded'
    await act(async () => {
      engine.emit({
        attempt: 1,
        type: 'tracks',
        tracks: {
          ...DUAL_TRACKS,
          subtitles: [
            ...DUAL_TRACKS.subtitles,
            { id: 'ext:ext-file-1', label: 'movie.srt', external: true },
            { id: addedUrlTrack?.id ?? 'ext-url-1', label: 'French WebVTT', external: true },
          ],
        },
      });
    });
    expect(view.getByTestId('player-external-subtitle-feedback')).toHaveTextContent(
      'External subtitle loaded',
    );

    // Timeout failure: submit a URL whose async download/parse never produces a track (e.g. HTTP 404)
    await fireEvent.press(view.getByTestId('player-external-subtitle-from-url'));
    await fireEvent.changeText(
      view.getByTestId('external-subtitle-url-input'),
      'https://example.invalid/captions/missing-404.srt',
    );
    await fireEvent.press(view.getByTestId('external-subtitle-url-submit'));
    await waitFor(() => {
      expect(view.queryByTestId('external-subtitle-url-overlay')).toBeNull();
    });
    await act(async () => {
      manual.advance(8_000);
    });
    expect(view.getByTestId('player-external-subtitle-feedback')).toHaveTextContent(
      'Could not load external subtitle.',
    );

    // Immediate failure when picker rejects
    pickSubtitleFile.mockRejectedValueOnce(new Error('invalid file'));
    await fireEvent.press(view.getByTestId('player-external-subtitle-pick-file'));
    await waitFor(() => {
      expect(view.getByTestId('player-external-subtitle-feedback')).toHaveTextContent(
        'Could not load external subtitle.',
      );
    });

    await view.unmount();
  });

  it('updates live subtitle styling via PlayerSettingsSheet without restarting playback, persists to preferences, forwards to renderSurface, and resets cleanly (#32)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const manual = createManualClock();
    const keys = createFakeAndroidKeys();
    const prefStore = createMemoryPreferencesStore();
    const surfacePropsHistory: VideoSurfaceProps[] = [];
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      capabilities: {
        subtitleStyling: true,
      },
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => {
          surfacePropsHistory.push(props);
          return <View testID={props.testID ?? 'player-surface'} />;
        },
      }),
    };

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <ThemeProvider>
          <ViewportProvider
            value={{
              formFactor: 'tv',
              orientation: 'landscape',
              width: 1920,
              height: 1080,
            }}
          >
            <FormFactorProvider value="tv">
              <I18nProvider i18n={createAppI18n('en')}>
                <TvRemoteProvider>
                  <PlayerScreen
                    catalog={makeCatalog()}
                    videoHost={videoHost}
                    target={VOD_TARGET}
                    clock={{ now: manual.now }}
                    timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                    subtitleStyle={DEFAULT_SUBTITLE_STYLE}
                    onPersistSubtitleStyle={(next) => {
                      void prefStore.update({ subtitleStyle: next });
                    }}
                    onExit={jest.fn()}
                  />
                </TvRemoteProvider>
              </I18nProvider>
            </FormFactorProvider>
          </ViewportProvider>
        </ThemeProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const initialLoadCount = engine.commands.filter((c) => c.name === 'load').length;

    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({ attempt: 1, type: 'tracks', tracks: DUAL_TRACKS });
    });

    // Open PlayerSettingsSheet -> Subtitle style sub-view
    await fireEvent.press(view.getByTestId('player-settings-button'));
    await fireEvent.press(await view.findByTestId('player-settings-row-subtitle-style'));
    expect(view.getByTestId('player-subtitle-style-section')).toBeTruthy();

    // Update Size -> Large, Text color -> Yellow, Background -> Solid, Edge -> Shadow, Position -> Top
    await fireEvent.press(view.getByTestId('player-subtitle-style-opt-fontSize-large'));
    await fireEvent.press(view.getByTestId('player-subtitle-style-opt-textColor-yellow'));
    await fireEvent.press(view.getByTestId('player-subtitle-style-opt-backgroundColor-opaque'));
    await fireEvent.press(view.getByTestId('player-subtitle-style-opt-edgeStyle-dropShadow'));
    await fireEvent.press(view.getByTestId('player-subtitle-style-opt-verticalPosition-top'));

    const expectedCustom: SubtitleStyleConfig = {
      fontSize: 'large',
      textColor: 'yellow',
      backgroundColor: 'opaque',
      edgeStyle: 'dropShadow',
      verticalPosition: 'top',
    };

    await waitFor(async () => {
      expect(
        engine.commands.filter((c) => c.name === 'setSubtitleStyle').at(-1)?.subtitleStyle,
      ).toEqual(expectedCustom);
      const saved = await prefStore.load();
      expect(saved.subtitleStyle).toEqual(expectedCustom);
    });

    // Surface received updated subtitleStyle and ZERO extra load commands occurred (zero restart!)
    expect(surfacePropsHistory.at(-1)?.subtitleStyle).toEqual(expectedCustom);
    expect(engine.commands.filter((c) => c.name === 'load')).toHaveLength(initialLoadCount);

    // TV D-pad Right on row 0 (fontSize) cycles large -> extraLarge live
    await act(async () => {
      keys.tap(KEY_RIGHT);
    });
    await waitFor(() => {
      expect(
        engine.commands.filter((c) => c.name === 'setSubtitleStyle').at(-1)?.subtitleStyle
          ?.fontSize,
      ).toBe('extraLarge');
    });

    // Reset style restores DEFAULT_SUBTITLE_STYLE
    await fireEvent.press(view.getByTestId('player-subtitle-style-reset'));
    await waitFor(async () => {
      expect(
        engine.commands.filter((c) => c.name === 'setSubtitleStyle').at(-1)?.subtitleStyle,
      ).toEqual(DEFAULT_SUBTITLE_STYLE);
      const saved = await prefStore.load();
      expect(saved.subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE);
    });
    expect(engine.commands.filter((c) => c.name === 'load')).toHaveLength(initialLoadCount);

    // TV Back returns cleanly from subtitleStyle to root
    await act(async () => {
      keys.tap(KEY_BACK);
    });
    expect(view.getByTestId('player-settings-row-subtitle-style')).toBeTruthy();

    await view.unmount();
  });
});
