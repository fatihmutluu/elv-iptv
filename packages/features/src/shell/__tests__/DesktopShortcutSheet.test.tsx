import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DesktopShortcutSheet } from '../DesktopShortcutSheet';

describe('DesktopShortcutSheet (Wave Q7)', () => {
  it('renders grouped shortcuts with OS-aware modifiers in EN and TR and closes on press', async () => {
    const onClose = jest.fn();
    const i18nEn = createAppI18n('en');

    const view = await render(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
      >
        <I18nProvider i18n={i18nEn}>
          <ThemeProvider>
            <DesktopShortcutSheet visible onClose={onClose} platform="Win32" />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    expect(screen.getByTestId('desktop-shortcut-sheet')).toBeTruthy();
    const dialog = screen.getByTestId('desktop-shortcut-sheet-dialog');
    expect(dialog.props.role).toBe('dialog');
    expect(dialog.props['aria-modal']).toBe(true);
    expect(dialog.props['aria-label']).toBe('Keyboard shortcuts');
    const backdrop = screen.getByTestId('desktop-shortcut-sheet-backdrop', {
      includeHiddenElements: true,
    });
    expect(backdrop.props.focusable).toBe(false);
    expect(screen.getByText('Keyboard shortcuts')).toBeTruthy();
    expect(screen.getByText('Navigation')).toBeTruthy();
    expect(screen.getByText('Search & commands')).toBeTruthy();
    expect(screen.getByText('Display & zoom')).toBeTruthy();
    expect(screen.getByText('Player')).toBeTruthy();
    expect(screen.getByText('Ctrl + K')).toBeTruthy();
    expect(screen.getByText('Alt + ←')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('desktop-shortcut-sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // macOS modifier keycaps and Turkish localization
    const i18nTr = createAppI18n('tr');
    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
      >
        <I18nProvider i18n={i18nTr}>
          <ThemeProvider preset="highContrast">
            <DesktopShortcutSheet visible onClose={onClose} platform="MacIntel" />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    expect(screen.getByText('Klavye kısayolları')).toBeTruthy();
    expect(screen.getByText('⌘ + K')).toBeTruthy();
    expect(screen.getByText('⌘ + [')).toBeTruthy();

    // Backdrop press closes modal (backdrop sits outside aria-modal dialog)
    await fireEvent.press(
      screen.getByTestId('desktop-shortcut-sheet-backdrop', { includeHiddenElements: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);

    // Returns null when hidden
    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
      >
        <I18nProvider i18n={i18nTr}>
          <ThemeProvider>
            <DesktopShortcutSheet visible={false} onClose={onClose} platform="MacIntel" />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );
    expect(screen.queryByTestId('desktop-shortcut-sheet')).toBeNull();
    await view.unmount();
  });
});
