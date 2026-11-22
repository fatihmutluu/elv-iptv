import { DEFAULT_PREFERENCES, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { LiveTvSettingsPanel } from '../LiveTvSettingsPanel';

describe('Wave C2 LiveTvSettingsPanel (#68, #251)', () => {
  it('renders Catalog auto-refresh, Manual only guide refresh, and CH+/CH- switching mode', async () => {
    const updatePreferences = jest.fn(async () => ok(DEFAULT_PREFERENCES));
    await render(
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

    await fireEvent.press(screen.getByTestId('settings-livetv-catalog-refresh-0'));
    expect(updatePreferences).toHaveBeenCalledWith({ catalogRefreshHours: 0 });
    await fireEvent.press(screen.getByTestId('settings-livetv-guide-refresh-0'));
    expect(updatePreferences).toHaveBeenCalledWith({ guideRefreshHours: 0 });
    await fireEvent.press(screen.getByTestId('settings-livetv-channel-switch-preview'));
    expect(updatePreferences).toHaveBeenCalledWith({ liveChannelSwitchMode: 'preview' });
  });
});
