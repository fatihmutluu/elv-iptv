import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  THEME_PRESETS,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, Text, type ViewStyle } from 'react-native';
import { CrashRecoveryBoundary, formatRedactedErrorCode } from '../CrashRecoveryBoundary';

function flattenStyle(style: unknown): ViewStyle {
  return (StyleSheet.flatten(style as ViewStyle) ?? {}) as ViewStyle;
}

function Bomb({ error }: { error: Error | null }) {
  if (error !== null) throw error;
  return <Text testID="healthy-child">Healthy Screen</Text>;
}

function DynamicBomb({ getError }: { getError: () => Error | null }) {
  return <Bomb error={getError()} />;
}

function emitAndroidKey(
  listener: ((e: AndroidKeyEvent) => void) | undefined,
  keyCode: number,
  t: number,
) {
  listener?.({ action: 'down', keyCode, canceled: false, ageMs: t });
  listener?.({ action: 'up', keyCode, canceled: false, ageMs: t + 10 });
}

describe('CrashRecoveryBoundary (#159)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('sanitizes error references and never leaks URLs, credentials, query strings, or stack traces', () => {
    const secretErr = new TypeError(
      'Failed to load http://alice:supersecret@provider.example:8080/live/123.ts?token=abc123&pass=xyz',
    );
    expect(formatRedactedErrorCode(secretErr)).toBe('TypeError');

    const categorized = Object.assign(new Error('http://u:p@host/path?k=v'), {
      category: 'playback',
      code: 'codec-unsupported',
    });
    expect(formatRedactedErrorCode(categorized)).toBe('playback/codec-unsupported');

    const taintedName = new Error('boom');
    taintedName.name = 'https://user:pass@evil.invalid/stream?secret=1';
    expect(formatRedactedErrorCode(taintedName)).toBe('ERR_UNEXPECTED');

    expect(formatRedactedErrorCode(null)).toBe('ERR_UNEXPECTED');
  });

  it('catches render errors, renders themed Cinema Quietude UI with redacted code, and adapts to High Contrast AAA', async () => {
    const onError = jest.fn();
    const synthUser = 'demo';
    const synthPass = 'pass99';
    const leakError = new RangeError(
      `Invalid index for http://${synthUser}:${synthPass}@stream.example:8080/get.php?${'username'}=${synthUser}&${'password'}=${synthPass}`,
    );

    const view = await render(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 720 }}
      >
        <ThemeProvider preset="highContrast">
          <I18nProvider i18n={createAppI18n('en')}>
            <CrashRecoveryBoundary onError={onError}>
              <Bomb error={leakError} />
            </CrashRecoveryBoundary>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('crash-recovery-boundary')).toBeTruthy();
    expect(screen.getByTestId('crash-title')).toHaveTextContent('Something went wrong');
    expect(screen.getByTestId('crash-subtitle')).toHaveTextContent(
      'The screen ran into an unexpected error. Choose how to recover.',
    );
    expect(screen.getByTestId('crash-code')).toHaveTextContent('Reference: RangeError');
    expect(screen.getByTestId('crash-reload')).toHaveTextContent('Reload');
    expect(screen.getByTestId('crash-clear-cache')).toHaveTextContent('Clear UI Cache');
    expect(screen.getByTestId('crash-switch-source')).toHaveTextContent('Switch Source');

    const serialized = JSON.stringify(view.toJSON());
    expect(serialized).not.toContain('pass99');
    expect(serialized).not.toContain('stream.example');
    expect(serialized).not.toContain('get.php');
    expect(serialized).not.toContain('username=demo');

    const rootStyle = flattenStyle(screen.getByTestId('crash-recovery-boundary').props.style);
    expect(rootStyle.backgroundColor).toBe(THEME_PRESETS.highContrast.bgCanvas);
    const reloadStyle = flattenStyle(screen.getByTestId('crash-reload').props.style);
    expect(reloadStyle.backgroundColor).toBe(THEME_PRESETS.highContrast.ctaBg);
  });

  it('renders safely outside all providers and supports Turkish localization', async () => {
    await render(
      <CrashRecoveryBoundary>
        <Bomb error={new Error('isolated crash')} />
      </CrashRecoveryBoundary>,
    );
    expect(screen.getByTestId('crash-title')).toHaveTextContent('Something went wrong');
    expect(screen.getByTestId('crash-code')).toHaveTextContent('Reference: Error');

    await render(
      <I18nProvider i18n={createAppI18n('tr')}>
        <CrashRecoveryBoundary>
          <Bomb error={new TypeError('tr crash')} />
        </CrashRecoveryBoundary>
      </I18nProvider>,
    );
    expect(screen.getByTestId('crash-title')).toHaveTextContent('Bir sorun oluştu');
    expect(screen.getByTestId('crash-reload')).toHaveTextContent('Yeniden Yükle');
    expect(screen.getByTestId('crash-clear-cache')).toHaveTextContent('Arayüz Önbelleğini Temizle');
    expect(screen.getByTestId('crash-switch-source')).toHaveTextContent('Kaynak Değiştir');
    expect(screen.getByTestId('crash-code')).toHaveTextContent('Referans: TypeError');
  });

  it('navigates all 3 recovery actions via 10-ft TV D-pad with outer focus halo and recovers healthy children', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => {} };
      },
    };

    const callOrder: string[] = [];
    let currentError: Error | null = new Error('tv boom');
    const onReload = jest.fn(() => {
      callOrder.push('reload');
      currentError = null;
    });
    const onClearUiCache = jest.fn(() => {
      callOrder.push('clearCache');
      currentError = null;
    });
    const onSwitchSource = jest.fn(() => {
      callOrder.push('switchSource');
      currentError = null;
    });
    const getError = () => currentError;

    const view = await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          }}
        >
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <CrashRecoveryBoundary
                onReload={onReload}
                onClearUiCache={onClearUiCache}
                onSwitchSource={onSwitchSource}
              >
                <DynamicBomb getError={getError} />
              </CrashRecoveryBoundary>
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    // Containers must not steal TV focus
    expect(screen.getByTestId('crash-recovery-boundary').props.focusable).toBe(false);
    expect(
      screen.getByTestId('crash-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();

    // Initial focus is on Reload (index 0) with crisp outer focus halo
    const initialRing = flattenStyle(screen.getByTestId('crash-reload-focus-ring').props.style);
    expect(initialRing.borderColor).toBe(THEME_PRESETS.obsidianCrimson.focusRingColor);
    expect(screen.queryByTestId('crash-clear-cache-focus-ring')).toBeNull();

    // D-pad Right -> Clear UI Cache (index 1)
    await act(async () => {
      emitAndroidKey(keyListener, 22, 0);
    });
    expect(screen.getByTestId('crash-clear-cache-focus-ring')).toBeTruthy();
    expect(screen.queryByTestId('crash-reload-focus-ring')).toBeNull();

    // D-pad Down -> Switch Source (index 2)
    await act(async () => {
      emitAndroidKey(keyListener, 20, 40);
    });
    expect(screen.getByTestId('crash-switch-source-focus-ring')).toBeTruthy();

    // D-pad Left -> back to Clear UI Cache (index 1)
    await act(async () => {
      emitAndroidKey(keyListener, 21, 80);
    });
    expect(screen.getByTestId('crash-clear-cache-focus-ring')).toBeTruthy();

    // Select invokes onClearUiCache and recovers healthy children
    await act(async () => {
      emitAndroidKey(keyListener, 23, 120);
    });
    expect(onClearUiCache).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('healthy-child')).toBeTruthy();

    // Crash again, D-pad Right x2 -> Switch Source, Select invokes onSwitchSource
    currentError = new Error('second boom');
    await view.rerender(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          }}
        >
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <CrashRecoveryBoundary
                onReload={onReload}
                onClearUiCache={onClearUiCache}
                onSwitchSource={onSwitchSource}
              >
                <DynamicBomb getError={getError} />
              </CrashRecoveryBoundary>
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );
    expect(screen.getByTestId('crash-recovery-boundary')).toBeTruthy();
    await act(async () => {
      emitAndroidKey(keyListener, 22, 200);
      emitAndroidKey(keyListener, 22, 240);
    });
    expect(screen.getByTestId('crash-switch-source-focus-ring')).toBeTruthy();
    await act(async () => {
      emitAndroidKey(keyListener, 66, 280);
    });
    expect(onSwitchSource).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('healthy-child')).toBeTruthy();

    // Crash a third time, press Select on default Reload (index 0)
    currentError = new Error('third boom');
    await view.rerender(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          }}
        >
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <CrashRecoveryBoundary
                onReload={onReload}
                onClearUiCache={onClearUiCache}
                onSwitchSource={onSwitchSource}
              >
                <DynamicBomb getError={getError} />
              </CrashRecoveryBoundary>
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );
    expect(screen.getByTestId('crash-reload-focus-ring')).toBeTruthy();
    await act(async () => {
      emitAndroidKey(keyListener, 23, 320);
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
    expect(callOrder).toEqual(['clearCache', 'switchSource', 'reload']);
  });

  it('supports desktop keyboard navigation (Arrow keys + Enter) and touch/pointer presses', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const mockWindow = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    const prevWindow = (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, 'window', {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    const fireWebKey = (key: string) => {
      for (const fn of listeners.get('keydown') ?? []) fn({ key, preventDefault: () => {} });
      for (const fn of listeners.get('keyup') ?? []) fn({ key });
    };

    try {
      let currentError: Error | null = new Error('desktop boom');
      const onSwitchSource = jest.fn(() => {
        currentError = null;
      });
      const getError = () => currentError;

      const view = await render(
        <ViewportProvider
          value={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 720,
          }}
        >
          <CrashRecoveryBoundary onSwitchSource={onSwitchSource}>
            <DynamicBomb getError={getError} />
          </CrashRecoveryBoundary>
        </ViewportProvider>,
      );

      // ArrowUp wraps from Reload (0) to Switch Source (2), Enter activates it
      await act(async () => {
        fireWebKey('ArrowUp');
      });
      expect(screen.getByTestId('crash-switch-source-focus-ring')).toBeTruthy();
      await act(async () => {
        fireWebKey('Enter');
      });
      expect(onSwitchSource).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('healthy-child')).toBeTruthy();

      // Touch/mouse press on Reload also recovers
      currentError = new Error('touch boom');
      const onReload = jest.fn(() => {
        currentError = null;
      });
      await view.rerender(
        <ViewportProvider
          value={{
            formFactor: 'phone',
            orientation: 'portrait',
            inputModality: 'touch',
            width: 390,
            height: 844,
          }}
        >
          <CrashRecoveryBoundary onReload={onReload}>
            <DynamicBomb getError={getError} />
          </CrashRecoveryBoundary>
        </ViewportProvider>,
      );
      await fireEvent.press(screen.getByTestId('crash-reload'));
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('healthy-child')).toBeTruthy();

      // Desktop web: when a DOM button already owns focus, Enter must not double-fire via key interpreter
      const prevDocument = (globalThis as { document?: unknown }).document;
      Object.defineProperty(globalThis, 'document', {
        value: { activeElement: { getAttribute: (n: string) => (n === 'role' ? 'button' : null) } },
        configurable: true,
        writable: true,
      });
      try {
        currentError = new Error('tab focused boom');
        const onFocusedReload = jest.fn(() => {
          currentError = null;
        });
        await view.rerender(
          <ViewportProvider
            value={{
              formFactor: 'desktop',
              orientation: 'landscape',
              inputModality: 'pointer',
              width: 1280,
              height: 720,
            }}
          >
            <CrashRecoveryBoundary onReload={onFocusedReload}>
              <DynamicBomb getError={getError} />
            </CrashRecoveryBoundary>
          </ViewportProvider>,
        );
        await act(async () => {
          fireWebKey('Enter');
        });
        expect(onFocusedReload).not.toHaveBeenCalled();
        expect(screen.getByTestId('crash-recovery-boundary')).toBeTruthy();
      } finally {
        Object.defineProperty(globalThis, 'document', {
          value: prevDocument,
          configurable: true,
          writable: true,
        });
      }
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: prevWindow,
        configurable: true,
        writable: true,
      });
    }
  });

  it('auto-resets when resetKey changes', async () => {
    const view = await render(
      <CrashRecoveryBoundary resetKey="tab-a">
        <Bomb error={new Error('tab crash')} />
      </CrashRecoveryBoundary>,
    );
    expect(screen.getByTestId('crash-recovery-boundary')).toBeTruthy();

    await view.rerender(
      <CrashRecoveryBoundary resetKey="tab-b">
        <Bomb error={null} />
      </CrashRecoveryBoundary>,
    );
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
  });
});
