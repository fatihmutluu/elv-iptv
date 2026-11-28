import { ViewportProvider } from '@elv/ui-kit';
import { act, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { useDesktopShellShortcuts } from '../useDesktopShellShortcuts';

function ShortcutsHost(props: {
  readonly isPlayerOpen: boolean;
  readonly hasModalOverlay: boolean;
  readonly onToggleShortcutSheet: () => void;
  readonly onToggleCommandPalette: () => void;
  readonly onOpenSearch: () => void;
}) {
  useDesktopShellShortcuts(props);
  return null;
}

describe('useDesktopShellShortcuts hook (Wave Q7)', () => {
  const originalOs = Platform.OS;
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  });

  it('registers desktop web keydown listener and disables when player or modal is open', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
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
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

    const emitKey = (ev: Record<string, unknown>) => {
      const preventDefault = jest.fn();
      for (const fn of [...(listeners.get('keydown') ?? [])]) {
        fn({ ...ev, preventDefault });
      }
      return preventDefault;
    };

    const onToggleShortcutSheet = jest.fn();
    const onToggleCommandPalette = jest.fn();
    const onOpenSearch = jest.fn();

    const view = await render(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
      >
        <ShortcutsHost
          isPlayerOpen={false}
          hasModalOverlay={false}
          onToggleShortcutSheet={onToggleShortcutSheet}
          onToggleCommandPalette={onToggleCommandPalette}
          onOpenSearch={onOpenSearch}
        />
      </ViewportProvider>,
    );

    await act(async () => {
      expect(emitKey({ key: '?', shiftKey: true })).toHaveBeenCalledTimes(1);
      expect(emitKey({ key: 'F1' })).toHaveBeenCalledTimes(1);
      expect(emitKey({ key: 'k', ctrlKey: true })).toHaveBeenCalledTimes(1);
      expect(emitKey({ key: '/' })).toHaveBeenCalledTimes(1);
      expect(emitKey({ key: 'f', metaKey: true })).toHaveBeenCalledTimes(1);
    });
    expect(onToggleShortcutSheet).toHaveBeenCalledTimes(2);
    expect(onToggleCommandPalette).toHaveBeenCalledTimes(1);
    expect(onOpenSearch).toHaveBeenCalledTimes(2);

    // Suspended when player opens
    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1440, height: 900 }}
      >
        <ShortcutsHost
          isPlayerOpen
          hasModalOverlay={false}
          onToggleShortcutSheet={onToggleShortcutSheet}
          onToggleCommandPalette={onToggleCommandPalette}
          onOpenSearch={onOpenSearch}
        />
      </ViewportProvider>,
    );
    await act(async () => {
      expect(emitKey({ key: 'k', ctrlKey: true })).not.toHaveBeenCalled();
    });
    expect(onToggleCommandPalette).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(listeners.get('keydown')?.size ?? 0).toBe(0);
  });
});
