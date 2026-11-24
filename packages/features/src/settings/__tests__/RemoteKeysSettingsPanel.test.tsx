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
import { Platform, ScrollView } from 'react-native';
import { KeymapProvider } from '../../shared';
import { RemoteKeysSettingsPanel } from '../RemoteKeysSettingsPanel';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_CENTER = 23;
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

  it('ignores stray release up events on TV capture and scrolls ScrollView as focusRow moves down (#33)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const scrollToSpy = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});

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
              formFactor: 'tv',
              orientation: 'landscape',
              inputModality: 'tv',
              width: 1920,
              height: 1080,
            }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <ThemeProvider preset="obsidianCrimson">
                <KeymapProvider keymapStore={store}>
                  <RemoteKeysSettingsPanel isActiveScope />
                </KeymapProvider>
              </ThemeProvider>
            </I18nProvider>
          </ViewportProvider>
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    scrollToSpy.mockClear();

    // Move down across several player action rows -> ScrollView scrolls cleanly into view
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_DPAD_DOWN, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_DOWN, canceled: false, ageMs: 15 });
      });
    }
    expect(scrollToSpy).toHaveBeenCalled();
    const scrolledPos = scrollToSpy.mock.calls.at(-1)?.[0] as { y?: number } | undefined;
    expect((scrolledPos?.y ?? 0) > 0).toBe(true);

    // Open capture via Rebind, then immediately send a stray `select` `up` without prior `down`
    await fireEvent.press(screen.getByTestId('remote-rebind-player.toggleMute'));
    expect(screen.getByTestId('remote-capture-overlay')).toBeTruthy();

    await act(async () => {
      keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 10 });
    });

    // Stray `up` MUST NOT trigger immutableWarning or close capture
    expect(screen.queryByTestId('remote-immutable-warning')).toBeNull();
    expect(screen.getByTestId('remote-capture-overlay')).toBeTruthy();
  });

  it('uses one unified capture-phase web listener without CaptureTvKeyInterceptor or keyup leak (#33)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);

    const listeners = new Map<
      string,
      Array<{ fn: (e: Record<string, unknown>) => void; capture: boolean }>
    >();
    const addSpy = jest.fn(
      (type: string, fn: (e: Record<string, unknown>) => void, capture = false) => {
        const list = listeners.get(type) ?? [];
        list.push({ fn, capture: Boolean(capture) });
        listeners.set(type, list);
      },
    );
    const removeSpy = jest.fn(
      (type: string, fn: (e: Record<string, unknown>) => void, capture = false) => {
        const list = listeners.get(type) ?? [];
        listeners.set(
          type,
          list.filter((entry) => entry.fn !== fn || entry.capture !== Boolean(capture)),
        );
      },
    );

    const origAdd = (globalThis as { addEventListener?: unknown }).addEventListener;
    const origRemove = (globalThis as { removeEventListener?: unknown }).removeEventListener;
    (globalThis as { addEventListener?: unknown }).addEventListener = addSpy;
    (globalThis as { removeEventListener?: unknown }).removeEventListener = removeSpy;

    try {
      const store = createMemoryStore();
      await render(
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
        </TvRemoteProvider>,
      );

      await fireEvent.press(screen.getByTestId('remote-rebind-player.toggleMute'));
      expect(screen.getByTestId('remote-capture-overlay')).toBeTruthy();
      // CaptureTvKeyInterceptor is NOT mounted on web (no double-capture)
      expect(screen.queryByTestId('remote-capture-tv-focus-anchor')).toBeNull();

      // Capture-phase keydown & keyup listeners are registered
      const keydownCapture = (listeners.get('keydown') ?? []).filter((l) => l.capture);
      const keyupCapture = (listeners.get('keyup') ?? []).filter((l) => l.capture);
      expect(keydownCapture.length).toBeGreaterThan(0);
      expect(keyupCapture.length).toBeGreaterThan(0);

      // Dispatching 'r' calls preventDefault + stopImmediatePropagation and rebinds once
      const preventDefault = jest.fn();
      const stopImmediatePropagation = jest.fn();
      await act(async () => {
        for (const l of [...keydownCapture]) {
          l.fn({ key: 'r', repeat: false, preventDefault, stopImmediatePropagation });
        }
      });

      expect(preventDefault).toHaveBeenCalled();
      expect(stopImmediatePropagation).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByTestId('remote-capture-overlay')).toBeNull();
        expect(screen.getByTestId('remote-binding-player.toggleMute')).toHaveTextContent('Red');
      });
    } finally {
      (globalThis as { addEventListener?: unknown }).addEventListener = origAdd;
      (globalThis as { removeEventListener?: unknown }).removeEventListener = origRemove;
    }
  });
});
