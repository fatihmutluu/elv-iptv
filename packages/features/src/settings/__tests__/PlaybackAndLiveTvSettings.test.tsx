import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type PreferencesStore,
} from '@elv/domain';
import { createAppI18n, resolveLocale } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  type ArtworkCacheAdapter,
  DEFAULT_THEME_PRESET,
  defaultLoadedArtworkUris,
  I18nProvider,
  isThemePresetId,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  UiAdaptersProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import {
  SETTINGS_SECTIONS,
  type SettingsPreferencesController,
  SettingsScreen,
  type SettingsSection,
} from '../index';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

interface HarnessProps {
  store?: PreferencesStore;
  viewport?: ViewportOverride;
  androidSource?: AndroidKeySource;
  artworkCache?: ArtworkCacheAdapter;
  initialSection?: SettingsSection;
  showAndroidDecoder?: boolean;
}

function Harness({
  store: suppliedStore,
  viewport = {
    formFactor: 'desktop',
    orientation: 'landscape',
    inputModality: 'pointer',
    width: 1280,
    height: 800,
  },
  androidSource,
  artworkCache,
  initialSection,
  showAndroidDecoder,
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

  const resolvedLocale = prefs.locale === 'system' ? 'en' : resolveLocale([prefs.locale]);
  useEffect(() => {
    i18n.setLocale(resolvedLocale);
  }, [i18n, resolvedLocale]);

  const controller: SettingsPreferencesController = {
    preferences: prefs,
    updatePreferences: (patch: PreferencesPatch) => store.update(patch),
    resetPreferences: () => store.reset(),
  };

  const preset = isThemePresetId(prefs.themePreset) ? prefs.themePreset : DEFAULT_THEME_PRESET;

  const content = (
    <UiAdaptersProvider adapters={artworkCache ? { artworkCache } : {}}>
      <TvRemoteProvider>
        <ViewportProvider value={viewport}>
          <I18nProvider i18n={i18n}>
            <ThemeProvider
              preset={preset}
              fontScale={prefs.fontScale}
              reduceMotion={prefs.reduceMotion}
            >
              <SettingsScreen
                preferences={controller}
                {...(initialSection !== undefined ? { initialSection } : {})}
                {...(showAndroidDecoder !== undefined ? { showAndroidDecoder } : {})}
                renderSources={() => <View testID="mock-sources-pane" />}
                renderLicenses={() => <View testID="mock-licenses-pane" />}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </TvRemoteProvider>
    </UiAdaptersProvider>
  );

  return androidSource ? (
    <RemoteKeysProvider android={androidSource}>{content}</RemoteKeysProvider>
  ) : (
    content
  );
}

describe('SettingsScreen Playback, Live TV & Guide, and Artwork Cache (#401, #405)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    defaultLoadedArtworkUris.clear();
  });

  it('exposes all 9 Settings sections in canonical order', async () => {
    expect(SETTINGS_SECTIONS).toEqual([
      'appearance',
      'playback',
      'liveTv',
      'remote',
      'profiles',
      'sources',
      'account',
      'feedback',
      'licenses',
    ]);

    await render(<Harness />);

    expect(screen.getByTestId('settings-tab-appearance')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-playback')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-liveTv')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-remote')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-profiles')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-sources')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-account')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-feedback')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-licenses')).toBeTruthy();
  });

  it('persists artwork cache limit and clears disk + in-memory loaded artwork cache (#405)', async () => {
    const store = createMemoryPreferencesStore();
    const setLimitBytes = jest.fn(async () => undefined);
    const clear = jest.fn(async () => undefined);
    defaultLoadedArtworkUris.markLoaded('https://cdn.example.invalid/poster.jpg');
    expect(defaultLoadedArtworkUris.size).toBe(1);

    await render(<Harness store={store} artworkCache={{ setLimitBytes, clear }} />);

    await fireEvent.press(screen.getByTestId('settings-artwork-cache-256'));
    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.artworkCacheLimitMb).toBe(256);
    });
    expect(setLimitBytes).toHaveBeenCalledWith(256 * 1024 * 1024);

    await fireEvent.press(screen.getByTestId('settings-artwork-cache-clear'));
    await waitFor(() => {
      expect(clear).toHaveBeenCalledTimes(1);
      expect(defaultLoadedArtworkUris.size).toBe(0);
      expect(screen.getByTestId('settings-artwork-cache-cleared')).toHaveTextContent(
        'Artwork cache cleared',
      );
    });
  });

  it('persists every Playback panel preference via updatePreferences (#401)', async () => {
    const store = createMemoryPreferencesStore();
    await render(<Harness store={store} initialSection="playback" />);

    expect(screen.getByTestId('settings-panel-playback')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-playback-audio-tr'));
    await fireEvent.press(screen.getByTestId('settings-playback-subtitle-en'));
    await fireEvent.press(screen.getByTestId('settings-playback-subtitle-mode-always'));
    await fireEvent.press(screen.getByTestId('settings-playback-seek-15'));
    await fireEvent.press(screen.getByTestId('settings-playback-aspect-fill'));
    await fireEvent.press(screen.getByTestId('settings-playback-buffer-large'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-auto-play-next'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-skip-back-subtitles'));

    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.preferredAudioLang).toBe('tr');
      expect(loaded.preferredSubtitleLang).toBe('en');
      expect(loaded.subtitleMode).toBe('always');
      expect(loaded.seekStepSec).toBe(15);
      expect(loaded.defaultResizeMode).toBe('fill');
      expect(loaded.bufferPreset).toBe('large');
      expect(loaded.autoPlayNextEpisode).toBe(false);
      expect(loaded.autoSubtitlesOnSkipBack).toBe(true);
    });
  });

  it('displays saved preferredAudioDevice in PlaybackSettingsPanel and resets to System default (#408)', async () => {
    const store = createMemoryPreferencesStore({ preferredAudioDevice: 'wasapi/hdmi' });
    await render(<Harness store={store} initialSection="playback" />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-playback-audio-device-current')).toBeTruthy();
    });
    expect(
      screen.getByTestId('settings-playback-audio-device-current').props.accessibilityState
        .selected,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('settings-playback-audio-device-auto'));
    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.preferredAudioDevice).toBe('auto');
    });
    expect(screen.queryByTestId('settings-playback-audio-device-current')).toBeNull();
  });

  it('persists every Live TV & Guide panel preference via updatePreferences (#401, #126, #145)', async () => {
    const store = createMemoryPreferencesStore();
    await render(<Harness store={store} initialSection="liveTv" />);

    expect(screen.getByTestId('settings-panel-liveTv')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-livetv-mode-epg'));
    await fireEvent.press(screen.getByTestId('settings-livetv-epg-span-6'));
    await fireEvent.press(screen.getByTestId('settings-livetv-toggle-epg-genre-tints'));
    await fireEvent.press(screen.getByTestId('settings-livetv-toggle-epg-show-clock'));
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-24'));
    await fireEvent.press(screen.getByTestId('settings-livetv-logo-backdrop-invert'));
    await fireEvent.press(screen.getByTestId('settings-livetv-toggle-source-badges'));
    await fireEvent.press(screen.getByTestId('settings-livetv-toggle-two-step-preview'));
    await fireEvent.press(screen.getByTestId('settings-livetv-toggle-clean-titles'));

    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.defaultLiveMode).toBe('epg');
      expect(loaded.epgTimeSpanHours).toBe(6);
      expect(loaded.epgGenreTints).toBe(false);
      expect(loaded.epgShowClock).toBe(false);
      expect(loaded.guideRefreshHours).toBe(24);
      expect(loaded.logoBackdropMode).toBe('invert');
      expect(loaded.showSourceBadges).toBe(false);
      expect(loaded.liveOkTwoStepPreview).toBe(true);
      expect(loaded.cleanChannelTitles).toBe(true);
    });
  });

  it('navigates and activates Playback and Live TV controls via 10-foot TV D-pad', async () => {
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
    await render(
      <Harness
        store={store}
        androidSource={androidSource}
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      />,
    );

    // Move sidebar from appearance -> playback
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-playback').props.accessibilityState.selected).toBe(
      true,
    );

    // Enter Playback panel -> row 0 (audio lang): Right to 'tr' -> Select
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);

    await waitFor(async () => {
      expect((await store.load()).preferredAudioLang).toBe('tr');
    });

    // Down x3 to skip interval row -> col 1 is 10s, move Right to 15s (col 2) -> Select
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);

    await waitFor(async () => {
      expect((await store.load()).seekStepSec).toBe(15);
    });

    // Return to sidebar via Left edge (col 2 -> col 1 -> col 0 -> sidebar)
    await pressKey(KEYCODE_DPAD_LEFT);
    await pressKey(KEYCODE_DPAD_LEFT);
    await pressKey(KEYCODE_DPAD_LEFT);

    // Move sidebar from playback -> liveTv
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-liveTv').props.accessibilityState.selected).toBe(true);

    // Enter Live TV panel -> row 0 (defaultLiveMode): Right to 'channels' -> Select
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);

    await waitFor(async () => {
      expect((await store.load()).defaultLiveMode).toBe('channels');
    });

    // Move down 10 rows to two-step preview toggle (row 10, after epgRowDensity row) -> Select
    for (let i = 0; i < 10; i += 1) {
      await pressKey(KEYCODE_DPAD_DOWN);
    }
    await pressKey(KEYCODE_DPAD_CENTER);

    await waitFor(async () => {
      expect((await store.load()).liveOkTwoStepPreview).toBe(true);
    });

    // Up back to row 0 stays inside Live TV panel cleanly
    await pressKey(KEYCODE_DPAD_UP);
    expect(screen.getByTestId('settings-panel-liveTv')).toBeTruthy();
  });

  it('shows Video decoder row only when showAndroidDecoder is enabled (#411)', async () => {
    const store = createMemoryPreferencesStore();
    const { unmount } = await render(
      <Harness store={store} initialSection="playback" showAndroidDecoder={false} />,
    );
    expect(screen.queryByTestId('settings-playback-decoder-auto')).toBeNull();
    await unmount();

    await render(<Harness store={store} initialSection="playback" showAndroidDecoder={true} />);
    expect(screen.getByTestId('settings-playback-decoder-auto')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-decoder-hardware')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-decoder-software')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-playback-decoder-software'));
    await waitFor(async () => {
      expect((await store.load()).androidDecoderMode).toBe('software');
    });
  });

  it('reaches Video decoder row via 10-foot Android TV D-pad and activates Hardware (#411)', async () => {
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

    const tvStore = createMemoryPreferencesStore();
    await render(
      <Harness
        store={tvStore}
        androidSource={androidSource}
        initialSection="playback"
        showAndroidDecoder={true}
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      />,
    );

    // Enter Playback content pane (row 0), move down 6 rows to Video decoder row, Right to Hardware, Select
    await pressKey(KEYCODE_DPAD_RIGHT);
    for (let i = 0; i < 6; i += 1) {
      await pressKey(KEYCODE_DPAD_DOWN);
    }
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);

    await waitFor(async () => {
      expect((await tvStore.load()).androidDecoderMode).toBe('hardware');
    });
  });

  it('persists all Wave C1 Playback preferences (#393, #310, #124, #160, #118)', async () => {
    const store = createMemoryPreferencesStore();
    await render(<Harness store={store} initialSection="playback" />);

    // 5-mode subtitle selector (#393)
    expect(screen.getByTestId('settings-playback-subtitle-mode-default')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-subtitle-mode-smart')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-subtitle-mode-onlyForced')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-subtitle-mode-always')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-subtitle-mode-off')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-playback-subtitle-mode-onlyForced'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-prefer-default-audio'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-filter-sdh'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-prefer-hevc-dv'));
    await fireEvent.press(screen.getByTestId('settings-playback-osd-time-endsAt'));
    await fireEvent.press(screen.getByTestId('settings-playback-oled-15'));
    await fireEvent.press(screen.getByTestId('settings-playback-still-watching-180'));

    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.subtitleMode).toBe('onlyForced');
      expect(loaded.preferDefaultAudioTrack).toBe(false);
      expect(loaded.filterSdhSubtitles).toBe(true);
      expect(loaded.preferHevcOverDolbyVision).toBe(true);
      expect(loaded.osdTimeDisplayMode).toBe('endsAt');
      expect(loaded.oledScreensaverTimeoutMin).toBe(15);
      expect(loaded.stillWatchingTimeoutMin).toBe(180);
    });
  });

  it('renders deinterlaceMode, pitchLock, audioNormalization, and desktop-only windowAspectRatioLock in PlaybackSettingsPanel (#243, #332)', async () => {
    const store = createMemoryPreferencesStore();
    const { unmount } = await render(<Harness store={store} initialSection="playback" />);

    expect(screen.getByTestId('settings-playback-deinterlace-off')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-deinterlace-auto')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-deinterlace-bwdif')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-toggle-pitch-lock')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-toggle-audio-normalization')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-toggle-window-aspect-ratio-lock')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-playback-deinterlace-bwdif'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-pitch-lock'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-normalization'));
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-window-aspect-ratio-lock'));

    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.deinterlaceMode).toBe('bwdif');
      expect(loaded.pitchLock).toBe(false);
      expect(loaded.audioNormalization).toBe(true);
      expect(loaded.windowAspectRatioLock).toBe(true);
    });
    await unmount();

    await render(
      <Harness
        store={store}
        initialSection="playback"
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      />,
    );
    expect(screen.queryByTestId('settings-playback-toggle-window-aspect-ratio-lock')).toBeNull();
    expect(screen.getByTestId('settings-playback-deinterlace-bwdif')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-toggle-pitch-lock')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-toggle-audio-normalization')).toBeTruthy();
  });

  it('hides External Player settings by default on tvOS (#406)', async () => {
    const origOs = Platform.OS;
    const origIsTv = Platform.isTV;
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    Object.defineProperty(Platform, 'isTV', { value: true, configurable: true });
    try {
      const store = createMemoryPreferencesStore();
      await render(
        <Harness
          store={store}
          initialSection="playback"
          viewport={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          }}
        />,
      );
      expect(screen.queryByTestId('settings-section-external-player')).toBeNull();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
      Object.defineProperty(Platform, 'isTV', { value: origIsTv, configurable: true });
    }
  });
});
