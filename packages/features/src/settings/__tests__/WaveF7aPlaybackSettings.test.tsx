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
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

interface HarnessProps {
  readonly store?: PreferencesStore;
  readonly viewport: ViewportOverride;
  readonly androidSource?: AndroidKeySource;
  readonly showAndroidDecoder?: boolean;
  readonly showNightModeDrc?: boolean;
}

function Harness({
  store: suppliedStore,
  viewport,
  androidSource,
  showAndroidDecoder = false,
  showNightModeDrc,
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
                {...(showNightModeDrc !== undefined ? { showNightModeDrc } : {})}
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

describe('Wave F7A / P7 Playback Settings UI (#115, #213)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('collapses Desktop Advanced audio by default and persists channel layout, passthrough, codecs, exclusive, and AC3 encode when expanded', async () => {
    const store = createMemoryPreferencesStore();
    const view = await render(<Harness store={store} viewport={DESKTOP_VIEWPORT} />);

    // Night-Mode DRC hidden on desktop
    expect(screen.queryByTestId('settings-playback-night-drc-night')).toBeNull();

    // Advanced audio starts collapsed
    expect(screen.queryByTestId('settings-playback-toggle-audio-passthrough')).toBeNull();

    // Expand Advanced audio
    await fireEvent.press(screen.getByTestId('settings-desktop-advanced-audio-toggle'));

    // Channel layout dropdown
    await fireEvent.press(screen.getByTestId('settings-playback-channel-layout-dropdown'));
    await fireEvent.press(screen.getByTestId('settings-playback-channel-layout-7.1'));

    // Passthrough sub-controls hidden until passthrough is ON
    expect(screen.queryByTestId('settings-playback-passthrough-codecs')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-audio-exclusive')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-audio-ac3-encode')).toBeNull();

    // Enable passthrough -> reveals codecs, exclusive, and AC3 encode
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-passthrough'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-playback-passthrough-codecs')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('settings-playback-passthrough-codec-truehd'));
    await fireEvent.press(screen.getByTestId('settings-playback-passthrough-codec-eac3'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-exclusive'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-ac3-encode'));

    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.audioPassthrough).toBe(true);
      expect(loaded.audioPassthroughCodecs).toEqual(['ac3', 'dts', 'truehd']);
      expect(loaded.audioExclusive).toBe(true);
      expect(loaded.audioAc3Encode).toBe(true);
      expect(loaded.audioChannelLayout).toBe('7.1');
    });

    await view.unmount();
  });

  it('shows Night-Mode DRC strictly on Android and hides it on iOS, tvOS, and Desktop (#115)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const androidStore = createMemoryPreferencesStore();
    const androidView = await render(<Harness store={androidStore} viewport={PHONE_VIEWPORT} />);

    expect(screen.queryByTestId('settings-section-desktop-audio')).toBeNull();
    expect(screen.getByTestId('settings-playback-night-drc-off')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-night-drc-light')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-night-drc-night')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-playback-night-drc-night'));
    await waitFor(async () => {
      expect((await androidStore.load()).nightModeDrc).toBe('night');
    });
    await androidView.unmount();

    jest.replaceProperty(Platform, 'OS', 'ios');
    const iosView = await render(<Harness viewport={PHONE_VIEWPORT} />);
    expect(screen.queryByTestId('settings-section-desktop-audio')).toBeNull();
    expect(screen.queryByTestId('settings-playback-night-drc-off')).toBeNull();
    expect(screen.queryByTestId('settings-playback-night-drc-night')).toBeNull();
    await iosView.unmount();

    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const tvosView = await render(<Harness viewport={TV_VIEWPORT} />);
    expect(screen.queryByTestId('settings-section-desktop-audio')).toBeNull();
    expect(screen.queryByTestId('settings-playback-night-drc-off')).toBeNull();
    expect(screen.queryByTestId('settings-playback-night-drc-night')).toBeNull();
    await tvosView.unmount();

    jest.replaceProperty(Platform, 'OS', 'web');
    const desktopView = await render(<Harness viewport={DESKTOP_VIEWPORT} />);
    expect(screen.queryByTestId('settings-playback-night-drc-night')).toBeNull();
    expect(screen.getByTestId('settings-section-desktop-audio')).toBeTruthy();
    await desktopView.unmount();
  });

  it('excludes Night-Mode DRC from TV D-pad rows when showNightModeDrc is false and includes it when true (#115)', async () => {
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

    // showNightModeDrc=false: row 7 should be toggle-auto-play-next (skipping Night-Mode DRC)
    const storeOff = createMemoryPreferencesStore();
    const viewOff = await render(
      <Harness
        store={storeOff}
        viewport={TV_VIEWPORT}
        androidSource={androidSource}
        showAndroidDecoder={false}
        showNightModeDrc={false}
      />,
    );

    expect(screen.queryByTestId('settings-playback-night-drc-off')).toBeNull();
    await pressKey(KEYCODE_DPAD_RIGHT);
    // Rows 0..2: seek, aspect, buffer; Rows 3..6: filterSdh, preferHevcDv, pitchLock, audioNorm -> Row 7: toggle-auto-play-next
    for (let i = 0; i < 7; i += 1) {
      await pressKey(KEYCODE_DPAD_DOWN);
    }
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      const loaded = await storeOff.load();
      expect(loaded.nightModeDrc).toBe('off');
      expect(loaded.autoPlayNextEpisode).toBe(false);
    });
    await viewOff.unmount();

    // showNightModeDrc=true: row 7 is Night-Mode DRC -> Right -> 'light' -> Select
    const storeOn = createMemoryPreferencesStore();
    const viewOn = await render(
      <Harness
        store={storeOn}
        viewport={TV_VIEWPORT}
        androidSource={androidSource}
        showAndroidDecoder={false}
        showNightModeDrc={true}
      />,
    );
    expect(screen.queryByTestId('settings-section-desktop-audio')).toBeNull();
    await pressKey(KEYCODE_DPAD_RIGHT);
    for (let i = 0; i < 7; i += 1) {
      await pressKey(KEYCODE_DPAD_DOWN);
    }
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await storeOn.load()).nightModeDrc).toBe('light');
    });
    await viewOn.unmount();
  });
});
