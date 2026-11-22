import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, TvRemoteProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { AudioDeviceInfo, HostKey } from '../../ports/video-host';
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

describe('Desktop Audio Output Picker & Always-on-Top Player Controls (#408)', () => {
  it('wires Always-on-Top pin button, T shortcut, and always-on-top HostKey with live state sync', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      anchorOnPlayPause: true,
    });
    let pinned = false;
    let onPinChange: ((next: boolean) => void) | undefined;
    let onHostKey: ((key: HostKey) => void) | undefined;
    const toggleAlwaysOnTop = jest.fn(() => {
      pinned = !pinned;
      onPinChange?.(pinned);
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
                    toggleAlwaysOnTop,
                    isAlwaysOnTop: () => pinned,
                    onAlwaysOnTopChange: (listener) => {
                      onPinChange = listener;
                      return () => {
                        onPinChange = undefined;
                      };
                    },
                    onHostKey: (listener) => {
                      onHostKey = listener;
                      return () => {
                        onHostKey = undefined;
                      };
                    },
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

    // Always-on-Top lives inside Player Settings sheet in Minimalist Cinema OSD (#408 / Wave C1)
    await fireEvent.press(await screen.findByTestId('player-settings-button'));
    const pinBtn = await screen.findByTestId('player-always-on-top-button');
    expect(pinBtn.props.accessibilityLabel).toContain('Pin window on top');

    await fireEvent.press(pinBtn);
    expect(toggleAlwaysOnTop).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('player-always-on-top-button').props.accessibilityLabel).toContain(
        'Unpin window',
      );
    });

    // Close settings so global HostKey 'always-on-top' & 't' shortcuts are active (not blocked by open sheet)
    await fireEvent.press(screen.getByTestId('player-settings-close'));

    // HostKey 'always-on-top' toggles pin state
    await act(async () => {
      onHostKey?.('always-on-top');
    });
    expect(toggleAlwaysOnTop).toHaveBeenCalledTimes(2);
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await waitFor(() => {
      expect(screen.getByTestId('player-always-on-top-button').props.accessibilityLabel).toContain(
        'Pin window on top',
      );
    });

    // Close settings so desktop fallback keyDown 't' toggles pin state when no sheet is open
    await fireEvent.press(screen.getByTestId('player-settings-close'));
    await fireEvent(screen.getByTestId('player-screen'), 'keyDown', {
      key: 't',
      preventDefault: jest.fn(),
    });
    expect(toggleAlwaysOnTop).toHaveBeenCalledTimes(3);

    // When settings sheet is open, 't' shortcut does NOT trigger
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await waitFor(() => expect(screen.getByTestId('player-settings-panel')).toBeTruthy());
    await fireEvent(screen.getByTestId('player-screen'), 'keyDown', {
      key: 't',
      preventDefault: jest.fn(),
    });
    expect(toggleAlwaysOnTop).toHaveBeenCalledTimes(3);
  });

  it('applies preferredAudioDevice on open, lists live audio devices in PlayerSettingsSheet, and persists selection', async () => {
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

    // Preferred audio device applied once on open
    await waitFor(() => {
      expect(setAudioDevice).toHaveBeenCalledWith('wasapi/hdmi');
    });

    await fireEvent.press(screen.getByTestId('player-settings-button'));
    const row = await screen.findByTestId('player-settings-row-audio-device');
    expect(row.props.accessibilityLabel).toContain('LG OLED HDMI');

    await fireEvent.press(row);
    expect(screen.getByTestId('player-settings-audio-device-auto')).toBeTruthy();
    expect(screen.getByTestId('player-settings-audio-device-0').props.accessibilityLabel).toBe(
      'LG OLED HDMI',
    );
    expect(
      screen.getByTestId('player-settings-audio-device-0').props.accessibilityState?.selected,
    ).toBe(true);

    // Selecting Studio Headphones updates engine and persists preference
    await fireEvent.press(screen.getByTestId('player-settings-audio-device-1'));
    expect(setAudioDevice).toHaveBeenCalledWith('wasapi/headphones');
    expect(onPersistAudioDevice).toHaveBeenCalledWith('wasapi/headphones');
    await waitFor(() => {
      expect(
        screen.getByTestId('player-settings-audio-device-1').props.accessibilityState?.selected,
      ).toBe(true);
    });
  });

  it('hides Audio output row in PlayerSettingsSheet when host exposes zero audio devices', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
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
    expect(screen.queryByTestId('player-settings-row-audio-device')).toBeNull();
    expect(screen.queryByTestId('player-always-on-top-button')).toBeNull();
  });
});
