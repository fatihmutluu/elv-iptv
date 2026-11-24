import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackService, PlaybackStatus } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';
import { useInitialTrackSelection } from '../usePlayerTrackAndDecoderSync';

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

const LIVE_TARGET: PlayTarget = {
  itemKey: 'live:src-1:ch-42',
  sourceId: 'src-1',
  title: 'Cinema HD',
  kind: 'live',
};

function DelayRestoreProbe({
  service,
  tracks,
  statusKind,
  getTrackPreference,
}: {
  readonly service: PlaybackService;
  readonly tracks: MediaTracks;
  readonly statusKind: PlaybackStatus['kind'];
  readonly getTrackPreference: NonNullable<PlayerScreenProps['catalog']['getTrackPreference']>;
}) {
  useInitialTrackSelection({
    activeService: service,
    activeTarget: LIVE_TARGET,
    tracks,
    catalog: { getTrackPreference },
    subtitleMode: 'off',
    statusKind,
  });
  return <View />;
}

describe('Wave F0B PlayerScreen audio/subtitle delay persistence & adaptive video quality (#59, #208)', () => {
  it('auto-restores saved #208 audio/subtitle delays on tune, persists stepper edits, and selects video quality', async () => {
    const engine = createFakePlayerEngine({
      now: () => 1_000,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      capabilities: {
        audioDelay: true,
        subtitleDelay: true,
        videoQualitySelection: true,
      },
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      }),
    };
    const saveTrackPreference = jest.fn(async () => undefined);
    const getTrackPreference = jest.fn(async () => ({
      profileId: 'default',
      scopeKey: LIVE_TARGET.itemKey,
      sourceId: LIVE_TARGET.sourceId,
      audioLang: 'en',
      audioLabel: 'English',
      subLang: null,
      subLabel: null,
      subDisabled: false,
      resizeMode: null,
      audioDelayMs: 150,
      subDelayMs: -100,
      updatedAt: 1_000,
    }));
    const catalog: PlayerScreenProps['catalog'] = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://example.invalid/live/ch-42.m3u8', headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => err(elvError('storage', 'test-noop'))),
      getTrackPreference,
      saveTrackPreference,
    };

    const view = await render(
      wrapDesktop(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={LIVE_TARGET}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });

    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({
        attempt: 1,
        type: 'tracks',
        tracks: {
          audio: [{ id: 'a:1', language: 'en', label: 'English' }],
          subtitles: [{ id: 's:1', language: 'en', label: 'English' }],
          selectedAudioId: 'a:1',
          selectedSubtitleId: 's:1',
          videoQualities: [
            { id: 'v:1080', label: '1080p', height: 1080, bitrateBps: 5_000_000, fps: 50 },
            { id: 'v:720', label: '720p', height: 720, bitrateBps: 2_500_000, fps: 25 },
          ],
          selectedVideoQualityId: null,
        },
      });
    });

    // Saved #208 delays automatically applied on initial load
    await waitFor(() => {
      expect(engine.commands).toContainEqual({ name: 'setAudioDelay', attempt: 1, delayMs: 150 });
      expect(engine.commands).toContainEqual({
        name: 'setSubtitleDelay',
        attempt: 1,
        delayMs: -100,
      });
    });

    // Open PlayerSettingsSheet
    await fireEvent.press(view.getByTestId('player-settings-button'));

    // Open Audio delay sub-view and step +50 ms -> 200 ms, then Reset -> 0 ms
    await fireEvent.press(await view.findByTestId('player-settings-row-audio-delay'));
    await fireEvent.press(await view.findByTestId('player-settings-audio-delay-plus-50'));
    await waitFor(() => {
      expect(engine.commands).toContainEqual({ name: 'setAudioDelay', attempt: 1, delayMs: 200 });
      expect(saveTrackPreference).toHaveBeenCalledWith({
        scopeKey: LIVE_TARGET.itemKey,
        sourceId: LIVE_TARGET.sourceId,
        audioDelayMs: 200,
      });
    });
    await fireEvent.press(view.getByTestId('player-settings-audio-delay-reset'));
    await waitFor(() => {
      expect(engine.commands).toContainEqual({ name: 'setAudioDelay', attempt: 1, delayMs: 0 });
      expect(saveTrackPreference).toHaveBeenCalledWith({
        scopeKey: LIVE_TARGET.itemKey,
        sourceId: LIVE_TARGET.sourceId,
        audioDelayMs: 0,
      });
    });

    // Back to root -> Subtitle delay -> step -250 ms -> -350 ms
    await fireEvent.press(view.getByTestId('player-settings-back'));
    await fireEvent.press(await view.findByTestId('player-settings-row-subtitle-delay'));
    await fireEvent.press(await view.findByTestId('player-settings-subtitle-delay-minus-250'));
    await waitFor(() => {
      expect(engine.commands).toContainEqual({
        name: 'setSubtitleDelay',
        attempt: 1,
        delayMs: -350,
      });
      expect(saveTrackPreference).toHaveBeenCalledWith({
        scopeKey: LIVE_TARGET.itemKey,
        sourceId: LIVE_TARGET.sourceId,
        subDelayMs: -350,
      });
    });

    // Back to root -> Video quality -> select 1080p then Auto
    await fireEvent.press(view.getByTestId('player-settings-back'));
    await fireEvent.press(await view.findByTestId('player-settings-row-video-quality'));
    await fireEvent.press(await view.findByTestId('player-settings-video-quality-v:1080'));
    await waitFor(() => {
      expect(engine.commands).toContainEqual({
        name: 'selectVideoQuality',
        attempt: 1,
        qualityId: 'v:1080',
      });
    });
    await fireEvent.press(view.getByTestId('player-settings-video-quality-auto'));
    await waitFor(() => {
      expect(engine.commands).toContainEqual({
        name: 'selectVideoQuality',
        attempt: 1,
        qualityId: null,
      });
    });

    await view.unmount();
  });

  it('does not prematurely latch #208 delay restore when PlaybackService still holds a stale item', async () => {
    let activeItem = 'live:src-1:old-ch';
    const setAudioDelay = jest.fn();
    const setSubtitleDelay = jest.fn();
    const service = {
      getState: () => ({ item: activeItem }),
      selectAudioTrack: jest.fn(),
      selectSubtitleTrack: jest.fn(),
      setAudioDelay,
      setSubtitleDelay,
    } as unknown as PlaybackService;

    const getTrackPreference = jest.fn(async () => ({
      profileId: 'default',
      scopeKey: LIVE_TARGET.itemKey,
      sourceId: LIVE_TARGET.sourceId,
      audioLang: 'en',
      audioLabel: 'English',
      subLang: null,
      subLabel: null,
      subDisabled: false,
      resizeMode: null,
      audioDelayMs: 250,
      subDelayMs: -150,
      updatedAt: 1_000,
    }));

    const staleTracks: MediaTracks = {
      audio: [{ id: 'a:old', language: 'en', label: 'Old' }],
      subtitles: [],
      selectedAudioId: 'a:old',
      selectedSubtitleId: null,
    };
    const nextTracks: MediaTracks = {
      audio: [{ id: 'a:new', language: 'en', label: 'New' }],
      subtitles: [],
      selectedAudioId: 'a:new',
      selectedSubtitleId: null,
    };

    const view = await render(
      <DelayRestoreProbe
        service={service}
        tracks={staleTracks}
        statusKind="playing"
        getTrackPreference={getTrackPreference}
      />,
    );

    await waitFor(() => {
      expect(getTrackPreference).toHaveBeenCalledWith(LIVE_TARGET.itemKey);
    });
    // Service still points at old-ch -> must NOT apply delays or latch appliedDelayItemRef
    expect(setAudioDelay).not.toHaveBeenCalled();
    expect(setSubtitleDelay).not.toHaveBeenCalled();

    // Now service switches to LIVE_TARGET and becomes ready -> delays must be restored!
    activeItem = LIVE_TARGET.itemKey;
    await view.rerender(
      <DelayRestoreProbe
        service={service}
        tracks={nextTracks}
        statusKind="playing"
        getTrackPreference={getTrackPreference}
      />,
    );

    await waitFor(() => {
      expect(setAudioDelay).toHaveBeenCalledWith(250);
      expect(setSubtitleDelay).toHaveBeenCalledWith(-150);
    });

    await view.unmount();
  });
});
