import { type DeinterlaceMode, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { EMPTY_TRACKS } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import type { QueuedEpisodeHostRequest, VideoHost } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';
import { PlayerSettingsSheet } from '../PlayerSettingsSheet';

function wrap(node: ReactElement) {
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

describe('Wave C5A Player & Gapless Queue (#243, #205)', () => {
  it('cycles deinterlaceMode (Off -> Auto -> Broadcast bwdif) and toggles pitchLock & audioNormalization in PlayerSettingsSheet (#243)', async () => {
    const onCycleDeinterlaceMode = jest.fn();
    const onTogglePitchLock = jest.fn();
    const onToggleAudioNormalization = jest.fn();

    const view = await render(
      wrap(
        <PlayerSettingsSheet
          visible
          menuState={{ view: 'advanced', index: 0 }}
          tracks={EMPTY_TRACKS}
          isVod
          deinterlaceMode="bwdif"
          onCycleDeinterlaceMode={onCycleDeinterlaceMode}
          pitchLock={true}
          onTogglePitchLock={onTogglePitchLock}
          audioNormalization={false}
          onToggleAudioNormalization={onToggleAudioNormalization}
          statsVisible={false}
          isTv={false}
          formFactor="desktop"
          i18n={createAppI18n('en')}
          onOpenView={jest.fn()}
          onSelectAudio={jest.fn()}
          onSelectSubtitle={jest.fn()}
          onToggleStats={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );

    const deintRow = screen.getByTestId('player-deinterlace-toggle');
    expect(deintRow.props.accessibilityLabel).toBe('Deinterlace: Broadcast (bwdif)');
    await fireEvent.press(deintRow);
    expect(onCycleDeinterlaceMode).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('player-pitch-lock-toggle'));
    expect(onTogglePitchLock).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('player-audio-normalization-toggle'));
    expect(onToggleAudioNormalization).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('forwards deinterlaceMode, pitchLock, and audioNormalization to OpenVideoEngine and arms gapless queueNext + cross-season onQueueAdvanced without svc.stop() (#243, #205)', async () => {
    const engine = createFakePlayerEngine({
      now: () => 1_000,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const setDeinterlaceMode = jest.fn<void, [DeinterlaceMode]>();
    const setPitchLock = jest.fn<void, [boolean]>();
    const setAudioNormalization = jest.fn<void, [boolean]>();
    const queueNext = jest.fn<void, [QueuedEpisodeHostRequest]>();
    const clearQueue = jest.fn<void, []>();
    const setMediaMetadata = jest.fn();
    let queueAdvancedListener: ((itemKey: string) => void) | undefined;

    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
        setDeinterlaceMode,
        setPitchLock,
        setAudioNormalization,
        queueNext,
        clearQueue,
        setMediaMetadata,
        onQueueAdvanced: (listener) => {
          queueAdvancedListener = listener;
          return () => {
            queueAdvancedListener = undefined;
          };
        },
      }),
    };

    const ep2Inline: PlayableEntry = {
      itemKey: 'ep:s1e2',
      sourceId: 'src-1',
      title: 'The Expanse — S1 E2',
      subtitle: 'S1 E2',
      kind: 'vod',
      itemKind: 'episode',
      seriesKey: 'ser:expanse',
      season: 1,
      episode: 2,
    };

    const ep1Target: PlayTarget = {
      itemKey: 'ep:s1e1',
      sourceId: 'src-1',
      title: 'The Expanse — S1 E1',
      subtitle: 'S1 E1',
      kind: 'vod',
      itemKind: 'episode',
      seriesKey: 'ser:expanse',
      season: 1,
      episode: 1,
      nextEpisodes: [ep2Inline],
    };

    const resolveStream = jest.fn(async (key: string) =>
      ok({
        url: `http://sim.example.test/${key}.mkv`,
        headers: { 'User-Agent': 'ELVTest/1.0' },
      }),
    );
    const saveProgress = jest.fn(async () => ok(undefined));
    const queryNextEpisode = jest.fn(async (_seriesKey: string, currentKey: string) => {
      if (currentKey === 'ep:s1e2') {
        return {
          key: 'ep:s2e1',
          sourceId: 'src-1',
          seriesKey: 'ser:expanse',
          seriesTitle: 'The Expanse',
          title: 'Safe',
          season: 2,
          episode: 1,
          logo: null,
        };
      }
      return null;
    });
    const onTargetChange = jest.fn();

    const catalog = {
      resolveStream,
      getProgress: jest.fn(async () => null),
      saveProgress,
      queryNextEpisode,
    } as unknown as PlayerScreenProps['catalog'];

    const view = await render(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={ep1Target}
          autoPlayNextEpisode={true}
          deinterlaceMode="auto"
          pitchLock={true}
          audioNormalization={true}
          preferHevcOverDolbyVision={true}
          filterSdhSubtitles={true}
          onTargetChange={onTargetChange}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(setDeinterlaceMode).toHaveBeenCalledWith('auto');
      expect(setPitchLock).toHaveBeenCalledWith(true);
      expect(setAudioNormalization).toHaveBeenCalledWith(true);
    });

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const initialLoadCmd = engine.commands.find((c) => c.name === 'load');
    const attempt = initialLoadCmd?.attempt ?? 1;

    expect(queueNext).not.toHaveBeenCalled();

    await act(async () => {
      engine.emit({ attempt, type: 'state', state: 'playing' });
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 120_000, atMs: 1_000, rate: 1, durationMs: 2_400_000 },
      });
    });

    await waitFor(() => {
      expect(queueNext).toHaveBeenCalledWith({
        itemKey: 'ep:s1e2',
        stream: {
          url: 'http://sim.example.test/ep:s1e2.mkv',
          headers: { 'User-Agent': 'ELVTest/1.0' },
        },
        preferHevcOverDolbyVision: true,
        filterSdhSubtitles: true,
      });
    });
    expect(queueNext).toHaveBeenCalledTimes(1);

    const stopCallsBeforeAdvance = engine.commands.filter((c) => c.name === 'stop').length;

    await act(async () => {
      queueAdvancedListener?.('ep:s1e2');
    });

    await waitFor(() => {
      expect(onTargetChange).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: 'ep:s1e2',
          title: 'The Expanse — S1 E2',
        }),
      );
    });

    expect(engine.commands.filter((c) => c.name === 'stop').length).toBe(stopCallsBeforeAdvance);

    expect(saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'ep:s1e1',
        watched: true,
      }),
    );

    await waitFor(() => {
      expect(queryNextEpisode).toHaveBeenCalledWith('ser:expanse', 'ep:s1e2', undefined);
      expect(queueNext).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: 'ep:s2e1',
          stream: expect.objectContaining({
            url: 'http://sim.example.test/ep:s2e1.mkv',
          }),
        }),
      );
    });

    expect(setMediaMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'The Expanse — S1 E2',
        subtitle: 'S1 E2',
        kind: 'vod',
      }),
    );

    // Episode 2+ watch progress writes succeed because PlaybackService adopted ep:s1e2!
    saveProgress.mockClear();
    await act(async () => {
      engine.emit({ attempt, type: 'state', state: 'playing' });
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 2_370_000, atMs: Date.now(), rate: 0, durationMs: 2_400_000 },
      });
    });

    // While gapless append-play is armed for S2 E1 near EOF, NextEpisodeBanner stays visible
    // with manual Play button but suppresses its auto-countdown timer so mpv transitions at EOF.
    await waitFor(() => {
      expect(screen.getByTestId('player-next-episode-banner')).toBeTruthy();
      expect(screen.getByTestId('player-next-episode')).toBeTruthy();
    });
    expect(screen.queryByTestId('player-next-episode-countdown')).toBeNull();

    await view.unmount();
    expect(clearQueue).toHaveBeenCalled();
    expect(saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'ep:s1e2',
        positionMs: 2_370_000,
      }),
    );
  });

  it('clears the gapless queue when autoPlayNextEpisode is toggled off (#205)', async () => {
    const engine = createFakePlayerEngine({
      now: () => 1_000,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const queueNext = jest.fn<void, [QueuedEpisodeHostRequest]>();
    const clearQueue = jest.fn<void, []>();

    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
        queueNext,
        clearQueue,
      }),
    };

    const ep2: PlayableEntry = {
      itemKey: 'ep:2',
      sourceId: 'src-1',
      title: 'Ep 2',
      kind: 'vod',
      itemKind: 'episode',
    };
    const ep1: PlayTarget = {
      itemKey: 'ep:1',
      sourceId: 'src-1',
      title: 'Ep 1',
      kind: 'vod',
      itemKind: 'episode',
      nextEpisodes: [ep2],
    };

    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mkv`, headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok(undefined)),
    } as unknown as PlayerScreenProps['catalog'];

    const view = await render(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={ep1}
          autoPlayNextEpisode={true}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({ attempt, type: 'state', state: 'playing' });
    });

    await waitFor(() => {
      expect(queueNext).toHaveBeenCalledTimes(1);
    });

    await view.rerender(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={ep1}
          autoPlayNextEpisode={false}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(clearQueue).toHaveBeenCalled();
    });
    await view.unmount();
  });
});
