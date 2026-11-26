import {
  createMemoryPreferencesStore,
  DEFAULT_HOME_LAYOUT,
  DEFAULT_PREFERENCES,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type PreferencesStore,
} from '@elv/domain';
import { createAppI18n, resolveLocale } from '@elv/i18n';
import {
  type ArtworkCacheAdapter,
  DEFAULT_THEME_PRESET,
  I18nProvider,
  isThemePresetId,
  ThemeProvider,
  TvRemoteProvider,
  UiAdaptersProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { buildAppearanceResetPatch } from '../AppearancePanel';
import { type SettingsPreferencesController, SettingsScreen, type SettingsSection } from '../index';

function Harness({
  store: suppliedStore,
  viewport = {
    formFactor: 'desktop',
    orientation: 'landscape',
    inputModality: 'pointer',
    width: 1280,
    height: 800,
  },
  artworkCache,
  initialSection = 'appearance',
  onRefreshCatalogNow,
  onRefreshGuideNow,
}: {
  readonly store?: PreferencesStore;
  readonly viewport?: ViewportOverride;
  readonly artworkCache?: ArtworkCacheAdapter;
  readonly initialSection?: SettingsSection;
  readonly onRefreshCatalogNow?: () => Promise<void> | void;
  readonly onRefreshGuideNow?: () => Promise<void> | void;
}): ReactElement {
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

  return (
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
                initialSection={initialSection}
                {...(onRefreshCatalogNow !== undefined ? { onRefreshCatalogNow } : {})}
                {...(onRefreshGuideNow !== undefined ? { onRefreshGuideNow } : {})}
                renderSources={() => <View testID="mock-sources-pane" />}
                renderLicenses={() => <View testID="mock-licenses-pane" />}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </TvRemoteProvider>
    </UiAdaptersProvider>
  );
}

describe('Wave P7 Settings Overhaul', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hides Remote Keys tab on desktop/phone/tablet and falls back to Appearance if initialSection is remote', async () => {
    const view = await render(<Harness initialSection="remote" />);
    expect(screen.queryByTestId('settings-tab-remote')).toBeNull();
    expect(screen.getByTestId('settings-panel-appearance')).toBeTruthy();
    await view.unmount();

    await render(
      <Harness
        initialSection="remote"
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      />,
    );
    expect(screen.getByTestId('settings-tab-remote')).toBeTruthy();
  });

  it('uses dropdowns for Language & Artwork Cache (64-512 MB + live usage), hides vodEnrichment, gates confirmExitOnBack to Android, and resets ONLY Appearance prefs', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const store = createMemoryPreferencesStore({
      seekStepSec: 30,
      defaultLiveMode: 'epg',
      themePreset: 'highContrast',
      fontScale: 1.2,
    });
    const setLimitBytes = jest.fn(async () => undefined);
    let currentBytes = 42 * 1024 * 1024;
    const stats = jest.fn(async () => ({
      bytes: currentBytes,
      entries: 120,
      maxBytes: 512 * 1024 * 1024,
    }));
    const clear = jest.fn(async () => {
      currentBytes = 0;
    });

    await render(<Harness store={store} artworkCache={{ setLimitBytes, clear, stats }} />);

    // VOD enrichment removed; confirmExitOnBack hidden on web/desktop
    expect(screen.queryByTestId('settings-vod-enrichment-toggle')).toBeNull();
    expect(screen.queryByTestId('settings-toggle-confirm-exit')).toBeNull();

    // Language dropdown with System, English, Türkçe
    await fireEvent.press(screen.getByTestId('settings-language-dropdown'));
    expect(screen.getByTestId('settings-lang-system')).toBeTruthy();
    expect(screen.getByTestId('settings-lang-en')).toHaveTextContent('English');
    expect(screen.getByTestId('settings-lang-tr')).toHaveTextContent('Türkçe');
    await fireEvent.press(screen.getByTestId('settings-lang-tr'));
    await waitFor(async () => {
      expect((await store.load()).locale).toBe('tr');
    });

    // Artwork cache dropdown includes 512 MB and displays live usage
    await waitFor(() => {
      expect(screen.getByTestId('settings-artwork-cache-usage')).toHaveTextContent(/42 MB/);
    });
    await fireEvent.press(screen.getByTestId('settings-artwork-cache-dropdown'));
    await fireEvent.press(screen.getByTestId('settings-artwork-cache-512'));
    await waitFor(async () => {
      expect((await store.load()).artworkCacheLimitMb).toBe(512);
    });
    expect(setLimitBytes).toHaveBeenCalledWith(512 * 1024 * 1024);

    // Clear refreshes usage to 0 MB
    await fireEvent.press(screen.getByTestId('settings-artwork-cache-clear'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-artwork-cache-usage')).toHaveTextContent(/0 MB/);
    });

    // Reset Appearance resets ONLY Appearance prefs and restores platform default cache (512 MB on desktop)
    await fireEvent.press(screen.getByTestId('settings-reset-preferences'));
    await waitFor(async () => {
      const loaded = await store.load();
      expect(loaded.locale).toBe('system');
      expect(loaded.themePreset).toBe('obsidianCrimson');
      expect(loaded.fontScale).toBe(1);
      expect(loaded.artworkCacheLimitMb).toBe(512);
      expect(loaded.homeLayout).toEqual(DEFAULT_HOME_LAYOUT);
      // Playback and Live TV preferences MUST be preserved!
      expect(loaded.seekStepSec).toBe(30);
      expect(loaded.defaultLiveMode).toBe('epg');
    });
  });

  it('shows confirmExitOnBack only on Android', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(
      <Harness
        viewport={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 393,
          height: 852,
        }}
      />,
    );
    expect(screen.getByTestId('settings-toggle-confirm-exit')).toBeTruthy();
  });

  it('removes deprecated Playback controls, hides preferHevcOverDolbyVision on desktop, and collapses Desktop Advanced audio by default', async () => {
    const store = createMemoryPreferencesStore({ preferredAudioDevice: 'wasapi/hdmi' });
    await render(<Harness store={store} initialSection="playback" />);

    // Removed settings are completely absent
    expect(screen.queryByTestId('settings-playback-audio-auto')).toBeNull();
    expect(screen.queryByTestId('settings-playback-subtitle-auto')).toBeNull();
    expect(screen.queryByTestId('settings-playback-subtitle-mode-smart')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-prefer-default-audio')).toBeNull();
    expect(screen.queryByTestId('settings-playback-deinterlace-auto')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-window-aspect-ratio-lock')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-minimize-to-tray')).toBeNull();
    expect(screen.queryByTestId('settings-playback-oled-0')).toBeNull();
    expect(screen.queryByTestId('settings-playback-still-watching-0')).toBeNull();
    expect(screen.queryByTestId('settings-playback-afr-off')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-auto-dynamic-range')).toBeNull();
    expect(screen.queryByTestId('settings-playback-delay-bucket-50')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-group-vod-versions')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-skip-back-subtitles')).toBeNull();
    // Hidden on desktop
    expect(screen.queryByTestId('settings-playback-toggle-prefer-hevc-dv')).toBeNull();

    // Desktop Advanced audio starts COLLAPSED
    expect(screen.getByTestId('settings-desktop-advanced-audio-toggle')).toBeTruthy();
    expect(screen.queryByTestId('settings-playback-audio-device-dropdown')).toBeNull();
    expect(screen.queryByTestId('settings-playback-channel-layout-dropdown')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-audio-passthrough')).toBeNull();

    // Expanding reveals Audio output device, Channel layout, and Passthrough toggle (sub-controls hidden while passthrough is OFF)
    await fireEvent.press(screen.getByTestId('settings-desktop-advanced-audio-toggle'));
    expect(screen.getByTestId('settings-playback-audio-device-dropdown')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-channel-layout-dropdown')).toBeTruthy();
    expect(screen.getByTestId('settings-playback-toggle-audio-passthrough')).toBeTruthy();
    expect(screen.queryByTestId('settings-playback-passthrough-codecs')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-audio-exclusive')).toBeNull();
    expect(screen.queryByTestId('settings-playback-toggle-audio-ac3-encode')).toBeNull();

    // Toggling Audio passthrough ON reveals codecs, exclusive, and AC3 encode
    await fireEvent.press(screen.getByTestId('settings-playback-toggle-audio-passthrough'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-playback-passthrough-codecs')).toBeTruthy();
      expect(screen.getByTestId('settings-playback-toggle-audio-exclusive')).toBeTruthy();
      expect(screen.getByTestId('settings-playback-toggle-audio-ac3-encode')).toBeTruthy();
    });
  });

  it('converts Live TV refresh intervals to 3-48h dropdowns with Refresh now buttons, removes clutter, and gates CH+/CH- to TV', async () => {
    const store = createMemoryPreferencesStore({ catalogRefreshHours: 0, guideRefreshHours: 12 });
    const onRefreshCatalogNow = jest.fn(async () => undefined);
    const onRefreshGuideNow = jest.fn(async () => undefined);

    const view = await render(
      <Harness
        store={store}
        initialSection="liveTv"
        onRefreshCatalogNow={onRefreshCatalogNow}
        onRefreshGuideNow={onRefreshGuideNow}
      />,
    );

    // Removed controls absent
    expect(screen.queryByTestId('settings-livetv-toggle-epg-genre-tints')).toBeNull();
    expect(screen.queryByTestId('settings-livetv-logo-backdrop-plate')).toBeNull();
    expect(screen.queryByTestId('settings-livetv-toggle-source-badges')).toBeNull();
    expect(screen.queryByTestId('settings-livetv-toggle-two-step-preview')).toBeNull();
    expect(screen.queryByTestId('settings-livetv-toggle-clean-titles')).toBeNull();
    expect(screen.queryByTestId('settings-livetv-toggle-collapse-variants')).toBeNull();
    expect(screen.queryByTestId('settings-livetv-manage-channels')).toBeNull();
    // CH+/CH- hidden on desktop
    expect(screen.queryByTestId('settings-livetv-channel-switch-instant')).toBeNull();

    // Legacy 0 shows gracefully, dropdown offers 3/6/12/24/48 h
    expect(screen.getByTestId('settings-livetv-catalog-refresh-dropdown')).toHaveTextContent(
      'Manual only',
    );
    await fireEvent.press(screen.getByTestId('settings-livetv-catalog-refresh-dropdown'));
    expect(screen.getByTestId('settings-livetv-catalog-refresh-3')).toBeTruthy();
    expect(screen.getByTestId('settings-livetv-catalog-refresh-48')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-livetv-catalog-refresh-3'));
    await waitFor(async () => {
      expect((await store.load()).catalogRefreshHours).toBe(3);
    });

    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-dropdown'));
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-48'));
    await waitFor(async () => {
      expect((await store.load()).guideRefreshHours).toBe(48);
    });

    // Inline Refresh now buttons call callbacks and show Refreshed feedback
    await fireEvent.press(screen.getByTestId('settings-livetv-catalog-refresh-now'));
    await waitFor(() => {
      expect(onRefreshCatalogNow).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('settings-livetv-catalog-refresh-now')).toHaveTextContent(
        'Refreshed',
      );
    });

    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-now'));
    await waitFor(() => {
      expect(onRefreshGuideNow).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('settings-livetv-guide-refresh-now')).toHaveTextContent(
        'Refreshed',
      );
    });
    await view.unmount();

    // CH+/CH- visible on TV
    await render(
      <Harness
        store={store}
        initialSection="liveTv"
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      />,
    );
    expect(screen.getByTestId('settings-livetv-channel-switch-instant')).toBeTruthy();
  });

  it('omits the license badge pill from AboutLicensesPanel while preserving notices', async () => {
    await render(<Harness initialSection="licenses" />);
    expect(screen.getByTestId('settings-about-card')).toBeTruthy();
    expect(screen.queryByTestId('settings-about-license-badge')).toBeNull();
    expect(screen.getByTestId('mock-licenses-pane')).toBeTruthy();
  });

  it('builds scoped Appearance reset patches with platform-specific artwork cache defaults (tv=128, mobile=256, desktop=512)', () => {
    expect(buildAppearanceResetPatch('desktop').platformDefaultMb).toBe(512);
    expect(buildAppearanceResetPatch('mobile').platformDefaultMb).toBe(256);
    expect(buildAppearanceResetPatch('tv').platformDefaultMb).toBe(128);
  });

  it('renders open dropdowns in SettingsScreen root overlay outlet above ScrollView, enforces single-open sibling switching, and dismisses via full-viewport backdrop on Android mobile & TV', async () => {
    // 1. Live TV sibling dropdown switching (Catalog refresh <-> Guide refresh)
    const liveView = await render(<Harness initialSection="liveTv" />);
    await fireEvent.press(screen.getByTestId('settings-livetv-catalog-refresh-dropdown'));
    expect(screen.getByTestId('settings-overlay-outlet')).toBeTruthy();
    expect(screen.getByTestId('settings-livetv-catalog-refresh-dropdown-menu')).toBeTruthy();
    expect(screen.queryByTestId('settings-livetv-guide-refresh-dropdown-menu')).toBeNull();

    // Opening sibling dropdown closes the first one cleanly (never two popovers simultaneously)
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-dropdown'));
    expect(screen.queryByTestId('settings-livetv-catalog-refresh-dropdown-menu')).toBeNull();
    expect(screen.getByTestId('settings-livetv-guide-refresh-dropdown-menu')).toBeTruthy();

    // Pressing backdrop dismisses cleanly
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-dropdown-backdrop'));
    expect(screen.queryByTestId('settings-livetv-guide-refresh-dropdown-menu')).toBeNull();
    await liveView.unmount();

    // 2. Appearance sibling dropdown switching (Language <-> Artwork Cache)
    const appearanceView = await render(<Harness initialSection="appearance" />);
    await fireEvent.press(screen.getByTestId('settings-language-dropdown'));
    expect(screen.getByTestId('settings-language-dropdown-menu')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-artwork-cache-dropdown'));
    expect(screen.queryByTestId('settings-language-dropdown-menu')).toBeNull();
    expect(screen.getByTestId('settings-artwork-cache-dropdown-menu')).toBeTruthy();
    await appearanceView.unmount();

    // 3. Desktop Advanced audio sibling dropdown switching (Audio device <-> Speaker channel layout)
    const playbackView = await render(<Harness initialSection="playback" />);
    await fireEvent.press(screen.getByTestId('settings-desktop-advanced-audio-toggle'));
    await fireEvent.press(screen.getByTestId('settings-playback-audio-device-dropdown'));
    expect(screen.getByTestId('settings-playback-audio-device-dropdown-menu')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-playback-channel-layout-dropdown'));
    expect(screen.queryByTestId('settings-playback-audio-device-dropdown-menu')).toBeNull();
    expect(screen.getByTestId('settings-playback-channel-layout-dropdown-menu')).toBeTruthy();
    await playbackView.unmount();

    // 4. Native Android mobile: renders sheet + full-viewport backdrop in root overlay outlet and dismisses on outside tap
    jest.replaceProperty(Platform, 'OS', 'android');
    const mobileView = await render(
      <Harness
        initialSection="liveTv"
        viewport={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 393,
          height: 852,
        }}
      />,
    );
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-dropdown'));
    expect(screen.getByTestId('settings-overlay-outlet')).toBeTruthy();
    expect(screen.getByTestId('settings-livetv-guide-refresh-dropdown-menu')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-dropdown-backdrop'));
    expect(screen.queryByTestId('settings-livetv-guide-refresh-dropdown-menu')).toBeNull();
    await mobileView.unmount();

    // 5. 10-ft TV: renders viewport-centered sheet in root overlay outlet above ScrollView
    const tvView = await render(
      <Harness
        initialSection="appearance"
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      />,
    );
    await fireEvent.press(screen.getByTestId('settings-artwork-cache-dropdown'));
    expect(screen.getByTestId('settings-overlay-outlet')).toBeTruthy();
    expect(screen.getByTestId('settings-artwork-cache-dropdown-tv-modal')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-artwork-cache-dropdown-backdrop'));
    expect(screen.queryByTestId('settings-artwork-cache-dropdown-tv-modal')).toBeNull();
    await tvView.unmount();
  });
});
