import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { DesktopAudioOutputConfig, DisplaySyncPolicy, LoadCommand } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';
import { PASSTHROUGH_FALLBACK_NOTICE_MS } from '../usePlayerDisplayAndAudioSync';
import { createManualClock } from './player-test-harness';

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
  itemKey: 'live:src-1:ch-f7a',
  sourceId: 'src-1',
  title: 'Cinema 4K',
  kind: 'live',
};

describe('Wave F7A PlayerScreen live display/audio sync, per-refresh-rate delay, fallback pill & DRM copy (#115, #116, #188, #199, #213, #214, #272)', () => {
  it('syncs displaySync, nightModeDrc, and desktopAudioOutput via LoadOptions and live host setters, and applies per-refresh-rate A/V delay without clobbering manual baseline', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      capabilities: {
        audioDelay: true,
        subtitleDelay: true,
      },
    });
    const loads: LoadCommand[] = [];
    const origLoad = engine.load.bind(engine);
    engine.load = (cmd: LoadCommand) => {
      loads.push(cmd);
      origLoad(cmd);
    };

    const setDisplaySync = jest.fn<void, [DisplaySyncPolicy]>();
    const setNightModeDrc = jest.fn();
    const setDesktopAudioOutput = jest.fn<void, [DesktopAudioOutputConfig]>();
    let fallbackListener: (() => void) | undefined;

    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
        setDisplaySync,
        setNightModeDrc,
        setDesktopAudioOutput,
        onPassthroughFallback: (listener) => {
          fallbackListener = listener;
          return () => {
            if (fallbackListener === listener) fallbackListener = undefined;
          };
        },
      }),
    };

    const saveTrackPreference = jest.fn(async () => undefined);
    const catalog: PlayerScreenProps['catalog'] = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://example.invalid/live/f7a.m3u8', headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => err(elvError('storage', 'test-noop'))),
      getTrackPreference: jest.fn(async () => null),
      saveTrackPreference,
    };

    const view = await render(
      wrapDesktop(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={LIVE_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          autoFrameRate="always"
          autoDynamicRange={false}
          nightModeDrc="night"
          audioDelayByRefreshRateMs={{ '23.976': -75, '50': 50 }}
          audioPassthrough={true}
          audioPassthroughCodecs={['ac3', 'dts', 'truehd']}
          audioExclusive={true}
          audioAc3Encode={false}
          audioChannelLayout="5.1"
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(loads).toHaveLength(1));

    // LoadOptions carries Wave F7A displaySync, nightModeDrc, and desktopAudioOutput
    expect(loads[0]?.options?.displaySync).toEqual({
      autoFrameRate: 'always',
      autoDynamicRange: false,
    });
    expect(loads[0]?.options?.nightModeDrc).toBe('night');
    expect(loads[0]?.options?.desktopAudioOutput).toEqual({
      passthrough: true,
      codecs: ['ac3', 'dts', 'truehd'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: '5.1',
    });

    // Live host setters invoked on open
    expect(setDisplaySync).toHaveBeenCalledWith({
      autoFrameRate: 'always',
      autoDynamicRange: false,
    });
    expect(setNightModeDrc).toHaveBeenCalledWith('night');
    expect(setDesktopAudioOutput).toHaveBeenCalledWith({
      passthrough: true,
      codecs: ['ac3', 'dts', 'truehd'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: '5.1',
    });

    // Stream starts playing at 23.976 fps -> effective delay = 0 + (-75) = -75 ms
    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({
        attempt: 1,
        type: 'mediaInfo',
        info: { width: 3840, height: 2160, fps: 23.976 },
      });
    });

    await waitFor(() => {
      expect(engine.commands).toContainEqual({ name: 'setAudioDelay', attempt: 1, delayMs: -75 });
    });

    // Manual A/V sync +50 ms persists +50 as manual baseline while applying effective -25 ms!
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(await screen.findByTestId('player-settings-row-audio-delay'));
    await fireEvent.press(await screen.findByTestId('player-settings-audio-delay-plus-50'));

    await waitFor(() => {
      expect(engine.commands).toContainEqual({ name: 'setAudioDelay', attempt: 1, delayMs: -25 });
      expect(saveTrackPreference).toHaveBeenCalledWith({
        scopeKey: LIVE_TARGET.itemKey,
        sourceId: LIVE_TARGET.sourceId,
        audioDelayMs: 50,
      });
    });

    // When video frame rate switches to 50 fps (+50 offset), manual baseline (+50) combines -> +100 ms!
    await act(async () => {
      engine.emit({
        attempt: 1,
        type: 'mediaInfo',
        info: { width: 1920, height: 1080, fps: 50 },
      });
    });

    await waitFor(() => {
      expect(engine.commands).toContainEqual({ name: 'setAudioDelay', attempt: 1, delayMs: 100 });
    });

    // Desktop passthrough fallback notice pill appears on event and auto-hides cleanly
    expect(screen.queryByTestId('player-passthrough-fallback-notice')).toBeNull();
    await act(async () => {
      fallbackListener?.();
    });
    expect(screen.getByTestId('player-passthrough-fallback-notice')).toHaveTextContent(
      'Audio passthrough unavailable on this device — switched to PCM.',
    );

    await act(async () => {
      manual.advance(PASSTHROUGH_FALLBACK_NOTICE_MS + 10);
    });
    expect(screen.queryByTestId('player-passthrough-fallback-notice')).toBeNull();

    await view.unmount();
  });

  it('renders localized DRM unsupported error copy when engine emits a drm error (#272)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      }),
    };
    const catalog: PlayerScreenProps['catalog'] = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://example.invalid/live/drm.mpd', headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => err(elvError('storage', 'test-noop'))),
    };

    const view = await render(
      wrapDesktop(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={LIVE_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));

    await act(async () => {
      engine.emit({ attempt: 1, type: 'error', error: { code: 'drm' } });
    });

    await waitFor(() => {
      expect(screen.getByText('Protected stream cannot be played on this device.')).toBeTruthy();
    });

    await view.unmount();
  });
});
