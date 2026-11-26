import {
  DEFAULT_HOME_LAYOUT,
  DEFAULT_PREFERENCES,
  ok,
  type PreferencesSnapshot,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { AppearancePanel, adjustAppearanceControl } from '../AppearancePanel';
import {
  HomeLayoutEditor,
  moveHomeLayoutSection,
  toggleHomeLayoutSection,
} from '../HomeLayoutEditor';
import { useTvSettingsNavigation } from '../useTvSettingsNavigation';

describe('Wave P4 HomeLayoutEditor & Sync initialPrefsHint', () => {
  it('moves and toggles Home layout sections cleanly with pure helpers', () => {
    const moved = moveHomeLayoutSection(DEFAULT_HOME_LAYOUT, 1, 'up');
    expect(moved.map((s) => s.id).slice(0, 2)).toEqual(['live', 'continue']);

    const toggled = toggleHomeLayoutSection(moved, 'movies');
    expect(toggled.find((s) => s.id === 'movies')?.visible).toBe(false);
  });

  it('renders live wireframe preview, toggles visibility, reorders rows, and resets to default', async () => {
    const onChange = jest.fn();
    const { rerender } = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeLayoutEditor layout={DEFAULT_HOME_LAYOUT} onChange={onChange} />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.getByTestId('home-layout-preview')).toBeTruthy();
    expect(screen.getByTestId('home-layout-preview-row-live')).toBeTruthy();
    expect(screen.queryByTestId('home-layout-reset')).toBeNull();

    await fireEvent.press(screen.getByTestId('home-layout-up-live'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const reordered = onChange.mock.calls[0]?.[0];
    expect(reordered[0]).toEqual({ id: 'live', visible: true });

    const withHidden = toggleHomeLayoutSection(reordered, 'movies');
    await rerender(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeLayoutEditor layout={withHidden} onChange={onChange} />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.queryByTestId('home-layout-preview-row-movies')).toBeNull();
    expect(screen.getByTestId('home-layout-hidden-count')).toBeTruthy();
    expect(screen.getByTestId('home-layout-reset')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('home-layout-reset'));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_HOME_LAYOUT);
  });

  it('persists homeLayout changes through AppearancePanel updatePreferences', async () => {
    const updatePreferences = jest.fn(async (patch) =>
      ok({ ...DEFAULT_PREFERENCES, ...patch } as PreferencesSnapshot),
    );
    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <AppearancePanel
              preferences={{
                preferences: DEFAULT_PREFERENCES,
                updatePreferences,
                resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
              }}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await fireEvent.press(screen.getByTestId('home-layout-toggle-series'));
    expect(updatePreferences).toHaveBeenCalledWith({
      homeLayout: expect.arrayContaining([{ id: 'series', visible: false }]),
    });
  });

  it('omits home-layout-reset when not customized, follows custom homeLayout order, and supports TV Left/Right reorder (P1-3)', async () => {
    const onAdjustControl = jest.fn();
    const customLayout = moveHomeLayoutSection(DEFAULT_HOME_LAYOUT, 1, 'up'); // live first, continue second

    // Default layout: last Appearance control is home-layout-collections (no invisible reset slot)
    const defaultHook = await renderHook(() =>
      useTvSettingsNavigation({
        isTv: true,
        isActiveScope: true,
        section: 'appearance',
        onSectionChange: jest.fn(),
        onAdjustControl,
        homeLayout: DEFAULT_HOME_LAYOUT,
      }),
    );
    await act(async () => {
      defaultHook.result.current.enterContentPane();
    });
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        defaultHook.result.current.handleTvKey({ kind: 'press', key: 'down', time: i + 1 });
      });
    }
    expect(defaultHook.result.current.focusedAppearanceId).toBe('home-layout-collections');
    await defaultHook.unmount();

    // Customized layout: dynamic section order + reset control + Left/Right reorder
    const customHook = await renderHook(() =>
      useTvSettingsNavigation({
        isTv: true,
        isActiveScope: true,
        section: 'appearance',
        onSectionChange: jest.fn(),
        onAdjustControl,
        homeLayout: customLayout,
      }),
    );
    await act(async () => {
      customHook.result.current.enterContentPane();
    });
    const visited: string[] = [];
    for (let i = 0; i < 30; i++) {
      const cur = customHook.result.current.focusedAppearanceId;
      if (cur?.startsWith('home-layout-') && visited[visited.length - 1] !== cur) {
        visited.push(cur);
      }
      await act(async () => {
        customHook.result.current.handleTvKey({ kind: 'press', key: 'down', time: i + 1 });
      });
    }
    expect(visited).toEqual([
      'home-layout-live',
      'home-layout-continue',
      'home-layout-mylist',
      'home-layout-movies',
      'home-layout-series',
      'home-layout-collections',
      'home-layout-reset',
    ]);

    // Step up onto home-layout-collections and press Left -> moves section up (delta -1)
    await act(async () => {
      customHook.result.current.handleTvKey({ kind: 'press', key: 'up', time: 50 });
    });
    expect(customHook.result.current.focusedAppearanceId).toBe('home-layout-collections');
    await act(async () => {
      customHook.result.current.handleTvKey({ kind: 'press', key: 'left', time: 51 });
    });
    expect(onAdjustControl).toHaveBeenCalledWith('appearance', 'home-layout-collections', -1);

    // adjustAppearanceControl persists the reordered layout
    const updatePreferences = jest.fn(async (patch) =>
      ok({ ...DEFAULT_PREFERENCES, ...patch } as PreferencesSnapshot),
    );
    adjustAppearanceControl('home-layout-collections', -1, {
      preferences: { ...DEFAULT_PREFERENCES, homeLayout: customLayout },
      updatePreferences,
      resetPreferences: jest.fn(async () => ok(DEFAULT_PREFERENCES)),
    });
    expect(updatePreferences).toHaveBeenCalledWith({
      homeLayout: expect.arrayContaining([{ id: 'collections', visible: true }]),
    });
    const savedOrder = updatePreferences.mock.calls[0]?.[0]?.homeLayout?.map(
      (s: { id: string }) => s.id,
    );
    expect(savedOrder?.[4]).toBe('collections');
    expect(savedOrder?.[5]).toBe('series');

    await customHook.unmount();
  });

  it('cancels active web pointer drag on window blur without calling onChange (P1-4)', async () => {
    const origOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const listeners = new Map<string, Set<(e: { clientY: number }) => void>>();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: { clientY: number }) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      fn: (e: { clientY: number }) => void,
    ) => {
      listeners.get(type)?.delete(fn);
    };

    try {
      const onChange = jest.fn();
      const view = await render(
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider reduceMotion>
            <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
              <HomeLayoutEditor layout={DEFAULT_HOME_LAYOUT} onChange={onChange} />
            </ViewportProvider>
          </ThemeProvider>
        </I18nProvider>,
      );

      const drag0 = screen.getByTestId('home-layout-drag-continue');
      await act(async () => {
        (drag0.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          clientY: 100,
          preventDefault: jest.fn(),
        });
      });
      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) fn({ clientY: 220 });
      });
      await act(async () => {
        for (const fn of listeners.get('blur') ?? []) fn({ clientY: 220 });
      });

      expect(onChange).not.toHaveBeenCalled();
      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
    }
  });
});
