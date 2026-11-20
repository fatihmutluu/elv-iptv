import { createMemoryPreferencesStore, DEFAULT_PREFERENCES } from '@elv/domain';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  RemoteKeysProvider,
  THEME_PRESETS,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useThemeController,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { AppProviders, usePreferences } from '../AppProviders';

function PreferencesProbe({ onMount }: { onMount?: () => void }) {
  const { preferences, ready, updatePreferences, resetPreferences } = usePreferences();
  const i18n = useI18n();
  const theme = useTheme();
  const themeCtrl = useThemeController();

  useEffect(() => {
    onMount?.();
  }, [onMount]);

  return (
    <View>
      <Text testID="pref-ready">{String(ready)}</Text>
      <Text testID="pref-locale">{preferences.locale}</Text>
      <Text testID="pref-preset">{preferences.themePreset}</Text>
      <Text testID="theme-preset">{theme.preset}</Text>
      <Text testID="theme-canvas">{theme.colors.bgCanvas}</Text>
      <Text testID="theme-font-scale">{String(theme.fontScale)}</Text>
      <Text testID="theme-reduce-motion">{String(theme.reduceMotion)}</Text>
      <Text testID="i18n-live">{i18n.t('nav.live')}</Text>
      <Pressable testID="switch-tr" onPress={() => void updatePreferences({ locale: 'tr' })} />
      <Pressable
        testID="switch-system"
        onPress={() => void updatePreferences({ locale: 'system' })}
      />
      <Pressable
        testID="ctrl-theme-sapphire"
        onPress={() => themeCtrl.setPreset('abyssalSapphire')}
      />
      <Pressable testID="ctrl-font-115" onPress={() => themeCtrl.setFontScale(1.15)} />
      <Pressable testID="ctrl-reduce-motion" onPress={() => themeCtrl.setReduceMotion(true)} />
      <Pressable testID="pref-reset" onPress={() => void resetPreferences()} />
    </View>
  );
}

function KeyConsumer({ id }: { id: string }) {
  useKeyInterpreter(() => undefined);
  return <Text testID={`key-consumer-${id}`}>{id}</Text>;
}

function MaybeCrash({ shouldCrash }: { shouldCrash: () => boolean }) {
  if (shouldCrash()) throw new Error('synthetic boom');
  return <Text testID="recovered-child">Recovered</Text>;
}

function MultiScreenHarness() {
  const [showSecond, setShowSecond] = useState(true);
  return (
    <View>
      <KeyConsumer id="a" />
      {showSecond ? <KeyConsumer id="b" /> : null}
      <Pressable testID="toggle-second" onPress={() => setShowSecond((v) => !v)} />
    </View>
  );
}

describe('AppProviders', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hydrates preferences and updates locale live without remounting children (#16)', async () => {
    const store = createMemoryPreferencesStore({
      themePreset: 'highContrast',
      fontScale: 1.1,
      reduceMotion: true,
      locale: 'system',
    });
    const onMount = jest.fn();

    await render(
      <AppProviders preferencesStore={store} systemLocale="en">
        <PreferencesProbe onMount={onMount} />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pref-ready')).toHaveTextContent('true');
    });

    expect(screen.getByTestId('theme-preset')).toHaveTextContent('highContrast');
    expect(screen.getByTestId('theme-canvas')).toHaveTextContent(
      THEME_PRESETS.highContrast.bgCanvas,
    );
    expect(screen.getByTestId('theme-font-scale')).toHaveTextContent('1.1');
    expect(screen.getByTestId('theme-reduce-motion')).toHaveTextContent('true');
    expect(screen.getByTestId('i18n-live')).toHaveTextContent('Live');
    expect(onMount).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('switch-tr'));
    await waitFor(() => {
      expect(screen.getByTestId('i18n-live')).toHaveTextContent('Canlı');
    });
    expect(onMount).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('switch-system'));
    await waitFor(() => {
      expect(screen.getByTestId('i18n-live')).toHaveTextContent('Live');
    });
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it('falls back to DEFAULT_THEME_PRESET on unknown themePreset and syncs theme controller updates back to store without loops', async () => {
    const store = createMemoryPreferencesStore({
      themePreset: 'nonexistent-theme-preset',
    });
    const updateSpy = jest.spyOn(store, 'update');

    await render(
      <AppProviders preferencesStore={store}>
        <PreferencesProbe />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pref-ready')).toHaveTextContent('true');
    });

    expect(screen.getByTestId('theme-preset')).toHaveTextContent('obsidianCrimson');
    expect(updateSpy).toHaveBeenCalledTimes(0);

    await fireEvent.press(screen.getByTestId('ctrl-theme-sapphire'));
    await waitFor(() => {
      expect(screen.getByTestId('pref-preset')).toHaveTextContent('abyssalSapphire');
      expect(screen.getByTestId('theme-preset')).toHaveTextContent('abyssalSapphire');
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('ctrl-font-115'));
    await waitFor(() => {
      expect(screen.getByTestId('theme-font-scale')).toHaveTextContent('1.15');
    });
    expect(updateSpy).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByTestId('ctrl-reduce-motion'));
    await waitFor(() => {
      expect(screen.getByTestId('theme-reduce-motion')).toHaveTextContent('true');
    });
    expect(updateSpy).toHaveBeenCalledTimes(3);

    await fireEvent.press(screen.getByTestId('pref-reset'));
    await waitFor(() => {
      expect(screen.getByTestId('pref-preset')).toHaveTextContent(DEFAULT_PREFERENCES.themePreset);
      expect(screen.getByTestId('theme-font-scale')).toHaveTextContent('1');
      expect(screen.getByTestId('theme-reduce-motion')).toHaveTextContent('false');
    });
  });

  it('catches render errors in ErrorBoundary, invokes onError, and recovers on retry', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = jest.fn();
    let shouldCrash = true;

    await render(
      <AppProviders onError={onError}>
        <MaybeCrash shouldCrash={() => shouldCrash} />
      </AppProviders>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toBe('synthetic boom');
    expect(screen.getByTestId('elv-error-boundary')).toBeTruthy();

    shouldCrash = false;
    await fireEvent.press(screen.getByTestId('elv-error-boundary-retry'));
    expect(screen.getByTestId('recovered-child')).toBeTruthy();

    consoleErrorSpy.mockRestore();
  });

  it('mounts a single TvRemoteProvider platform listener across mounting/unmounting child consumers', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const addListener = jest.fn((_listener: (e: AndroidKeyEvent) => void) => ({
      remove: jest.fn(),
    }));
    const androidSource: AndroidKeySource = { addListener };

    await render(
      <RemoteKeysProvider android={androidSource}>
        <AppProviders>
          <MultiScreenHarness />
        </AppProviders>
      </RemoteKeysProvider>,
    );

    expect(addListener).toHaveBeenCalledTimes(1);

    await act(async () => {
      await fireEvent.press(screen.getByTestId('toggle-second'));
    });
    expect(screen.queryByTestId('key-consumer-b')).toBeNull();
    expect(addListener).toHaveBeenCalledTimes(1);

    await act(async () => {
      await fireEvent.press(screen.getByTestId('toggle-second'));
    });
    expect(screen.getByTestId('key-consumer-b')).toBeTruthy();
    expect(addListener).toHaveBeenCalledTimes(1);
  });
});
