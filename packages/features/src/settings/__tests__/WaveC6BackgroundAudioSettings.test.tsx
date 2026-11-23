import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { PlaybackSettingsPanel } from '../PlaybackSettingsPanel';

function PlaybackHarness({ viewport }: { readonly viewport: ViewportOverride }): ReactElement {
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
    <FormFactorProvider value={viewport.formFactor}>
      <ViewportProvider value={viewport}>
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

describe('Wave C6 Background audio playback settings toggle (#412)', () => {
  it('shows and toggles Background audio playback on phone', async () => {
    const view = await render(
      <PlaybackHarness
        viewport={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
        }}
      />,
    );

    const toggle = screen.getByTestId('settings-playback-toggle-background-audio');
    expect(toggle.props.accessibilityState?.checked).toBe(false);

    await fireEvent.press(toggle);
    await waitFor(() => {
      expect(
        screen.getByTestId('settings-playback-toggle-background-audio').props.accessibilityState
          ?.checked,
      ).toBe(true);
    });

    await fireEvent.press(screen.getByTestId('settings-playback-toggle-background-audio'));
    await waitFor(() => {
      expect(
        screen.getByTestId('settings-playback-toggle-background-audio').props.accessibilityState
          ?.checked,
      ).toBe(false);
    });

    await view.unmount();
  });

  it('shows Background audio playback toggle on tablet', async () => {
    const view = await render(
      <PlaybackHarness
        viewport={{
          formFactor: 'tablet',
          orientation: 'landscape',
          inputModality: 'touch',
          width: 1024,
          height: 768,
        }}
      />,
    );

    expect(screen.getByTestId('settings-playback-toggle-background-audio')).toBeTruthy();
    await view.unmount();
  });

  it('hides Background audio playback toggle on tv and desktop', async () => {
    const tvView = await render(
      <PlaybackHarness
        viewport={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      />,
    );
    expect(screen.queryByTestId('settings-playback-toggle-background-audio')).toBeNull();
    await tvView.unmount();

    const desktopView = await render(
      <PlaybackHarness
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      />,
    );
    expect(screen.queryByTestId('settings-playback-toggle-background-audio')).toBeNull();
    await desktopView.unmount();
  });
});
