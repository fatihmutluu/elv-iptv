import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  ok,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { LiveTvSettingsPanel } from '../LiveTvSettingsPanel';
import { PlaybackSettingsPanel } from '../PlaybackSettingsPanel';
import { activatePlaybackControl } from '../playback-controls';
import { SettingsScreen } from '../SettingsScreen';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

function createAndroidSource() {
  let listener: ((event: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener(cb) {
      listener = cb;
      return {
        remove() {
          listener = null;
        },
      };
    },
  };
  const sendKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
      listener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
    });
  };
  return { source, sendKey };
}

function PlaybackHarness(): ReactElement {
  const [store] = useState(() => createMemoryPreferencesStore());
  const [i18n] = useState(() => createAppI18n('en'));
  const [prefs, setPrefs] = useState<PreferencesSnapshot>(DEFAULT_PREFERENCES);

  useEffect(() => {
    let active = true;
    const unsub = store.subscribe((next) => {
      if (active) setPrefs(next);
    });
    void store.load().then((loaded) => {
      if (active) setPrefs(loaded);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [store]);

  return (
    <FormFactorProvider value="desktop">
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider preset="obsidianCrimson">
            <PlaybackSettingsPanel
              preferences={{
                preferences: prefs,
                updatePreferences: (patch: PreferencesPatch) => store.update(patch),
                resetPreferences: () => store.reset(),
              }}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </FormFactorProvider>
  );
}

describe('Wave Q7-B Settings controls', () => {
  it('toggles autoReplaceSingleConnection in PlaybackSettingsPanel and via TV activatePlaybackControl', async () => {
    const view = await render(<PlaybackHarness />);
    const toggle = screen.getByTestId('settings-playback-toggle-auto-replace-single-connection');
    expect(toggle.props.accessibilityState?.checked).toBe(false);

    await fireEvent.press(toggle);
    await waitFor(() => {
      expect(
        screen.getByTestId('settings-playback-toggle-auto-replace-single-connection').props
          .accessibilityState?.checked,
      ).toBe(true);
    });

    await view.unmount();

    const updatePreferences = jest.fn(async () => ok(DEFAULT_PREFERENCES));
    activatePlaybackControl('toggle-auto-replace-single-connection', {
      preferences: DEFAULT_PREFERENCES,
      updatePreferences,
      resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
    });
    expect(updatePreferences).toHaveBeenCalledWith({ autoReplaceSingleConnection: true });
  });

  it('renders Clear recent channels row in LiveTvSettingsPanel when handler is provided and shows inline Cleared confirmation', async () => {
    const onClearRecentChannels = jest.fn(async () => undefined);
    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{
                formFactor: 'desktop',
                orientation: 'landscape',
                inputModality: 'pointer',
                width: 1280,
                height: 800,
              }}
            >
              <LiveTvSettingsPanel
                preferences={{
                  preferences: DEFAULT_PREFERENCES,
                  updatePreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
                  resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
                }}
                onClearRecentChannels={onClearRecentChannels}
              />
            </ViewportProvider>
          </FormFactorProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    const btn = screen.getByTestId('settings-livetv-clear-recent-channels');
    await act(async () => {
      await fireEvent.press(btn);
    });

    expect(onClearRecentChannels).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('settings-livetv-clear-recent-channels-feedback')).toBeTruthy();
    });

    await view.unmount();
  });

  it('MAJOR-5: reaches Clear recent channels in Settings -> Live TV via 10-ft TV D-pad and triggers callback + feedback', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const { source, sendKey } = createAndroidSource();
    const onClearRecentChannels = jest.fn(async () => undefined);
    const view = await render(
      <RemoteKeysProvider android={source}>
        <TvRemoteProvider>
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <FormFactorProvider value="tv">
                <ViewportProvider
                  value={{
                    formFactor: 'tv',
                    orientation: 'landscape',
                    inputModality: 'tv',
                    width: 1920,
                    height: 1080,
                  }}
                >
                  <SettingsScreen
                    initialSection="liveTv"
                    preferences={{
                      preferences: DEFAULT_PREFERENCES,
                      updatePreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
                      resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
                    }}
                    onClearRecentChannels={onClearRecentChannels}
                  />
                </ViewportProvider>
              </FormFactorProvider>
            </I18nProvider>
          </ThemeProvider>
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    // Enter Live TV content pane from sidebar (Right -> Row 0: live-mode-*)
    await sendKey(KEYCODE_DPAD_RIGHT);
    // Navigate down 6 rows: 1=epg-span, 2=epg-density, 3=toggle-epg-show-clock, 4=catalog-refresh, 5=guide-refresh, 6=clear-recent-channels
    for (let i = 0; i < 6; i += 1) {
      await sendKey(KEYCODE_DPAD_DOWN);
    }

    // Activate focused Clear recent channels button via OK/Center
    await sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(onClearRecentChannels).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('settings-livetv-clear-recent-channels-feedback')).toBeTruthy();
    });

    await view.unmount();
    jest.restoreAllMocks();
  });
});
