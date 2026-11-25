import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type PreferencesStore,
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
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { type SettingsPreferencesController, SettingsScreen } from '../index';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

interface HarnessProps {
  readonly store?: PreferencesStore;
  readonly viewport: ViewportOverride;
  readonly androidSource?: AndroidKeySource;
  readonly showAndroidDecoder?: boolean;
}

function Harness({
  store: suppliedStore,
  viewport,
  androidSource,
  showAndroidDecoder = false,
}: HarnessProps): ReactElement {
  const [store] = useState(() => suppliedStore ?? createMemoryPreferencesStore());
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

  const controller: SettingsPreferencesController = {
    preferences: prefs,
    updatePreferences: (patch: PreferencesPatch) => store.update(patch),
    resetPreferences: () => store.reset(),
  };

  const content = (
    <TvRemoteProvider>
      <FormFactorProvider value={viewport.formFactor}>
        <ViewportProvider value={viewport}>
          <I18nProvider i18n={i18n}>
            <ThemeProvider preset="obsidianCrimson">
              <SettingsScreen
                initialSection="playback"
                preferences={controller}
                showAndroidDecoder={showAndroidDecoder}
                renderSources={() => <View testID="mock-sources-pane" />}
                renderLicenses={() => <View testID="mock-licenses-pane" />}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>
    </TvRemoteProvider>
  );

  return androidSource ? (
    <RemoteKeysProvider android={androidSource}>{content}</RemoteKeysProvider>
  ) : (
    content
  );
}

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1280,
  height: 800,
};

const PHONE_VIEWPORT: ViewportOverride = {
  formFactor: 'phone',
  orientation: 'portrait',
  inputModality: 'touch',
  width: 393,
  height: 852,
};

const TV_VIEWPORT: ViewportOverride = {
  formFactor: 'tv',
  orientation: 'landscape',
  inputModality: 'tv',
  width: 1920,
  height: 1080,
};

describe('Wave F7A Playback Settings UI (#115, #116, #188, #213)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists AFR, Auto HDR, per-refresh-rate A/V delay, and Desktop audio passthrough on desktop while hiding Night-Mode DRC', async () => {
    const store = createMemoryPreferencesStore();
    const view = await render(<Harness store={store} viewport={DESKTOP_VIEWPORT} />);

    // AFR 3-way selector + Auto HDR toggle
    await fireEvent.press(screen.getByTestId('settings-playback-afr-always'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-auto-dynamic-range'));

    // Night-Mode DRC hidden on desktop
    expect(screen.queryByTestId('settings-playback-night-drc-night')).toBeNull();

    // Per-refresh-rate A/V delay bucket editor (±25 ms, reset to 0 ms)
    await fireEvent.press(screen.getByTestId('settings-playback-delay-bucket-50'));
    await fireEvent.press(screen.getByTestId('settings-playback-delay-inc'));
    await fireEvent.press(screen.getByTestId('settings-playback-delay-inc'));
    await waitFor(async () => {
      expect((await store.load()).audioDelayByRefreshRateMs).toEqual({ '50': 50 });
    });
    expect(screen.getByTestId('settings-playback-delay-value')).toHaveTextContent('50 Hz · +50 ms');

    await fireEvent.press(screen.getByTestId('settings-playback-delay-dec'));
    await waitFor(async () => {
      expect((await store.load()).audioDelayByRefreshRateMs).toEqual({ '50': 25 });
    });

    await fireEvent.press(screen.getByTestId('settings-playback-delay-reset'));
    await waitFor(async () => {
      expect((await store.load()).audioDelayByRefreshRateMs).toEqual({});
    });

    // Desktop Audio Output section: exclusive disabled until passthrough is enabled
    const exclusiveBefore = screen.getByTestId('settings-playback-toggle-audio-exclusive');
    expect(exclusiveBefore.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(exclusiveBefore);
    expect((await store.load()).audioExclusive).toBe(false);

    // Enable passthrough, toggle codecs (add truehd, remove eac3), enable exclusive + AC3 encode + 7.1
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-passthrough'));
    await waitFor(() => {
      expect(
        screen.getByTestId('settings-playback-toggle-audio-exclusive').props.accessibilityState
          ?.disabled,
      ).toBe(false);
    });
    await fireEvent.press(screen.getByTestId('settings-playback-passthrough-codec-truehd'));
    await fireEvent.press(screen.getByTestId('settings-playback-passthrough-codec-eac3'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-exclusive'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-ac3-encode'));
    await fireEvent.press(screen.getByTestId('settings-playback-channel-layout-7.1'));

    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.autoFrameRate).toBe('always');
      expect(loaded.autoDynamicRange).toBe(false);
      expect(loaded.audioPassthrough).toBe(true);
      expect(loaded.audioPassthroughCodecs).toEqual(['ac3', 'dts', 'truehd']);
      expect(loaded.audioExclusive).toBe(true);
      expect(loaded.audioAc3Encode).toBe(true);
      expect(loaded.audioChannelLayout).toBe('7.1');
    });

    await view.unmount();
  });

  it('shows Night-Mode DRC and hides Desktop Audio Output strictly on non-desktop form factors', async () => {
    const store = createMemoryPreferencesStore();
    const view = await render(<Harness store={store} viewport={PHONE_VIEWPORT} />);

    expect(screen.queryByTestId('settings-section-desktop-audio')).toBeNull();
    expect(screen.getByTestId('settings-playback-night-drc-off')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-night-drc-light')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-night-drc-night')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-playback-night-drc-night'));
    await waitFor(async () => {
      expect((await store.load()).nightModeDrc).toBe('night');
    });

    await view.unmount();
  });

  it('supports 10-foot TV D-pad navigation for AFR, Auto HDR, Night-Mode DRC, and left/right A/V delay stepper (#115, #116)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const store = createMemoryPreferencesStore();
    const view = await render(
      <Harness
        store={store}
        viewport={TV_VIEWPORT}
        androidSource={androidSource}
        showAndroidDecoder={false}
      />,
    );

    // Desktop audio output must never appear on TV
    expect(screen.queryByTestId('settings-section-desktop-audio')).toBeNull();

    // Enter Playback content pane (row 0) and navigate down 15 rows to AFR row:
    // 0..5 head (6 rows) + 6..14 cinema/osd/oled/stillWatching (9 rows) = row 15 (afr)
    await pressKey(KEYCODE_DPAD_RIGHT);
    for (let i = 0; i < 15; i += 1) {
      await pressKey(KEYCODE_DPAD_DOWN);
    }
    // Select AFR 'off' (col 0)
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await store.load()).autoFrameRate).toBe('off');
    });

    // Row 16: Auto HDR toggle -> press Center to toggle off
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await store.load()).autoDynamicRange).toBe(false);
    });

    // Row 17: Night-Mode DRC -> Right to 'light' -> Center
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await store.load()).nightModeDrc).toBe('light');
    });

    // Row 18: Refresh-rate delay buckets (col 1 = '24', Right -> col 2 = '25')
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_RIGHT);
    // Row 19: Delay stepper -> D-pad Right twice (+50 ms), Left once (+25 ms), Center resets (0 ms)
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await waitFor(async () => {
      expect((await store.load()).audioDelayByRefreshRateMs).toEqual({ '25': 50 });
    });

    await pressKey(KEYCODE_DPAD_LEFT);
    await waitFor(async () => {
      expect((await store.load()).audioDelayByRefreshRateMs).toEqual({ '25': 25 });
    });

    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await store.load()).audioDelayByRefreshRateMs).toEqual({});
    });

    await view.unmount();
  });
});
