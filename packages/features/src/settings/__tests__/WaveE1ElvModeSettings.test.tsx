import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  ELV_CATEGORY_SOURCES,
  ELV_TITLE_FORMATS,
  ok,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type PreferencesStore,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { ElvModeSettingsPanel } from '../ElvModeSettingsPanel';
import { type SettingsPreferencesController, SettingsScreen, type SettingsSection } from '../index';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

interface HarnessProps {
  store?: PreferencesStore;
  viewport?: ViewportOverride;
  androidSource?: AndroidKeySource;
  initialSection?: SettingsSection;
  elvPreviewSlot?: ReactNode;
}

function ElvSettingsHarness({
  store: suppliedStore,
  viewport,
  androidSource,
  initialSection = 'elvMode',
  elvPreviewSlot,
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
      <ViewportProvider
        value={
          viewport ?? {
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }
        }
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <SettingsScreen
              preferences={controller}
              initialSection={initialSection}
              {...(elvPreviewSlot !== undefined ? { elvPreviewSlot } : {})}
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

describe('Settings -> ELV Mode Panel (Wave E1 #511)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders ELV Mode tab, previewSlot at top, master switch off by default with 7 disabled sub-controls, and enables all 7 controls when toggled on', async () => {
    const store = createMemoryPreferencesStore();
    await render(
      <ElvSettingsHarness
        store={store}
        elvPreviewSlot={
          <View testID="elv-preview-slot-probe">
            <Text>Wave E3 Interactive Preview</Text>
          </View>
        }
      />,
    );

    expect(screen.getByTestId('settings-tab-elvMode')).toBeTruthy();
    expect(screen.getByTestId('settings-panel-elvMode')).toBeTruthy();
    expect(screen.getByTestId('elv-preview-slot-probe')).toBeTruthy();
    expect(screen.queryByTestId('settings-elv-xray')).toBeNull();

    const master = screen.getByTestId('settings-elv-master-toggle');
    expect(master.props.accessibilityRole).toBe('switch');
    expect(master.props.accessibilityState.checked).toBe(false);

    const subControlIds = [
      'settings-elv-merge-versions',
      'settings-elv-enrich-metadata',
      'settings-elv-title-format',
      'settings-elv-category-source',
      'settings-elv-smart-recs',
      'settings-elv-live-enhance',
      'settings-elv-verify-quality',
    ] as const;

    for (const id of subControlIds) {
      expect(screen.getByTestId(id).props.accessibilityState.disabled).toBe(true);
    }

    // Enable master switch -> all 7 sub-controls unlock immediately; removed X-Ray stays absent
    await fireEvent.press(master);
    await waitFor(() => {
      expect(
        screen.getByTestId('settings-elv-master-toggle').props.accessibilityState.checked,
      ).toBe(true);
      for (const id of subControlIds) {
        expect(screen.getByTestId(id).props.accessibilityState.disabled).toBe(false);
      }
    });
    expect(screen.queryByTestId('settings-elv-xray')).toBeNull();

    // Toggle all 5 boolean sub-switches
    const togglePairs = [
      ['settings-elv-merge-versions', 'elvMergeVersions'],
      ['settings-elv-enrich-metadata', 'elvEnrichMetadata'],
      ['settings-elv-smart-recs', 'elvSmartRecommendations'],
      ['settings-elv-live-enhance', 'elvLiveEnhance'],
      ['settings-elv-verify-quality', 'elvVerifyRealQuality'],
    ] as const;

    for (const [testId, prefKey] of togglePairs) {
      expect(screen.getByTestId(testId).props.accessibilityState.checked).toBe(true);
      await fireEvent.press(screen.getByTestId(testId));
      await waitFor(async () => {
        expect(screen.getByTestId(testId).props.accessibilityState.checked).toBe(false);
        expect((await store.load())[prefKey]).toBe(false);
      });
    }
  });

  it('exposes all 7 ELV_TITLE_FORMATS and both ELV_CATEGORY_SOURCES via SettingsOverlayPortal dropdowns', async () => {
    const store = createMemoryPreferencesStore({ elvModeEnabled: true });
    await render(<ElvSettingsHarness store={store} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('settings-elv-master-toggle').props.accessibilityState.checked,
      ).toBe(true);
    });

    // Open Title Format dropdown and verify all 7 formats exist, then pick 'system_original'
    await fireEvent.press(screen.getByTestId('settings-elv-title-format'));
    for (const fmt of ELV_TITLE_FORMATS) {
      expect(screen.getByTestId(`settings-elv-title-format-${fmt}`)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId('settings-elv-title-format-system_original'));
    await waitFor(async () => {
      expect((await store.load()).elvTitleFormat).toBe('system_original');
    });

    // Open Category Source dropdown and verify both options exist, then pick 'provider'
    await fireEvent.press(screen.getByTestId('settings-elv-category-source'));
    for (const src of ELV_CATEGORY_SOURCES) {
      expect(screen.getByTestId(`settings-elv-category-source-${src}`)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId('settings-elv-category-source-provider'));
    await waitFor(async () => {
      expect((await store.load()).elvCategorySource).toBe('provider');
    });
  });

  it('supports 10-ft TV D-pad navigation through master toggle, sub-controls, and title format TV modal', async () => {
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

    const store = createMemoryPreferencesStore({ elvModeEnabled: false });
    await render(
      <ElvSettingsHarness
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

    // Right enters ELV Mode content pane on master toggle.
    // While elvModeEnabled is false, ELV_MODE_ROWS is collapsed to [['elv-master']] so Down stays on master!
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await store.load()).elvModeEnabled).toBe(true);
    });

    // Down -> Merge Versions -> Select toggles it off
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await store.load()).elvMergeVersions).toBe(false);
    });

    // Down (Enrich Metadata) -> Down (Title Format dropdown) -> Select opens TV modal -> Down to 'system' -> Select
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('settings-elv-title-format-tv-modal')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(async () => {
      expect((await store.load()).elvTitleFormat).toBe('system');
    });
  });

  it('closes any open TV dropdown when elvModeEnabled turns false (P2)', async () => {
    const onOpenTvDropdownChange = jest.fn();
    const i18n = createAppI18n('en');
    const makeController = (elvModeEnabled: boolean): SettingsPreferencesController => ({
      preferences: { ...DEFAULT_PREFERENCES, elvModeEnabled },
      updatePreferences: jest.fn(async () => ok({ ...DEFAULT_PREFERENCES, elvModeEnabled })),
      resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
    });

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <ElvModeSettingsPanel
              preferences={makeController(true)}
              openTvDropdownId="elv-title-format-dropdown"
              onOpenTvDropdownChange={onOpenTvDropdownChange}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    expect(onOpenTvDropdownChange).not.toHaveBeenCalled();

    await view.rerender(
      <ViewportProvider
        value={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <ElvModeSettingsPanel
              preferences={makeController(false)}
              openTvDropdownId="elv-title-format-dropdown"
              onOpenTvDropdownChange={onOpenTvDropdownChange}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(onOpenTvDropdownChange).toHaveBeenCalledWith(null);
    });
  });

  it('renders standalone ElvModeSettingsPanel with previewSlot cleanly', async () => {
    const i18n = createAppI18n('en');
    await render(
      <ViewportProvider>
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <ElvModeSettingsPanel previewSlot={<View testID="standalone-preview" />} />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );
    expect(screen.getByTestId('standalone-preview')).toBeTruthy();
    expect(screen.getByTestId('settings-elv-master-toggle')).toBeTruthy();
  });

  it('mounts the live 4-card ElvModeInteractivePreview by default and updates immediately when toggling master, merge, posters, or categories', async () => {
    const store = createMemoryPreferencesStore({ elvModeEnabled: false });
    await render(<ElvSettingsHarness store={store} />);

    // Default master OFF -> raw chaos posters & duplicate filenames
    expect(screen.getByTestId('elv-preview-root')).toBeTruthy();
    expect(screen.getByTestId('elv-preview-chaos-poster-0')).toBeTruthy();
    expect(screen.getByText('[TR] VELVET MERIDIAN 4K UHD HEVC')).toBeTruthy();

    // Enable master ELV Mode -> all 4 cards turn clean immediately
    await fireEvent.press(screen.getByTestId('settings-elv-master-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('elv-preview-clean-poster-0')).toBeTruthy();
      expect(screen.queryByTestId('elv-preview-chaos-poster-0')).toBeNull();
      expect(screen.getByText('Velvet Meridian')).toBeTruthy();
    });

    // Toggle Merge Versions OFF -> splits into 4 duplicate filenames while keeping clean posters
    await fireEvent.press(screen.getByTestId('settings-elv-merge-versions'));
    await waitFor(() => {
      expect(screen.getByTestId('elv-preview-clean-poster-0')).toBeTruthy();
      expect(screen.getByText('[TR] VELVET MERIDIAN 4K UHD HEVC')).toBeTruthy();
      expect(screen.getByText('VELVET_MERIDIAN_CAM_v2')).toBeTruthy();
    });

    // Toggle Enrich Metadata OFF -> switches to chaotic broken raw posters
    await fireEvent.press(screen.getByTestId('settings-elv-enrich-metadata'));
    await waitFor(() => {
      expect(screen.getByTestId('elv-preview-chaos-poster-0')).toBeTruthy();
      expect(screen.queryByTestId('elv-preview-clean-poster-0')).toBeNull();
    });

    // Switch Category Source to 'provider' -> shows chaotic raw IPTV folder names
    await fireEvent.press(screen.getByTestId('settings-elv-category-source'));
    await fireEvent.press(screen.getByTestId('settings-elv-category-source-provider'));
    await waitFor(() => {
      expect(screen.getByText('### === VIP VOD 2026 === ###')).toBeTruthy();
    });
  });
});
