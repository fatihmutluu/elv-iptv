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
  DEFAULT_THEME_PRESET,
  I18nProvider,
  isThemePresetId,
  RemoteKeysProvider,
  THEME_PRESET_IDS,
  THEME_PRESETS,
  ThemeProvider,
  TvRemoteProvider,
  useTheme,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import {
  type SettingsPaneSlotProps,
  type SettingsPreferencesController,
  SettingsScreen,
  type SettingsSection,
} from '../index';
import { useTvSettingsNavigation } from '../useTvSettingsNavigation';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function ThemeProbe(): ReactElement {
  const theme = useTheme();
  return (
    <View>
      <Text testID="probe-preset">{theme.preset}</Text>
      <Text testID="probe-canvas">{theme.colors.bgCanvas}</Text>
      <Text testID="probe-font-scale">{String(theme.fontScale)}</Text>
      <Text testID="probe-reduce-motion">{String(theme.reduceMotion)}</Text>
    </View>
  );
}

interface HarnessProps {
  store?: PreferencesStore;
  viewport?: ViewportOverride;
  androidSource?: AndroidKeySource;
  initialSection?: SettingsSection;
  section?: SettingsSection;
  onSectionChange?: (next: SettingsSection) => void;
  onFocusTopNav?: () => void;
  isActiveScope?: boolean;
  onSourcesSlot?: (slot: SettingsPaneSlotProps) => void;
  onLicensesSlot?: (slot: SettingsPaneSlotProps) => void;
}

function SettingsTestHarness({
  store: suppliedStore,
  viewport,
  androidSource,
  initialSection,
  section,
  onSectionChange,
  onFocusTopNav,
  isActiveScope = true,
  onSourcesSlot,
  onLicensesSlot,
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
    <TvRemoteProvider>
      <ViewportProvider {...(viewport !== undefined ? { value: viewport } : {})}>
        <I18nProvider i18n={i18n}>
          <ThemeProvider
            preset={preset}
            fontScale={prefs.fontScale}
            reduceMotion={prefs.reduceMotion}
          >
            <ThemeProbe />
            <SettingsScreen
              preferences={controller}
              {...(section !== undefined ? { section } : {})}
              {...(initialSection !== undefined ? { initialSection } : {})}
              {...(onSectionChange !== undefined ? { onSectionChange } : {})}
              {...(onFocusTopNav !== undefined ? { onFocusTopNav } : {})}
              isActiveScope={isActiveScope}
              renderSources={(slot) => {
                onSourcesSlot?.(slot);
                return (
                  <View testID="mock-sources-pane">
                    <Text testID="mock-sources-active">{String(slot.isActiveScope)}</Text>
                  </View>
                );
              }}
              renderLicenses={(slot) => {
                onLicensesSlot?.(slot);
                return (
                  <View testID="mock-licenses-pane">
                    <Text testID="mock-licenses-active">{String(slot.isActiveScope)}</Text>
                  </View>
                );
              }}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );

  return androidSource ? (
    <RemoteKeysProvider android={androidSource}>{content}</RemoteKeysProvider>
  ) : (
    content
  );
}

describe('SettingsScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders Landscape 2-column sidebar, switches sections, and shows About ELV IPTV + Licenses without license pill', async () => {
    await render(
      <SettingsTestHarness
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      />,
    );

    expect(screen.getByTestId('settings-screen')).toBeTruthy();
    expect(screen.getByTestId('settings-sidebar')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-appearance').props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByTestId('settings-panel-appearance')).toBeTruthy();
    expect(screen.queryByTestId('settings-tab-remote')).toBeNull();

    await fireEvent.press(screen.getByTestId('settings-tab-sources'));
    expect(screen.getByTestId('settings-tab-sources').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('mock-sources-pane')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('settings-tab-licenses'));
    expect(screen.getByTestId('settings-tab-licenses').props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByTestId('settings-about-card')).toBeTruthy();
    expect(screen.queryByTestId('settings-about-license-badge')).toBeNull();
    expect(screen.getByTestId('mock-licenses-pane')).toBeTruthy();
  });

  it('renders Portrait horizontal tab strip without Remote Keys and switches sections', async () => {
    await render(
      <SettingsTestHarness
        viewport={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
        }}
      />,
    );

    expect(screen.getByTestId('settings-portrait-tabs')).toBeTruthy();
    expect(screen.getByTestId('settings-portrait-tabs-rail-scroll')).toBeTruthy();
    expect(screen.queryByTestId('settings-sidebar')).toBeNull();
    expect(screen.queryByTestId('settings-tab-remote')).toBeNull();
    expect(screen.getByTestId('settings-tab-appearance').props.accessibilityState.selected).toBe(
      true,
    );

    await fireEvent.press(screen.getByTestId('settings-tab-licenses'));
    expect(screen.getByTestId('settings-tab-licenses').props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByTestId('settings-about-card')).toBeTruthy();
  });

  it('updates Language dropdown, all 6 Theme presets, Font Scale, Reduce Motion, and scoped Appearance Reset live', async () => {
    await render(
      <SettingsTestHarness
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      />,
    );

    for (const presetId of THEME_PRESET_IDS) {
      expect(screen.getByTestId(`settings-theme-${presetId}`)).toBeTruthy();
    }

    // Switch Language to Turkish via dropdown -> UI updates immediately without restart
    await fireEvent.press(screen.getByTestId('settings-language-dropdown'));
    await fireEvent.press(screen.getByTestId('settings-lang-tr'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-tab-appearance')).toHaveTextContent('Görünüm');
      expect(screen.getByTestId('settings-tab-sources')).toHaveTextContent('Kaynaklar');
      expect(screen.getByTestId('settings-tab-licenses')).toHaveTextContent(
        'Hakkında ve Lisanslar',
      );
    });

    // Switch back to English via dropdown
    await fireEvent.press(screen.getByTestId('settings-language-dropdown'));
    await fireEvent.press(screen.getByTestId('settings-lang-en'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-tab-appearance')).toHaveTextContent('Appearance');
    });

    // Select High Contrast (AAA) theme
    await fireEvent.press(screen.getByTestId('settings-theme-highContrast'));
    await waitFor(() => {
      expect(screen.getByTestId('probe-preset')).toHaveTextContent('highContrast');
      expect(screen.getByTestId('probe-canvas')).toHaveTextContent(
        THEME_PRESETS.highContrast.bgCanvas,
      );
      expect(
        screen.getByTestId('settings-theme-highContrast').props.accessibilityState.selected,
      ).toBe(true);
    });

    // Change font scale to 120%
    await fireEvent.press(screen.getByTestId('settings-font-120'));
    await waitFor(() => {
      expect(screen.getByTestId('probe-font-scale')).toHaveTextContent('1.2');
      expect(screen.getByTestId('settings-font-120').props.accessibilityState.selected).toBe(true);
    });

    // Toggle reduce motion
    const toggle = screen.getByTestId('settings-toggle-reduce-motion');
    expect(toggle.props.accessibilityRole).toBe('switch');
    expect(toggle.props.accessibilityState.checked).toBe(false);
    await fireEvent.press(toggle);
    await waitFor(() => {
      expect(screen.getByTestId('probe-reduce-motion')).toHaveTextContent('true');
      expect(
        screen.getByTestId('settings-toggle-reduce-motion').props.accessibilityState.checked,
      ).toBe(true);
    });

    // Reset preferences restores Appearance defaults
    await fireEvent.press(screen.getByTestId('settings-reset-preferences'));
    await waitFor(() => {
      expect(screen.getByTestId('probe-preset')).toHaveTextContent('obsidianCrimson');
      expect(screen.getByTestId('probe-font-scale')).toHaveTextContent('1');
      expect(screen.getByTestId('probe-reduce-motion')).toHaveTextContent('false');
      expect(screen.getByTestId('settings-language-dropdown')).toHaveTextContent('System');
    });
  });

  it('supports 10-foot TV D-pad sidebar traversal, TV language dropdown modal, and embedded pane focus handoff', async () => {
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

    const onFocusTopNav = jest.fn();
    let latestLicensesSlot: SettingsPaneSlotProps | undefined;

    await render(
      <SettingsTestHarness
        androidSource={androidSource}
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
        onFocusTopNav={onFocusTopNav}
        onLicensesSlot={(slot) => {
          latestLicensesSlot = slot;
        }}
      />,
    );

    expect(
      screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();

    // Up at top edge of sidebar focuses Top Nav
    await pressKey(KEYCODE_DPAD_UP);
    expect(onFocusTopNav).toHaveBeenCalledTimes(1);

    // Right enters Appearance content pane (Language dropdown) -> Select opens TV modal -> Down x2 to 'tr' -> Select updates locale live
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('settings-language-dropdown-tv-modal')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('settings-tab-appearance')).toHaveTextContent('Görünüm');
    });

    // Left returns to sidebar
    await pressKey(KEYCODE_DPAD_LEFT);

    // Traverse all 9 sidebar tabs on TV (including Remote Keys) down to Licenses
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-playback').props.accessibilityState.selected).toBe(
      true,
    );
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-liveTv').props.accessibilityState.selected).toBe(true);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-remote').props.accessibilityState.selected).toBe(true);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-profiles').props.accessibilityState.selected).toBe(
      true,
    );
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-sources').props.accessibilityState.selected).toBe(true);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-account').props.accessibilityState.selected).toBe(true);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-feedback').props.accessibilityState.selected).toBe(
      true,
    );
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('settings-tab-licenses').props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByTestId('mock-licenses-active')).toHaveTextContent('false');

    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('mock-licenses-active')).toHaveTextContent('true');
    expect(
      screen.queryByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();

    await act(async () => {
      latestLicensesSlot?.onBack();
    });
    expect(screen.getByTestId('mock-licenses-active')).toHaveTextContent('false');
    expect(
      screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();

    await pressKey(KEYCODE_BACK);
    expect(onFocusTopNav).toHaveBeenCalledTimes(2);
  });

  it('starts in content pane on TV when opened directly on Sources (empty-catalog onboarding)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => {} };
      },
    };
    const onFocusTopNav = jest.fn();
    let latestSourcesSlot: SettingsPaneSlotProps | undefined;

    await render(
      <SettingsTestHarness
        androidSource={androidSource}
        initialSection="sources"
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
        onFocusTopNav={onFocusTopNav}
        onSourcesSlot={(slot) => {
          latestSourcesSlot = slot;
        }}
      />,
    );

    expect(screen.getByTestId('mock-sources-active')).toHaveTextContent('true');
    expect(
      screen.queryByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();

    await act(async () => {
      latestSourcesSlot?.onBack();
    });
    expect(screen.getByTestId('mock-sources-active')).toHaveTextContent('false');
    expect(
      screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();

    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
    });
    expect(onFocusTopNav).toHaveBeenCalledTimes(1);
  });

  it('disables native focusable on Appearance controls on TV and auto-scrolls focused rows in Wave P7 order', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const scrollToSpy = jest
      .spyOn(ScrollView.prototype, 'scrollTo')
      .mockImplementation(() => undefined);

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

    await render(
      <SettingsTestHarness
        androidSource={androidSource}
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 960,
          height: 540,
        }}
      />,
    );

    for (const id of [
      'settings-language-dropdown',
      'settings-font-90',
      'settings-font-100',
      'settings-font-110',
      'settings-font-120',
      'settings-ui-font-system',
      'settings-ui-font-atkinson',
      'settings-ui-font-opendyslexic',
      'settings-sub-font-system',
      'settings-sub-font-atkinson',
      'settings-sub-font-opendyslexic',
      'settings-overscan-x-dec',
      'settings-overscan-x-inc',
      'settings-overscan-y-dec',
      'settings-overscan-y-inc',
      'settings-tv-clock-always',
      'settings-tv-clock-menus',
      'settings-tv-clock-player',
      'settings-tv-clock-never',
      'settings-artwork-cache-dropdown',
      'settings-artwork-cache-clear',
      'settings-reset-preferences',
    ]) {
      expect(screen.getByTestId(id).props.focusable).toBe(false);
    }

    await fireEvent(screen.getByTestId('settings-section-theme'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 120, width: 640, height: 220 } },
    });
    await fireEvent(screen.getByTestId('settings-section-home-layout'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 360, width: 640, height: 240 } },
    });
    await fireEvent(screen.getByTestId('settings-section-font'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 620, width: 640, height: 180 } },
    });
    await fireEvent(screen.getByTestId('settings-toggle-reduce-motion'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 110, width: 600, height: 48 } },
    });
    await fireEvent(screen.getByTestId('settings-section-tv-display'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 820, width: 640, height: 180 } },
    });
    await fireEvent(screen.getByTestId('settings-section-artwork-cache'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 1020, width: 640, height: 120 } },
    });
    await fireEvent(screen.getByTestId('settings-section-diagnostics'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 1160, width: 640, height: 140 } },
    });
    await fireEvent(screen.getByTestId('settings-section-reset'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 1320, width: 640, height: 52 } },
    });

    // Row 0: Language dropdown -> y: 0
    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 0, animated: true });

    // Row 1-2: Theme -> Row 3: Home Layout Editor
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 348, animated: true });

    // Skip remaining 6 Home Layout rows -> Row 10: Font Scale -> font.y - 12 = 608
    for (let i = 0; i < 7; i += 1) {
      await pressKey(KEYCODE_DPAD_DOWN);
    }
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 608, animated: true });

    // UI Font, Subtitle Font -> Reduce Motion (620 + 110 - 12 = 718) -> Confirm Exit (Android)
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 718, animated: true });
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 718, animated: true });

    // TV Display (3 rows) -> 808
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 808, animated: true });
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);

    // Artwork Cache (dropdown + clear) -> 1008
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 1008, animated: true });
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 1008, animated: true });

    // Unified Diagnostics (1 row) -> 1148
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 1148, animated: true });

    // Reset (very bottom) -> 1308
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ y: 1308, animated: true });
  });

  it('preserves Settings content pane across transient PIN overlay blur when preservePaneOnBlur is true', async () => {
    const stateRef: { current: ReturnType<typeof useTvSettingsNavigation> | undefined } = {
      current: undefined,
    };
    const view = await render(
      <SettingsNavPreserveHarness isActiveScope preservePaneOnBlur={false} stateRef={stateRef} />,
    );
    expect(stateRef.current?.pane).toBe('nav');

    await act(async () => {
      stateRef.current?.enterContentPane();
    });
    expect(stateRef.current?.pane).toBe('content');

    await view.rerender(
      <SettingsNavPreserveHarness isActiveScope={false} preservePaneOnBlur stateRef={stateRef} />,
    );
    expect(stateRef.current?.pane).toBe('content');

    await view.rerender(
      <SettingsNavPreserveHarness isActiveScope preservePaneOnBlur={false} stateRef={stateRef} />,
    );
    expect(stateRef.current?.pane).toBe('content');

    await view.rerender(
      <SettingsNavPreserveHarness
        isActiveScope={false}
        preservePaneOnBlur={false}
        stateRef={stateRef}
      />,
    );
    expect(stateRef.current?.pane).toBe('nav');
    await view.unmount();
  });
});

function SettingsNavPreserveHarness({
  isActiveScope,
  preservePaneOnBlur,
  stateRef,
}: {
  readonly isActiveScope: boolean;
  readonly preservePaneOnBlur: boolean;
  readonly stateRef: { current: ReturnType<typeof useTvSettingsNavigation> | undefined };
}): null {
  stateRef.current = useTvSettingsNavigation({
    isTv: true,
    isActiveScope,
    section: 'profiles',
    onSectionChange: jest.fn(),
    preservePaneOnBlur,
  });
  return null;
}
