import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type PreferencesSnapshot,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { type SettingsPreferencesController, SettingsScreen } from '../index';

function SettingsWaveHarness({
  formFactor,
}: {
  readonly formFactor: 'tv' | 'desktop';
}): ReactElement {
  const [store] = useState(() => createMemoryPreferencesStore());
  const [i18n] = useState(() => createAppI18n('en'));
  const [prefs, setPrefs] = useState<PreferencesSnapshot>(DEFAULT_PREFERENCES);

  useEffect(() => {
    const unsub = store.subscribe(setPrefs);
    void store.load().then(setPrefs);
    return unsub;
  }, [store]);

  const controller: SettingsPreferencesController = {
    preferences: prefs,
    updatePreferences: (patch) => store.update(patch),
    resetPreferences: () => store.reset(),
  };

  return (
    <ViewportProvider value={{ formFactor, orientation: 'landscape', width: 1280, height: 720 }}>
      <I18nProvider i18n={i18n}>
        <ThemeProvider uiFontFamily={prefs.uiFontFamily}>
          <View>
            <Text testID="pref-ui-font">{prefs.uiFontFamily}</Text>
            <Text testID="pref-sub-font">{prefs.subtitleFontFamily}</Text>
            <Text testID="pref-overscan">{`${prefs.overscanX},${prefs.overscanY}`}</Text>
            <Text testID="pref-clock">{prefs.tvClockMode}</Text>
            <SettingsScreen preferences={controller} />
          </View>
        </ThemeProvider>
      </I18nProvider>
    </ViewportProvider>
  );
}

describe('Settings Wave C4B (#163, #133, #416)', () => {
  it('updates UI font, Subtitle font, TV-only overscanX/overscanY, and TV ambient clock mode', async () => {
    const tvView = await render(<SettingsWaveHarness formFactor="tv" />);

    await fireEvent.press(screen.getByTestId('settings-ui-font-atkinson'));
    await fireEvent.press(screen.getByTestId('settings-sub-font-opendyslexic'));
    await fireEvent.press(screen.getByTestId('settings-overscan-x-inc'));
    await fireEvent.press(screen.getByTestId('settings-overscan-y-dec'));
    await fireEvent.press(screen.getByTestId('settings-tv-clock-player'));

    await waitFor(() => {
      expect(screen.getByTestId('pref-ui-font')).toHaveTextContent('atkinson');
      expect(screen.getByTestId('pref-sub-font')).toHaveTextContent('opendyslexic');
      expect(screen.getByTestId('pref-overscan')).toHaveTextContent('0.06,0.04');
      expect(screen.getByTestId('pref-clock')).toHaveTextContent('player');
      expect(screen.getByTestId('settings-overscan-x-value')).toHaveTextContent('6%');
      expect(screen.getByTestId('settings-overscan-y-value')).toHaveTextContent('4%');
    });
    await tvView.unmount();

    const desktopView = await render(<SettingsWaveHarness formFactor="desktop" />);
    expect(screen.queryByTestId('settings-section-tv-display')).toBeNull();
    expect(screen.getByTestId('settings-ui-font-atkinson')).toBeTruthy();
    expect(screen.getByTestId('settings-sub-font-opendyslexic')).toBeTruthy();
    await desktopView.unmount();
  });
});
