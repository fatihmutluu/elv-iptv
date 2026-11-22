import { createAppI18n } from '@elv/i18n';
import { buildTheme, I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ConnectionLimitDialog } from '../ConnectionLimitDialog';

describe('ConnectionLimitDialog (#87)', () => {
  it('states only in-app active stream when ownActiveCount > 0 and providerActiveCons is unknown, with 3 actions when stoppable', async () => {
    const onStopOther = jest.fn();
    const onCancel = jest.fn();
    const onContinueAnyway = jest.fn();
    const i18n = createAppI18n('en');

    const view = await render(
      <I18nProvider i18n={i18n}>
        <ConnectionLimitDialog
          check={{
            ownActiveCount: 1,
            maxConnections: 1,
            canStopOwnStream: true,
          }}
          onStopOther={onStopOther}
          onCancel={onCancel}
          onContinueAnyway={onContinueAnyway}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('connection-limit-dialog')).toBeTruthy();
    expect(screen.getByText('Connection limit warning')).toBeTruthy();
    const bodyText = screen.getByTestId('connection-limit-body').props.children;
    expect(String(bodyText)).toContain('Another stream is already playing in this app');
    // Must NEVER invent or mention a provider-reported count when undefined
    expect(screen.queryByText(/The provider reports/i)).toBeNull();

    await fireEvent.press(screen.getByTestId('connection-limit-stop-other'));
    await fireEvent.press(screen.getByTestId('connection-limit-cancel'));
    await fireEvent.press(screen.getByTestId('connection-limit-continue'));

    expect(onStopOther).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onContinueAnyway).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('explicitly states provider-reported count when providerActiveCons is known and offers 2 actions when no own stream is stoppable', async () => {
    const onCancel = jest.fn();
    const onContinueAnyway = jest.fn();
    const i18n = createAppI18n('en');

    const view = await render(
      <I18nProvider i18n={i18n}>
        <ConnectionLimitDialog
          check={{
            ownActiveCount: 0,
            maxConnections: 2,
            providerActiveCons: 2,
            canStopOwnStream: false,
          }}
          onCancel={onCancel}
          onContinueAnyway={onContinueAnyway}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('The provider reports 2 active streams (limit 2).')).toBeTruthy();
    expect(screen.queryByTestId('connection-limit-stop-other')).toBeNull();
    expect(screen.getByTestId('connection-limit-cancel')).toBeTruthy();
    expect(screen.getByTestId('connection-limit-continue')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('connection-limit-continue'));
    expect(onContinueAnyway).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('does not guess active counts when both ownActiveCount is 0 and providerActiveCons is undefined, and respects High Contrast theme + Turkish locale', async () => {
    const trI18n = createAppI18n('tr');
    const hcTheme = buildTheme({ preset: 'highContrast' });

    const view = await render(
      <ThemeProvider preset="highContrast">
        <I18nProvider i18n={trI18n}>
          <ConnectionLimitDialog
            check={{
              ownActiveCount: 0,
              maxConnections: 1,
              canStopOwnStream: false,
            }}
            onCancel={jest.fn()}
            onContinueAnyway={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText('Bağlantı sınırı uyarısı')).toBeTruthy();
    expect(
      screen.getByText(
        'Bu kaynak en fazla 1 eşzamanlı bağlantıya izin verir. Diğer cihazlardaki etkin bağlantılar doğrulanamadı.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('connection-limit-stop-other')).toBeNull();

    const panelStyle = StyleSheet.flatten(screen.getByTestId('connection-limit-panel').props.style);
    expect(panelStyle?.backgroundColor).toBe(hcTheme.colors.glassBg);
    await view.unmount();
  });

  it('omits the Stop other stream button when onStopOther is undefined even if canStopOwnStream is true', async () => {
    const i18n = createAppI18n('en');
    const view = await render(
      <I18nProvider i18n={i18n}>
        <ConnectionLimitDialog
          check={{
            ownActiveCount: 1,
            maxConnections: 1,
            canStopOwnStream: true,
          }}
          onCancel={jest.fn()}
          onContinueAnyway={jest.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId('connection-limit-stop-other')).toBeNull();
    expect(screen.getByTestId('connection-limit-cancel')).toBeTruthy();
    expect(screen.getByTestId('connection-limit-continue')).toBeTruthy();
    await view.unmount();
  });
});
