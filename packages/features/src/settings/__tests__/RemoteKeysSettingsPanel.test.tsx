import { createKeymapStore } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { KeymapProvider } from '../../shared';
import { RemoteKeysSettingsPanel } from '../RemoteKeysSettingsPanel';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_BACK = 4;
const KEYCODE_PROG_RED = 183;
const KEYCODE_PROG_GREEN = 184;

function createMemoryStore() {
  const map = new Map<string, string>();
  return createKeymapStore({
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  });
}

describe('RemoteKeysSettingsPanel (#33)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('switches contexts, captures valid bindings, rejects immutable nav keys, unbinds, and resets', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };
    const store = createMemoryStore();

    await render(
      <RemoteKeysProvider android={androidSource}>
        <TvRemoteProvider>
          <ViewportProvider
            value={{
              formFactor: 'desktop',
              orientation: 'landscape',
              inputModality: 'pointer',
              width: 1280,
              height: 720,
            }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <ThemeProvider preset="obsidianCrimson">
                <KeymapProvider keymapStore={store}>
                  <RemoteKeysSettingsPanel />
                </KeymapProvider>
              </ThemeProvider>
            </I18nProvider>
          </ViewportProvider>
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    // Default context is Player
    expect(screen.getByTestId('remote-action-row-player.togglePlayPause')).toBeTruthy();
    expect(screen.getByTestId('remote-binding-player.toggleMute')).toHaveTextContent('Yellow');

    // Open capture overlay for player.toggleMute
    await fireEvent.press(screen.getByTestId('remote-rebind-player.toggleMute'));
    expect(screen.getByTestId('remote-capture-overlay')).toBeTruthy();
    expect(screen.getByTestId('remote-capture-prompt')).toHaveTextContent(
      /Press any remote button/,
    );

    // Short-press D-pad Up is rejected with immutableWarning
    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_DPAD_UP, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_UP, canceled: false, ageMs: 20 });
    });
    expect(screen.getByTestId('remote-immutable-warning')).toBeTruthy();
    expect(screen.getByTestId('remote-capture-overlay')).toBeTruthy();

    // Valid Red key rebinds player.toggleMute and closes overlay
    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_PROG_RED, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_PROG_RED, canceled: false, ageMs: 20 });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('remote-capture-overlay')).toBeNull();
      expect(screen.getByTestId('remote-binding-player.toggleMute')).toHaveTextContent('Red');
    });

    // Long-press capture sets Long press badge
    jest.useFakeTimers();
    await fireEvent.press(screen.getByTestId('remote-rebind-player.lastChannel'));
    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_PROG_GREEN, canceled: false, ageMs: 0 });
      jest.advanceTimersByTime(550);
    });
    jest.useRealTimers();
    await waitFor(() => {
      expect(screen.queryByTestId('remote-capture-overlay')).toBeNull();
      expect(screen.getByTestId('remote-binding-player.lastChannel')).toHaveTextContent('Green');
      expect(screen.getByTestId('remote-long-badge-player.lastChannel')).toBeTruthy();
    });

    // Back cancels capture overlay cleanly
    await fireEvent.press(screen.getByTestId('remote-rebind-player.openInfo'));
    expect(screen.getByTestId('remote-capture-overlay')).toBeTruthy();
    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
    });
    expect(screen.queryByTestId('remote-capture-overlay')).toBeNull();

    // Clear unbinds action
    await fireEvent.press(screen.getByTestId('remote-clear-player.openInfo'));
    await waitFor(() => {
      expect(screen.getByTestId('remote-binding-player.openInfo')).toHaveTextContent('Unbound');
    });

    // Reset single action restores default
    await fireEvent.press(screen.getByTestId('remote-reset-player.openInfo'));
    await waitFor(() => {
      expect(screen.getByTestId('remote-binding-player.openInfo')).toHaveTextContent('Info');
    });

    // Switch context chips to Live TV and Global
    await fireEvent.press(screen.getByTestId('remote-context-live'));
    expect(screen.getByTestId('remote-action-row-live.toggleFavorite')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('remote-context-global'));
    expect(screen.getByTestId('remote-action-row-global.openHome')).toBeTruthy();

    // Reset all restores defaults across all contexts
    await fireEvent.press(screen.getByTestId('remote-reset-all'));
    await fireEvent.press(screen.getByTestId('remote-context-player'));
    await waitFor(() => {
      expect(screen.getByTestId('remote-binding-player.toggleMute')).toHaveTextContent('Yellow');
    });
  });
});
