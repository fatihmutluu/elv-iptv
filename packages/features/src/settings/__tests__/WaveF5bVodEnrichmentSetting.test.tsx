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
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, Text } from 'react-native';
import { type SettingsPreferencesController, SettingsScreen } from '../index';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

function createFakeAndroidKeys() {
  let listener: ((e: AndroidKeyEvent) => void) | undefined;
  const source: AndroidKeySource = {
    addListener: (l) => {
      listener = l;
      return {
        remove: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    source,
    tap(keyCode: number) {
      listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
      listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
    },
  };
}

function Harness({
  store: suppliedStore,
  viewport,
  androidSource,
}: {
  store?: PreferencesStore;
  viewport?: ViewportOverride;
  androidSource?: AndroidKeySource;
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

  const controller: SettingsPreferencesController = {
    preferences: prefs,
    updatePreferences: (patch: PreferencesPatch) => store.update(patch),
    resetPreferences: () => store.reset(),
  };

  const inner = (
    <TvRemoteProvider>
      <ViewportProvider {...(viewport !== undefined ? { value: viewport } : {})}>
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <Text testID="probe-vod-enrichment">{String(prefs.vodEnrichmentEnabled)}</Text>
            <SettingsScreen initialSection="appearance" preferences={controller} />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );

  if (androidSource) {
    return <RemoteKeysProvider android={androidSource}>{inner}</RemoteKeysProvider>;
  }
  return inner;
}

describe('Wave F5B opt-in VOD enrichment privacy toggle (#215)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults to disabled and toggles vodEnrichmentEnabled on press', async () => {
    const view = await render(
      <Harness viewport={{ width: 1280, height: 800, formFactor: 'desktop' }} />,
    );

    const toggle = screen.getByTestId('settings-vod-enrichment-toggle');
    expect(toggle.props.accessibilityState?.checked).toBe(false);
    expect(screen.getByTestId('probe-vod-enrichment')).toHaveTextContent('false');

    await fireEvent.press(toggle);
    await waitFor(() => {
      expect(screen.getByTestId('probe-vod-enrichment')).toHaveTextContent('true');
      expect(
        screen.getByTestId('settings-vod-enrichment-toggle').props.accessibilityState?.checked,
      ).toBe(true);
    });

    await fireEvent.press(screen.getByTestId('settings-vod-enrichment-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('probe-vod-enrichment')).toHaveTextContent('false');
    });

    await view.unmount();
  });

  it('reaches and toggles settings-vod-enrichment-toggle via 10-foot TV D-pad', async () => {
    const origOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const keys = createFakeAndroidKeys();
    try {
      const view = await render(
        <Harness
          viewport={{ width: 1920, height: 1080, formFactor: 'tv' }}
          androidSource={keys.source}
        />,
      );

      // Right enters Appearance pane row 0 (Language); Down x8 reaches toggle-vod-enrichment (row 8)
      const pressKey = async (code: number) => {
        await act(async () => {
          keys.tap(code);
        });
      };
      await pressKey(KEYCODE_DPAD_RIGHT);
      for (let i = 0; i < 8; i += 1) {
        await pressKey(KEYCODE_DPAD_DOWN);
      }
      await pressKey(KEYCODE_DPAD_CENTER);

      await waitFor(() => {
        expect(screen.getByTestId('probe-vod-enrichment')).toHaveTextContent('true');
      });

      await pressKey(KEYCODE_DPAD_CENTER);

      await waitFor(() => {
        expect(screen.getByTestId('probe-vod-enrichment')).toHaveTextContent('false');
      });

      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
    }
  });
});
