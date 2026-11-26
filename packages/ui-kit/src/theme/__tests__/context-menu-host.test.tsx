import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler, Platform, Pressable, StyleSheet, Text } from 'react-native';
import {
  buildTheme,
  type ContextMenuRequest,
  computeContextMenuPosition,
  ThemeProvider,
  useContextMenu,
} from '../index';

const defaultTheme = buildTheme();
const flat = StyleSheet.flatten;

function TestHarness({
  request,
  onState,
}: {
  readonly request: ContextMenuRequest;
  readonly onState?: (isOpen: boolean) => void;
}) {
  const menu = useContextMenu();
  onState?.(menu.isOpen);
  return (
    <>
      <Pressable testID="open-btn" onPress={() => menu.openContextMenu(request)}>
        <Text>Open</Text>
      </Pressable>
      <Pressable testID="close-btn" onPress={() => menu.closeContextMenu()}>
        <Text>Close</Text>
      </Pressable>
    </>
  );
}

describe('computeContextMenuPosition', () => {
  it('places menu at anchor when there is enough room in viewport', () => {
    expect(
      computeContextMenuPosition(
        { x: 200, y: 150 },
        { width: 220, height: 180 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ left: 200, top: 150 });
  });

  it('flips left when near right edge and flips up when near bottom edge', () => {
    expect(
      computeContextMenuPosition(
        { x: 1180, y: 620 },
        { width: 220, height: 180 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ left: 960, top: 440 });
  });

  it('clamps inside viewport with 12px margin at extreme corners', () => {
    expect(
      computeContextMenuPosition(
        { x: 1278, y: 718 },
        { width: 220, height: 180 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ left: 1048, top: 528 });

    expect(
      computeContextMenuPosition(
        { x: 2, y: 3 },
        { width: 220, height: 180 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ left: 12, top: 12 });
  });

  it('falls back to 12px margin when menu exceeds viewport size', () => {
    expect(
      computeContextMenuPosition(
        { x: 100, y: 100 },
        { width: 400, height: 300 },
        { width: 320, height: 240 },
      ),
    ).toEqual({ left: 12, top: 12 });
  });
});

describe('ContextMenuHostProvider & useContextMenu', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns safe no-op controller when called outside ThemeProvider', async () => {
    let capturedIsOpen: boolean | undefined;
    await render(
      <TestHarness
        request={{ items: [{ id: 'a', label: 'Play', onSelect: jest.fn() }] }}
        onState={(open) => {
          capturedIsOpen = open;
        }}
      />,
    );
    expect(capturedIsOpen).toBe(false);
    await fireEvent.press(screen.getByTestId('open-btn'));
    await fireEvent.press(screen.getByTestId('close-btn'));
    expect(screen.queryByTestId('context-menu-panel')).toBeNull();
  });

  it('renders anchored floating dark-glass menu on web, selects item, and closes on backdrop or Escape', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const onPlay = jest.fn();
    const onRemove = jest.fn();
    const onDisabled = jest.fn();

    await render(
      <ThemeProvider>
        <TestHarness
          request={{
            title: 'Blade Runner',
            subtitle: 'Movie · 1982',
            anchor: { x: 120, y: 160 },
            items: [
              { id: 'play', label: 'Play', icon: 'play', testID: 'ctx-play', onSelect: onPlay },
              {
                id: 'disabled',
                label: 'Unavailable',
                disabled: true,
                testID: 'ctx-disabled',
                onSelect: onDisabled,
              },
              {
                id: 'remove',
                label: 'Remove',
                icon: 'trash',
                destructive: true,
                testID: 'ctx-remove',
                onSelect: onRemove,
              },
            ],
          }}
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('context-menu-panel')).toBeNull();

    await fireEvent.press(screen.getByTestId('open-btn'));
    const panel = screen.getByTestId('context-menu-panel');
    const panelStyle = flat(panel.props.style);
    expect(panelStyle.position).toBe('fixed');
    expect(panelStyle.backgroundColor).toBe(defaultTheme.colors.bgElevated);
    expect(panelStyle.borderColor).toBe(defaultTheme.colors.surfaceBorder);
    expect(panelStyle.borderRadius).toBe(defaultTheme.radius.modal);
    expect(screen.getByText('Blade Runner')).toBeTruthy();
    expect(screen.getByText('Movie · 1982')).toBeTruthy();

    // Enabled row should NOT have accessibilityState.disabled === false injected
    const playRow = screen.getByTestId('ctx-play');
    expect(playRow.props.accessibilityState?.disabled).toBeUndefined();

    // Disabled row should be dimmed and non-activatable
    const disabledRow = screen.getByTestId('ctx-disabled');
    expect(disabledRow.props.accessibilityState?.disabled).toBe(true);
    expect(flat(disabledRow.props.style).opacity).toBe(0.45);
    await fireEvent.press(disabledRow);
    expect(onDisabled).not.toHaveBeenCalled();

    // Destructive row uses theme liveColor (danger tint)
    expect(flat(screen.getByText('Remove').props.style).color).toBe(defaultTheme.colors.liveColor);

    // Selecting enabled row invokes callback and closes menu
    await fireEvent.press(playRow);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('context-menu-panel')).toBeNull();

    // Re-open and dismiss via backdrop click
    await fireEvent.press(screen.getByTestId('open-btn'));
    expect(screen.getByTestId('context-menu-panel')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('context-menu-backdrop'));
    expect(screen.queryByTestId('context-menu-panel')).toBeNull();

    // Re-open and dismiss via backdrop right-click (preventing default)
    await fireEvent.press(screen.getByTestId('open-btn'));
    const preventDefault = jest.fn();
    await fireEvent(screen.getByTestId('context-menu-backdrop'), 'contextMenu', {
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('context-menu-panel')).toBeNull();
  });

  it('supports keyboard ArrowDown/ArrowUp skipping disabled rows, Enter activation, and Escape close on web', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const mockAdd = jest.fn((type: string, fn: (e: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    });
    const mockRemove = jest.fn((type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    });
    const prevAdd = (globalThis as { addEventListener?: unknown }).addEventListener;
    const prevRemove = (globalThis as { removeEventListener?: unknown }).removeEventListener;
    (globalThis as { addEventListener?: unknown }).addEventListener = mockAdd;
    (globalThis as { removeEventListener?: unknown }).removeEventListener = mockRemove;

    const dispatchKey = async (key: string) => {
      const preventDefault = jest.fn();
      const stopPropagation = jest.fn();
      await act(async () => {
        for (const fn of listeners.get('keydown') ?? []) {
          fn({ key, preventDefault, stopPropagation });
        }
      });
      return { preventDefault, stopPropagation };
    };

    try {
      const onFirst = jest.fn();
      const onSecond = jest.fn();
      const onThird = jest.fn();

      await render(
        <ThemeProvider>
          <TestHarness
            request={{
              anchor: { x: 80, y: 80 },
              items: [
                { id: '1', label: 'First', testID: 'k-1', onSelect: onFirst },
                { id: '2', label: 'Second', disabled: true, testID: 'k-2', onSelect: onSecond },
                { id: '3', label: 'Third', testID: 'k-3', onSelect: onThird },
              ],
            }}
          />
        </ThemeProvider>,
      );

      await fireEvent.press(screen.getByTestId('open-btn'));
      expect(screen.getByTestId('context-menu-panel')).toBeTruthy();

      // ArrowDown from index 0 skips disabled index 1 -> lands on index 2
      await dispatchKey('ArrowDown');
      await dispatchKey('Enter');
      expect(onSecond).not.toHaveBeenCalled();
      expect(onThird).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('context-menu-panel')).toBeNull();

      // Re-open and close with Escape
      await fireEvent.press(screen.getByTestId('open-btn'));
      const escResult = await dispatchKey('Escape');
      expect(escResult.preventDefault).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('context-menu-panel')).toBeNull();
    } finally {
      (globalThis as { addEventListener?: unknown }).addEventListener = prevAdd;
      (globalThis as { removeEventListener?: unknown }).removeEventListener = prevRemove;
    }
  });

  it('renders centered card over dimmed overlayBackdrop scrim when anchor is omitted and closes on Android hardware Back', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    let backCallback: (() => boolean) | undefined;
    const removeSpy = jest.fn();
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, cb) => {
      backCallback = cb as () => boolean;
      return { remove: removeSpy };
    });

    await render(
      <ThemeProvider>
        <TestHarness
          request={{
            title: 'Channel Options',
            items: [{ id: 'fav', label: 'Add Favorite', onSelect: jest.fn() }],
          }}
        />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('open-btn'));
    const backdrop = screen.getByTestId('context-menu-backdrop');
    expect(flat(backdrop.props.style).backgroundColor).toBe(defaultTheme.colors.overlayBackdrop);
    expect(screen.getByTestId('context-menu-panel')).toBeTruthy();

    let consumed = false;
    await act(async () => {
      consumed = backCallback?.() ?? false;
    });
    expect(consumed).toBe(true);
    expect(screen.queryByTestId('context-menu-panel')).toBeNull();
    expect(removeSpy).toHaveBeenCalled();
  });

  it('sets hasTVPreferredFocus on the active menu item and updates activeIndex on native focus (P0-5)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');

    await render(
      <ThemeProvider>
        <TestHarness
          request={{
            title: 'TV Actions',
            items: [
              {
                id: 'disabled',
                label: 'Unavailable',
                disabled: true,
                testID: 'tv-item-0',
                onSelect: jest.fn(),
              },
              { id: 'play', label: 'Play', testID: 'tv-item-1', onSelect: jest.fn() },
              { id: 'fav', label: 'Favorite', testID: 'tv-item-2', onSelect: jest.fn() },
            ],
          }}
        />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('open-btn'));

    // First enabled item (index 1) receives initial TV preferred focus; disabled & non-active rows do not
    expect(screen.getByTestId('tv-item-0').props.hasTVPreferredFocus).toBe(false);
    expect(screen.getByTestId('tv-item-1').props.hasTVPreferredFocus).toBe(true);
    expect(screen.getByTestId('tv-item-2').props.hasTVPreferredFocus).toBe(false);
    expect(flat(screen.getByTestId('tv-item-1').props.style).backgroundColor).toBe(
      defaultTheme.colors.focusFill,
    );

    // Moving native TV D-pad focus to index 2 updates activeIndex and preferred focus
    await fireEvent(screen.getByTestId('tv-item-2'), 'focus');
    expect(screen.getByTestId('tv-item-1').props.hasTVPreferredFocus).toBe(false);
    expect(screen.getByTestId('tv-item-2').props.hasTVPreferredFocus).toBe(true);
    expect(flat(screen.getByTestId('tv-item-2').props.style).backgroundColor).toBe(
      defaultTheme.colors.focusFill,
    );
  });
});
