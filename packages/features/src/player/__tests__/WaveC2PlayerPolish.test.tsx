import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { PlaybackTimers } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  createTvRemoteDispatcher,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  TvRemoteContext,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { PlayerChannelDrawer } from '../PlayerChannelDrawer';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';

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

const ENTRIES: readonly PlayableEntry[] = [
  { itemKey: 'x:s1:live:1', sourceId: 's1', kind: 'live', title: 'Channel A' },
  { itemKey: 'x:s1:live:2', sourceId: 's1', kind: 'live', title: 'Channel B' },
  { itemKey: 'x:s1:live:3', sourceId: 's1', kind: 'live', title: 'Channel C' },
  { itemKey: 'x:s1:live:4', sourceId: 's1', kind: 'live', title: 'Channel D' },
];

function makeLiveTarget(index = 0): PlayTarget {
  const entry = ENTRIES[index] ?? ENTRIES[0];
  if (!entry) throw new Error('missing entry');
  return {
    ...entry,
    playlist: {
      count: ENTRIES.length,
      currentIndex: index,
      onChangeIndex: jest.fn(),
      getAt: async (i) => ENTRIES[i],
    },
  };
}

function makeFakeHost(): {
  videoHost: VideoHost;
  engine: ReturnType<typeof createFakePlayerEngine>;
  emitHostKey: (key: 'back' | 'select' | 'channelUp' | 'channelDown') => void;
} {
  const engine = createFakePlayerEngine({
    now: () => 0,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  let onKeyHandler: ((key: string) => void) | undefined;
  const videoHost: VideoHost = {
    open: () => ({
      engine,
      onHostKey: (cb) => {
        onKeyHandler = cb as (key: string) => void;
        return () => {
          onKeyHandler = undefined;
        };
      },
      renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      close: () => undefined,
    }),
  };
  return {
    videoHost,
    engine,
    emitHostKey: (key) => onKeyHandler?.(key),
  };
}

describe('Wave C2 Player, Recent Channels & Preview Mode (#52, #53, #251)', () => {
  it('supports browse-while-watching OSD preview (#251) without interrupting active playback or recording recent channel until confirmed', async () => {
    const { videoHost, emitHostKey } = makeFakeHost();
    const recordRecentChannel = jest.fn(async () => undefined);
    const resolveStream = jest.fn(async (key: string) =>
      ok({ url: `http://sim.example.test/${key}.ts`, headers: {} }),
    );
    const onExit = jest.fn();
    const onTargetChange = jest.fn();
    const catalog = {
      resolveStream,
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok(undefined)),
      recordRecentChannel,
      nowNext: jest.fn(async () => []),
    } as unknown as PlayerScreenProps['catalog'];

    await render(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={makeLiveTarget(0)}
          liveChannelSwitchMode="preview"
          onTargetChange={onTargetChange}
          onExit={onExit}
        />,
      ),
    );

    await waitFor(() => {
      expect(recordRecentChannel).toHaveBeenCalledWith('x:s1:live:1', 's1');
    });
    const resolveCallsBeforePreview = resolveStream.mock.calls.length;

    // Pressing next channel in preview mode updates OSD to Channel B WITHOUT tuning or recording recent!
    await fireEvent.press(screen.getByTestId('player-next'));
    await waitFor(() => {
      expect(screen.getByTestId('osd-title').props.children).toBe('Channel B');
      expect(screen.getByTestId('player-preview-badge')).toBeTruthy();
      expect(screen.getByTestId('player-preview-hint')).toBeTruthy();
    });
    expect(resolveStream.mock.calls.length).toBe(resolveCallsBeforePreview);
    expect(recordRecentChannel).toHaveBeenCalledTimes(1);
    expect(onTargetChange).not.toHaveBeenCalled();

    // Pressing Back cancels preview and reverts OSD to Channel A without exiting player
    await act(async () => {
      emitHostKey('back');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('player-preview-badge')).toBeNull();
      expect(screen.getByTestId('osd-title').props.children).toBe('Channel A');
    });
    expect(onExit).not.toHaveBeenCalled();
  });

  it('preserves burst origin channel A as previousChannel across zap burst (#52)', async () => {
    const { videoHost } = makeFakeHost();
    const pendingTimers: Array<{ fn: () => void }> = [];
    const timers: PlaybackTimers = {
      setTimeout: (fn) => {
        const entry = { fn };
        pendingTimers.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const idx = pendingTimers.indexOf(handle as { fn: () => void });
        if (idx >= 0) pendingTimers.splice(idx, 1);
      },
    };
    const onTargetChange = jest.fn();
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.ts`, headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok(undefined)),
      recordRecentChannel: jest.fn(async () => undefined),
    } as unknown as PlayerScreenProps['catalog'];

    await render(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={makeLiveTarget(0)}
          timers={timers}
          onTargetChange={onTargetChange}
          onExit={jest.fn()}
        />,
      ),
    );

    await fireEvent.press(screen.getByTestId('player-next'));
    await waitFor(() => {
      expect(onTargetChange).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: 'x:s1:live:2',
          previousChannel: expect.objectContaining({ itemKey: 'x:s1:live:1' }),
        }),
      );
    });
  });

  it('toggles All | Recent channels inside PlayerChannelDrawer with constructive empty state (#53)', async () => {
    const fetchRecentChannels = jest.fn(async () => [] as readonly PlayableEntry[]);
    const onSelectChannel = jest.fn();

    const view = await render(
      wrap(
        <PlayerChannelDrawer
          visible
          playlist={makeLiveTarget(0).playlist}
          currentItemKey="x:s1:live:1"
          formFactor="desktop"
          isTv={false}
          i18n={createAppI18n('en')}
          fetchRecentChannels={fetchRecentChannels}
          onSelectChannel={onSelectChannel}
          onClose={jest.fn()}
        />,
      ),
    );

    await fireEvent.press(screen.getByTestId('player-channel-drawer-tab-recent'));
    await waitFor(() => {
      expect(screen.getByTestId('player-channel-drawer-recent-empty')).toBeTruthy();
    });

    const recentEntry = ENTRIES[2];
    if (!recentEntry) throw new Error('missing recent entry');
    fetchRecentChannels.mockResolvedValueOnce([recentEntry]);
    await fireEvent.press(screen.getByTestId('player-channel-drawer-tab-all'));
    await fireEvent.press(screen.getByTestId('player-channel-drawer-tab-recent'));
    await waitFor(() => {
      expect(screen.getByTestId('player-channel-recent-row-0')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('player-channel-recent-row-0'));
    expect(onSelectChannel).toHaveBeenCalledWith(recentEntry, undefined);
    await view.unmount();
  });

  it('keeps OSD preview visible when CH+ is pressed while OSD is initially hidden (#251)', async () => {
    const dispatcher = createTvRemoteDispatcher();
    const { videoHost } = makeFakeHost();
    const resolveStream = jest.fn(async (key: string) =>
      ok({ url: `http://sim.example.test/${key}.ts`, headers: {} }),
    );
    const onTargetChange = jest.fn();
    const catalog = {
      resolveStream,
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok(undefined)),
      recordRecentChannel: jest.fn(async () => undefined),
      nowNext: jest.fn(async () => []),
    } as unknown as PlayerScreenProps['catalog'];

    const view = await render(
      <TvRemoteContext.Provider value={dispatcher}>
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
                  catalog={catalog}
                  videoHost={videoHost}
                  target={makeLiveTarget(0)}
                  initialOsdHidden
                  liveChannelSwitchMode="preview"
                  onTargetChange={onTargetChange}
                  onExit={jest.fn()}
                />
              </ViewportProvider>
            </FormFactorProvider>
          </I18nProvider>
        </ThemeProvider>
      </TvRemoteContext.Provider>,
    );

    await waitFor(() => {
      expect(resolveStream).toHaveBeenCalledWith('x:s1:live:1');
    });

    // Press CH+ while OSD is hidden: OSD wakes and previewTarget must stay visible (not self-cancel).
    await act(async () => {
      dispatcher.dispatch({ key: 'channelUp', action: 'press', time: 0 }, false);
    });
    await waitFor(() => {
      expect(screen.getByTestId('player-preview-badge')).toBeTruthy();
      expect(screen.getByTestId('osd-title').props.children).toBe('Channel B');
    });
    expect(onTargetChange).not.toHaveBeenCalled();

    // Pressing Select confirms preview and tunes Channel B.
    await act(async () => {
      dispatcher.dispatch({ key: 'select', action: 'press', time: 0 }, false);
    });
    await waitFor(() => {
      expect(onTargetChange).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'x:s1:live:2' }),
      );
    });
    await view.unmount();
  });

  it('switches PlayerChannelDrawer between All and Recent on TV D-pad Left/Right (#53)', async () => {
    const dispatcher = createTvRemoteDispatcher();
    const recentEntry = ENTRIES[2];
    if (!recentEntry) throw new Error('missing recent entry');
    const fetchRecentChannels = jest.fn(async () => [recentEntry] as readonly PlayableEntry[]);
    const onSelectChannel = jest.fn();

    const view = await render(
      <TvRemoteContext.Provider value={dispatcher}>
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
                <PlayerChannelDrawer
                  visible
                  playlist={makeLiveTarget(0).playlist}
                  currentItemKey="x:s1:live:1"
                  formFactor="tv"
                  isTv
                  i18n={createAppI18n('en')}
                  fetchRecentChannels={fetchRecentChannels}
                  onSelectChannel={onSelectChannel}
                  onClose={jest.fn()}
                />
              </ViewportProvider>
            </FormFactorProvider>
          </I18nProvider>
        </ThemeProvider>
      </TvRemoteContext.Provider>,
    );

    // D-pad Right switches to Recent tab
    await act(async () => {
      dispatcher.dispatch({ key: 'right', action: 'press', time: 0 }, false);
    });
    await waitFor(() => {
      expect(screen.getByTestId('player-channel-recent-row-0')).toBeTruthy();
    });

    // D-pad Left switches back to All tab
    await act(async () => {
      dispatcher.dispatch({ key: 'left', action: 'press', time: 0 }, false);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('player-channel-recent-row-0')).toBeNull();
    });
    await view.unmount();
  });
});
