import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { type SettingsDropdownOption, SettingsDropdownRow } from '../SettingsDropdownRow';
import { computeDropdownPopoverPlacement } from '../SettingsOverlayPortal';

const OPTIONS: readonly SettingsDropdownOption<string>[] = [
  { value: 'system', label: 'System', testID: 'opt-system' },
  { value: 'en', label: 'English', testID: 'opt-en' },
  { value: 'tr', label: 'Türkçe', testID: 'opt-tr' },
];

function wrap(
  ui: ReactElement,
  isTv = false,
  dispatcher = createTvRemoteDispatcher(),
): ReactElement {
  return (
    <TvRemoteProvider dispatcher={dispatcher}>
      <ViewportProvider
        value={{
          formFactor: isTv ? 'tv' : 'desktop',
          orientation: 'landscape',
          inputModality: isTv ? 'tv' : 'pointer',
          width: isTv ? 1920 : 1280,
          height: isTv ? 1080 : 800,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>{ui}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

describe('SettingsDropdownRow', () => {
  it('opens an inline popover on desktop, marks active item, selects option, and renders accessory', async () => {
    const onSelect = jest.fn();
    await render(
      wrap(
        <SettingsDropdownRow
          testID="test-dropdown"
          title="Language"
          description="Pick a language"
          options={OPTIONS}
          selectedValue="en"
          isTv={false}
          onSelect={onSelect}
          accessory={<Text testID="dropdown-accessory">Refresh now</Text>}
        />,
      ),
    );

    expect(screen.getByTestId('test-dropdown')).toHaveTextContent('English');
    expect(screen.getByTestId('dropdown-accessory')).toHaveTextContent('Refresh now');
    expect(screen.queryByTestId('test-dropdown-menu')).toBeNull();

    await fireEvent.press(screen.getByTestId('test-dropdown'));
    expect(screen.getByTestId('test-dropdown-menu')).toBeTruthy();
    expect(screen.getByTestId('test-dropdown-check-1')).toBeTruthy();
    expect(screen.queryByTestId('test-dropdown-check-0')).toBeNull();

    await fireEvent.press(screen.getByTestId('opt-tr'));
    expect(onSelect).toHaveBeenCalledWith('tr');
    expect(screen.queryByTestId('test-dropdown-menu')).toBeNull();
  });

  it('closes inline popover when backdrop is pressed and displays fallbackLabel for legacy values', async () => {
    const onSelect = jest.fn();
    await render(
      wrap(
        <SettingsDropdownRow
          testID="refresh-dropdown"
          title="Catalog refresh"
          options={[
            { value: 3, label: 'Every 3 h', testID: 'opt-3' },
            { value: 6, label: 'Every 6 h', testID: 'opt-6' },
          ]}
          selectedValue={0}
          fallbackLabel="Manual only"
          isTv={false}
          onSelect={onSelect}
        />,
      ),
    );

    expect(screen.getByTestId('refresh-dropdown')).toHaveTextContent('Manual only');

    await fireEvent.press(screen.getByTestId('refresh-dropdown'));
    expect(screen.getByTestId('refresh-dropdown-menu')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('refresh-dropdown-backdrop'));
    expect(screen.queryByTestId('refresh-dropdown-menu')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens a focus-trapped TV modal on 10-ft TV and handles D-pad Up/Down/Select/Back', async () => {
    const dispatcher = createTvRemoteDispatcher();
    const onSelect = jest.fn();
    const onOpenChange = jest.fn();

    await render(
      wrap(
        <SettingsDropdownRow
          testID="tv-dropdown"
          title="Language"
          options={OPTIONS}
          selectedValue="system"
          isTv={true}
          focused={true}
          onSelect={onSelect}
          onOpenChange={onOpenChange}
        />,
        true,
        dispatcher,
      ),
    );

    expect(screen.getByTestId('tv-dropdown-focus-ring')).toBeTruthy();
    expect(screen.queryByTestId('tv-dropdown-tv-modal')).toBeNull();

    // Pressing trigger opens the TV modal trap
    await fireEvent.press(screen.getByTestId('tv-dropdown'));
    expect(screen.getByTestId('tv-dropdown-tv-modal')).toBeTruthy();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    // D-pad Down x2 (0 -> 1 -> 2 = Türkçe), Up x1 (-> 1 = English), Select -> selects 'en' and closes
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'down', time: 10 }, false);
      dispatcher.dispatch({ key: 'down', action: 'up', time: 20 }, false);
      dispatcher.dispatch({ key: 'down', action: 'down', time: 30 }, false);
      dispatcher.dispatch({ key: 'down', action: 'up', time: 40 }, false);
      dispatcher.dispatch({ key: 'up', action: 'down', time: 50 }, false);
      dispatcher.dispatch({ key: 'up', action: 'up', time: 60 }, false);
      dispatcher.dispatch({ key: 'select', action: 'down', time: 70 }, false);
      dispatcher.dispatch({ key: 'select', action: 'up', time: 80 }, false);
    });

    expect(onSelect).toHaveBeenCalledWith('en');
    expect(screen.queryByTestId('tv-dropdown-tv-modal')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    // Re-open and press Back -> closes without selecting
    await fireEvent.press(screen.getByTestId('tv-dropdown'));
    expect(screen.getByTestId('tv-dropdown-tv-modal')).toBeTruthy();
    await act(async () => {
      dispatcher.dispatch({ key: 'back', action: 'down', time: 90 }, false);
      dispatcher.dispatch({ key: 'back', action: 'up', time: 100 }, false);
    });
    expect(screen.queryByTestId('tv-dropdown-tv-modal')).toBeNull();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('opens web popover upward when trigger sits near bottom of Settings host and downward when space below is ample', () => {
    const host = { x: 0, y: 0, width: 1280, height: 720 };

    // Bottom row (e.g. Guide refresh / Speaker channel layout / Artwork Cache) near y = 650
    const bottomPlacement = computeDropdownPopoverPlacement(
      { x: 980, y: 650, width: 160, height: 40 },
      host,
      5,
    );
    expect(bottomPlacement.direction).toBe('up');
    expect(bottomPlacement.bottom).toBeGreaterThan(0);
    expect(bottomPlacement.top).toBeUndefined();

    // Top row (e.g. Language) near y = 120
    const topPlacement = computeDropdownPopoverPlacement(
      { x: 980, y: 120, width: 160, height: 40 },
      host,
      3,
    );
    expect(topPlacement.direction).toBe('down');
    expect(topPlacement.top).toBe(166);
    expect(topPlacement.bottom).toBeUndefined();
  });
});
