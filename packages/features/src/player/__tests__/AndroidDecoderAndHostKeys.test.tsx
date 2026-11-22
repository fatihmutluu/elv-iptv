import { type AndroidDecoderMode, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { LoadCommand } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, TvRemoteProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { HostKey, VideoResizeMode } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

const VOD_TARGET: PlayTarget = {
  itemKey: 'vod-p5-1',
  sourceId: 'src-1',
  title: 'Horizon Test Film',
  kind: 'vod',
};

const LIVE_TARGET: PlayTarget = {
  itemKey: 'live-p5-1',
  sourceId: 'src-1',
  title: 'News Channel',
  kind: 'live',
};

describe('Wave P5 host keys (#415) and Android video decoder quick switch (#411)', () => {
  it('handles aspect, volume-up, and volume-down HostKeys via PlayerScreen (#415)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      anchorOnPlayPause: true,
    });
    let onHostKey: ((key: HostKey) => void) | undefined;
    const seenResizeModes: Array<VideoResizeMode | undefined> = [];
    const setVolume = jest.fn();
    const onPersistVolume = jest.fn();

    await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="tablet">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: jest.fn(async () =>
                    ok({ url: 'http://sim.example.test/vod.mp4', headers: {} }),
                  ),
                  getProgress: jest.fn(async () => null),
                  saveProgress: jest.fn(),
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    renderSurface: (props) => {
                      seenResizeModes.push(props.resizeMode);
                      return <View testID="fake-surface" />;
                    },
                    setVolume,
                    onHostKey: (listener) => {
                      onHostKey = listener;
                      return () => {
                        onHostKey = undefined;
                      };
                    },
                  }),
                }}
                target={VOD_TARGET}
                initialVolume={50}
                onPersistVolume={onPersistVolume}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    expect(seenResizeModes.at(-1)).toBe('fit');

    await act(async () => {
      onHostKey?.('aspect');
    });
    expect(seenResizeModes.at(-1)).toBe('fill');

    await act(async () => {
      onHostKey?.('volume-up');
    });
    expect(setVolume).toHaveBeenLastCalledWith(55);
    expect(onPersistVolume).toHaveBeenLastCalledWith(55);

    await act(async () => {
      onHostKey?.('volume-down');
    });
    expect(setVolume).toHaveBeenLastCalledWith(50);
    expect(onPersistVolume).toHaveBeenLastCalledWith(50);
  });

  it('forwards androidDecoderMode on load and reloads VOD at current position when switched in PlayerSettingsSheet (#411)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      anchorOnPlayPause: true,
    });
    const loads: LoadCommand[] = [];
    const origLoad = engine.load.bind(engine);
    engine.load = (cmd: LoadCommand) => {
      loads.push(cmd);
      origLoad(cmd);
    };
    const onSelectAndroidDecoderMode = jest.fn<void, [AndroidDecoderMode]>();

    await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="phone">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: jest.fn(async () =>
                    ok({ url: 'http://sim.example.test/movie.mp4', headers: {} }),
                  ),
                  getProgress: jest.fn(async () => null),
                  saveProgress: jest.fn(),
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    renderSurface: () => <View testID="fake-surface" />,
                  }),
                }}
                target={VOD_TARGET}
                androidDecoderMode="hardware"
                onSelectAndroidDecoderMode={onSelectAndroidDecoderMode}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(loads).toHaveLength(1));
    expect(loads[0]).toMatchObject({
      url: 'http://sim.example.test/movie.mp4',
      options: { decoderMode: 'hardware' },
    });

    // Advance VOD playback position to 42,000 ms
    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({
        attempt: 1,
        type: 'clock',
        anchor: { positionMs: 42_000, atMs: manual.now(), rate: 1, durationMs: 600_000 },
      });
    });

    // Open PlayerSettingsSheet -> Video decoder submenu -> select Software
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await waitFor(() =>
      expect(screen.getByTestId('player-settings-row-video-decoder')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByTestId('player-settings-row-video-decoder'));
    await waitFor(() =>
      expect(screen.getByTestId('player-settings-decoder-software')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByTestId('player-settings-decoder-software'));

    expect(onSelectAndroidDecoderMode).toHaveBeenCalledWith('software');
    await waitFor(() => expect(loads).toHaveLength(2));
    expect(loads[1]).toMatchObject({
      url: 'http://sim.example.test/movie.mp4',
      startMs: 42_000,
      options: { decoderMode: 'software' },
    });
  });

  it('reloads Live stream at live edge (no startMs) when switching decoder mode and hides row when unsupported (#411)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const loads: LoadCommand[] = [];
    const origLoad = engine.load.bind(engine);
    engine.load = (cmd: LoadCommand) => {
      loads.push(cmd);
      origLoad(cmd);
    };
    const onSelectAndroidDecoderMode = jest.fn<void, [AndroidDecoderMode]>();

    const { unmount } = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="phone">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: jest.fn(async () =>
                    ok({ url: 'http://sim.example.test/live.ts', headers: {} }),
                  ),
                  getProgress: jest.fn(async () => null),
                  saveProgress: jest.fn(),
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    renderSurface: () => <View testID="fake-surface" />,
                  }),
                }}
                target={LIVE_TARGET}
                androidDecoderMode="auto"
                onSelectAndroidDecoderMode={onSelectAndroidDecoderMode}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(loads).toHaveLength(1));
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-settings-row-video-decoder'));
    await fireEvent.press(screen.getByTestId('player-settings-decoder-hardware'));

    expect(onSelectAndroidDecoderMode).toHaveBeenCalledWith('hardware');
    await waitFor(() => expect(loads).toHaveLength(2));
    expect(loads[1]).toMatchObject({
      url: 'http://sim.example.test/live.ts',
      options: { decoderMode: 'hardware' },
    });
    expect(loads[1]?.startMs).toBeUndefined();
    unmount();

    // Without androidDecoderMode props (e.g. iOS/tvOS/Desktop), row is hidden
    const engine2 = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="phone">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: jest.fn(async () =>
                    ok({ url: 'http://sim.example.test/live.ts', headers: {} }),
                  ),
                  getProgress: jest.fn(async () => null),
                  saveProgress: jest.fn(),
                }}
                videoHost={{
                  open: () => ({
                    engine: engine2,
                    renderSurface: () => <View testID="fake-surface" />,
                  }),
                }}
                target={LIVE_TARGET}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(engine2.commands.filter((c) => c.name === 'load')).toHaveLength(1));
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.queryByTestId('player-settings-row-video-decoder')).toBeNull();
  });
});
