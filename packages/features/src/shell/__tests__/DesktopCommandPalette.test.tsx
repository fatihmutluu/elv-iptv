import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { DesktopCommandPalette } from '../DesktopCommandPalette';

describe('DesktopCommandPalette (Wave Q7)', () => {
  it('renders tabs, settings sections, and actions, filters live, and runs selected command', async () => {
    const onClose = jest.fn();
    const onSelectTab = jest.fn();
    const onSelectSettingsSection = jest.fn();
    const onToggleElvMode = jest.fn();
    const onLockParentalControls = jest.fn();
    const onCycleThemePreset = jest.fn();
    const onOpenShortcutSheet = jest.fn();

    const i18n = createAppI18n('en');

    const renderPalette = (visible: boolean) => (
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <DesktopCommandPalette
              visible={visible}
              onClose={onClose}
              onSelectTab={onSelectTab}
              onSelectSettingsSection={onSelectSettingsSection}
              onToggleElvMode={onToggleElvMode}
              elvModeEnabled={false}
              canLockParental
              onLockParentalControls={onLockParentalControls}
              onCycleThemePreset={onCycleThemePreset}
              onOpenShortcutSheet={onOpenShortcutSheet}
              platform="Win32"
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    );

    const view = await render(renderPalette(true));

    const reopenPalette = async () => {
      await view.rerender(renderPalette(false));
      await view.rerender(renderPalette(true));
    };

    expect(screen.getByTestId('desktop-command-palette')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-tab-home')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-tab-live')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-tab-movie')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-tab-series')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-tab-search')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-tab-library')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-settings-appearance')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-settings-sources')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-action-elv-mode')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-action-lock-parental')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-action-cycle-theme')).toBeTruthy();
    expect(screen.getByTestId('command-palette-item-action-shortcuts')).toBeTruthy();

    // Filter to "sources" and execute
    await fireEvent.changeText(screen.getByTestId('command-palette-input'), 'sources');
    expect(screen.queryByTestId('command-palette-item-tab-home')).toBeNull();
    await fireEvent.press(screen.getByTestId('command-palette-item-settings-sources'));
    expect(onSelectSettingsSection).toHaveBeenCalledWith('sources');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Reopen resets one-shot guard and query
    await reopenPalette();
    await fireEvent.changeText(screen.getByTestId('command-palette-input'), 'zzzz-no-match');
    expect(screen.getByTestId('command-palette-empty')).toBeTruthy();

    // Clear query and trigger actions across separate reopen cycles
    await fireEvent.changeText(screen.getByTestId('command-palette-input'), '');
    await fireEvent.press(screen.getByTestId('command-palette-item-action-elv-mode'));
    expect(onToggleElvMode).toHaveBeenCalledTimes(1);

    await reopenPalette();
    await fireEvent.press(screen.getByTestId('command-palette-item-action-lock-parental'));
    expect(onLockParentalControls).toHaveBeenCalledTimes(1);

    await reopenPalette();
    await fireEvent.press(screen.getByTestId('command-palette-item-action-cycle-theme'));
    expect(onCycleThemePreset).toHaveBeenCalledTimes(1);

    await reopenPalette();
    await fireEvent.press(screen.getByTestId('command-palette-item-action-shortcuts'));
    expect(onOpenShortcutSheet).toHaveBeenCalledTimes(1);

    // Hide parental action when canLockParental is false
    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
      >
        <I18nProvider i18n={createAppI18n('tr')}>
          <ThemeProvider preset="highContrast">
            <DesktopCommandPalette
              visible
              onClose={onClose}
              onSelectTab={onSelectTab}
              onSelectSettingsSection={onSelectSettingsSection}
              onToggleElvMode={onToggleElvMode}
              elvModeEnabled
              canLockParental={false}
              onCycleThemePreset={onCycleThemePreset}
              onOpenShortcutSheet={onOpenShortcutSheet}
              platform="MacIntel"
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );
    expect(screen.queryByTestId('command-palette-item-action-lock-parental')).toBeNull();
    expect(screen.getByText('ELV Modunu kapat')).toBeTruthy();

    await view.unmount();
  });

  it('executes active command strictly once on Enter (no double-submit), ignores IME composition, and exposes dialog ARIA (BLOCKER-2, BLOCKER-3)', async () => {
    const originalOs = Platform.OS;
    const originalWindow = (globalThis as { window?: unknown }).window;
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const fakeWindow = {
      addEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      }),
      removeEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      }),
    };
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    try {
      const onClose = jest.fn();
      const onToggleElvMode = jest.fn();
      const view = await render(
        <ViewportProvider
          value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider>
              <DesktopCommandPalette
                visible
                onClose={onClose}
                onSelectTab={jest.fn()}
                onSelectSettingsSection={jest.fn()}
                onToggleElvMode={onToggleElvMode}
                elvModeEnabled={false}
                onCycleThemePreset={jest.fn()}
                onOpenShortcutSheet={jest.fn()}
                platform="Win32"
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>,
      );

      const dialog = screen.getByTestId('desktop-command-palette-dialog');
      expect(dialog.props.role).toBe('dialog');
      expect(dialog.props['aria-modal']).toBe(true);
      expect(dialog.props['aria-label']).toBe('Command palette');

      // TextInput must NOT wire onSubmitEditing (window keydown is the sole Enter owner)
      const input = screen.getByTestId('command-palette-input');
      expect(input.props.onSubmitEditing).toBeUndefined();

      await fireEvent.changeText(input, 'Enable ELV Mode');

      const emitKey = (ev: Record<string, unknown>) => {
        const preventDefault = jest.fn();
        const stopPropagation = jest.fn();
        for (const fn of [...(listeners.get('keydown') ?? [])]) {
          fn({ ...ev, preventDefault, stopPropagation });
        }
        return { preventDefault, stopPropagation };
      };

      // IME composition events MUST NOT execute commands or close palette
      await act(async () => {
        emitKey({ key: 'Enter', isComposing: true });
        emitKey({ key: 'Process', keyCode: 229 });
        emitKey({ key: 'Enter', keyCode: 229 });
      });
      expect(onToggleElvMode).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      // Pressing Enter twice before close settles executes strictly ONCE (one-shot guard)
      await act(async () => {
        emitKey({ key: 'Enter' });
        emitKey({ key: 'Enter' });
      });
      expect(onToggleElvMode).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });
});
