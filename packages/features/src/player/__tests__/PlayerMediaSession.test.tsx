import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, TvRemoteProvider } from '@elv/ui-kit';
import { render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { MediaSessionMetadata } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

function createHostHarness(initialTarget: PlayTarget) {
  const manual = createManualClock();
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
  });
  const setMediaMetadata = jest.fn<void, [MediaSessionMetadata | null]>();
  const catalog = {
    resolveStream: jest.fn(async (k: string) =>
      ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
    ),
  };
  const i18n = createAppI18n('en');
  const videoHost = {
    open: () => ({
      engine,
      renderSurface: () => <View testID="fake-surface" />,
      setMediaMetadata,
    }),
  };

  const renderTree = (activeTarget: PlayTarget) => (
    <ThemeProvider preset="obsidianCrimson">
      <TvRemoteProvider>
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={i18n}>
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={activeTarget}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </TvRemoteProvider>
    </ThemeProvider>
  );

  return { renderTree, setMediaMetadata, initialTarget };
}

describe('PlayerScreen typed MediaSessionMetadata forwarding (#435)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pushes typed metadata for standalone VOD with canStepTrack=false, updates on target change, and clears on unmount', async () => {
    const movieTarget: PlayTarget = {
      itemKey: 'movie-1',
      sourceId: 'src-1',
      title: 'Midnight Cinema',
      subtitle: '2026 · Drama',
      logo: 'https://cdn.example.test/poster.jpg',
      kind: 'vod',
    };
    const h = createHostHarness(movieTarget);
    const view = await render(h.renderTree(movieTarget));

    await waitFor(() => {
      expect(h.setMediaMetadata).toHaveBeenCalledWith({
        title: 'Midnight Cinema',
        subtitle: '2026 · Drama',
        artworkUrl: 'https://cdn.example.test/poster.jpg',
        kind: 'vod',
        canStepTrack: false,
      });
    });

    // Updating to an episodic VOD target keeps canStepTrack=false (no silent no-op OS track buttons) without emitting an intermediate null
    const episodeTarget: PlayTarget = {
      itemKey: 'ep-1',
      sourceId: 'src-1',
      title: 'Pilot',
      subtitle: null,
      logo: null,
      kind: 'vod',
      nextEpisodes: [
        {
          itemKey: 'ep-2',
          sourceId: 'src-1',
          title: 'Episode 2',
          kind: 'vod',
        },
      ],
    };
    await view.rerender(h.renderTree(episodeTarget));

    await waitFor(() => {
      expect(h.setMediaMetadata).toHaveBeenLastCalledWith({
        title: 'Pilot',
        kind: 'vod',
        canStepTrack: false,
      });
    });
    expect(h.setMediaMetadata.mock.calls.some(([arg]) => arg === null)).toBe(false);

    // Unmount clears OS media metadata cleanly
    await view.unmount();
    expect(h.setMediaMetadata).toHaveBeenLastCalledWith(null);
  });

  it('gates canStepTrack on playlist.count > 1 for live channels', async () => {
    const singleChannel: PlayTarget = {
      itemKey: 'live-1',
      sourceId: 'src-1',
      title: 'News One',
      kind: 'live',
      playlist: {
        count: 1,
        currentIndex: 0,
        onChangeIndex: jest.fn(),
        getAt: async () => undefined,
      },
    };
    const h = createHostHarness(singleChannel);
    const view = await render(h.renderTree(singleChannel));

    await waitFor(() => {
      expect(h.setMediaMetadata).toHaveBeenCalledWith({
        title: 'News One',
        kind: 'live',
        canStepTrack: false,
      });
    });

    const multiChannel: PlayTarget = {
      ...singleChannel,
      itemKey: 'live-2',
      title: 'Sports HD',
      subtitle: 'Live Match',
      logo: 'https://cdn.example.test/sports.png',
      playlist: {
        count: 5,
        currentIndex: 1,
        onChangeIndex: jest.fn(),
        getAt: async () => undefined,
      },
    };
    await view.rerender(h.renderTree(multiChannel));

    await waitFor(() => {
      expect(h.setMediaMetadata).toHaveBeenLastCalledWith({
        title: 'Sports HD',
        subtitle: 'Live Match',
        artworkUrl: 'https://cdn.example.test/sports.png',
        kind: 'live',
        canStepTrack: true,
      });
    });

    await view.unmount();
    expect(h.setMediaMetadata).toHaveBeenLastCalledWith(null);
  });
});
