import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, TvRemoteProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { AudioDeviceInfo } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

const VOD_TARGET: PlayTarget = {
  itemKey: 'vod-1',
  sourceId: 'src-1',
  title: 'Cinema Feature',
  kind: 'vod',
};

const DEVICES: readonly AudioDeviceInfo[] = [
  { name: 'auto', description: 'Autoselect device' },
  { name: 'wasapi/hdmi', description: 'LG OLED HDMI' },
  { name: 'wasapi/headphones', description: 'Studio Headphones' },
];

describe('Desktop Audio Output Picker (#408 / Wave R4)', () => {
  it('applies preferredAudioDevice on open, lists live audio devices inside Audio settings, and persists selection', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      anchorOnPlayPause: true,
    });
    let currentDevice = 'auto';
    let onDevicesChange:
      | ((devices: readonly AudioDeviceInfo[], active: string) => void)
      | undefined;
    const setAudioDevice = jest.fn((name: string) => {
      currentDevice = name;
      onDevicesChange?.(DEVICES, currentDevice);
    });
    const onPersistAudioDevice = jest.fn();

    await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: jest.fn(async () =>
                    ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
                  ),
                  getProgress: jest.fn(async () => null),
                  saveProgress: jest.fn(),
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    renderSurface: () => <View testID="fake-surface" />,
                    getAudioDevices: () => DEVICES,
                    getActiveAudioDevice: () => currentDevice,
                    setAudioDevice,
                    onAudioDevicesChange: (listener) => {
                      onDevicesChange = listener;
                      return () => {
                        onDevicesChange = undefined;
                      };
                    },
                  }),
                }}
                target={VOD_TARGET}
                preferredAudioDevice="wasapi/hdmi"
                onPersistAudioDevice={onPersistAudioDevice}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(setAudioDevice).toHaveBeenCalledWith('wasapi/hdmi');
    });

    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.queryByTestId('player-always-on-top-button')).toBeNull();
    await fireEvent.press(await screen.findByTestId('player-settings-row-audio'));
    await fireEvent.press(await screen.findByTestId('player-settings-open-audio-settings'));

    expect(screen.getByTestId('player-settings-audio-device-auto')).toBeTruthy();
    expect(screen.getByTestId('player-settings-audio-device-0').props.accessibilityLabel).toBe(
      'LG OLED HDMI',
    );
    expect(
      screen.getByTestId('player-settings-audio-device-0').props.accessibilityState?.selected,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('player-settings-audio-device-1'));
    expect(setAudioDevice).toHaveBeenCalledWith('wasapi/headphones');
    expect(onPersistAudioDevice).toHaveBeenCalledWith('wasapi/headphones');
    await waitFor(() => {
      expect(
        screen.getByTestId('player-settings-audio-device-1').props.accessibilityState?.selected,
      ).toBe(true);
    });
  });

  it('omits Audio settings sub-menu when host exposes no audio devices, delay, normalization, or pitch lock', async () => {
    const manual = createManualClock();
    const { setAudioDelay: _dropDelay, ...engine } = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      anchorOnPlayPause: true,
    });

    await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: jest.fn(async () =>
                    ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
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
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await fireEvent.press(await screen.findByTestId('player-settings-button'));
    expect(screen.queryByTestId('player-always-on-top-button')).toBeNull();
    await fireEvent.press(await screen.findByTestId('player-settings-row-audio'));
    expect(screen.queryByTestId('player-settings-open-audio-settings')).toBeNull();
  });
});
