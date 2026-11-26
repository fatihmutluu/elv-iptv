import { DEFAULT_PREFERENCES, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { LiveTvSettingsPanel } from '../LiveTvSettingsPanel';

describe('Wave C2 / P7 LiveTvSettingsPanel (#68, #251)', () => {
  it('renders Catalog & Guide auto-refresh dropdowns (3-48h) and TV-only CH+/CH- switching mode', async () => {
    const updatePreferences = jest.fn(async () => ok(DEFAULT_PREFERENCES));
    const desktopView = await render(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{
                formFactor: 'desktop',
                orientation: 'landscape',
                inputModality: 'pointer',
                width: 1280,
                height: 720,
              }}
            >
              <LiveTvSettingsPanel
                preferences={{
                  preferences: DEFAULT_PREFERENCES,
                  updatePreferences,
                  resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
                }}
              />
            </ViewportProvider>
          </FormFactorProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('settings-livetv-catalog-refresh-dropdown'));
    await fireEvent.press(screen.getByTestId('settings-livetv-catalog-refresh-6'));
    expect(updatePreferences).toHaveBeenCalledWith({ catalogRefreshHours: 6 });

    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-dropdown'));
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-3'));
    expect(updatePreferences).toHaveBeenCalledWith({ guideRefreshHours: 3 });

    expect(screen.queryByTestId('settings-livetv-channel-switch-preview')).toBeNull();
    await desktopView.unmount();

    await render(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <FormFactorProvider value="tv">
            <ViewportProvider
              value={{
                formFactor: 'tv',
                orientation: 'landscape',
                inputModality: 'tv',
                width: 1920,
                height: 1080,
              }}
            >
              <LiveTvSettingsPanel
                preferences={{
                  preferences: DEFAULT_PREFERENCES,
                  updatePreferences,
                  resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
                }}
              />
            </ViewportProvider>
          </FormFactorProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('settings-livetv-channel-switch-preview'));
    expect(updatePreferences).toHaveBeenCalledWith({ liveChannelSwitchMode: 'preview' });
  });
});
