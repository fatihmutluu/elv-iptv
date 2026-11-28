import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, Platform, StyleSheet } from 'react-native';
import { FloatingMiniPlayerChrome, useMiniPlayerController } from '../FloatingMiniPlayerChrome';
import type { MiniPlayerResizeEdge } from '../mini-player-geometry';

const ALL_EDGES: ReadonlyArray<readonly [MiniPlayerResizeEdge, string]> = [
  ['n', 'ns-resize'],
  ['s', 'ns-resize'],
  ['e', 'ew-resize'],
  ['w', 'ew-resize'],
  ['nw', 'nwse-resize'],
  ['se', 'nwse-resize'],
  ['ne', 'nesw-resize'],
  ['sw', 'nesw-resize'],
];

function wrap(node: React.ReactElement) {
  return (
    <ThemeProvider preset="obsidianCrimson">
      <I18nProvider i18n={createAppI18n('en')}>
        <FormFactorProvider value="desktop">
          <ViewportProvider
            value={{
              formFactor: 'desktop',
              orientation: 'landscape',
              inputModality: 'pointer',
              width: 1280,
              height: 720,
              safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
            }}
          >
            {node}
          </ViewportProvider>
        </FormFactorProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function FakePointerEvent() {}

function installWebWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 720,
    PointerEvent: FakePointerEvent,
    addEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    }),
    removeEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    }),
  };
  const globals = globalThis as unknown as { window?: unknown };
  const prev = globals.window;
  globals.window = win;
  return {
    async emit(type: string, event: Record<string, unknown>) {
      await act(async () => {
        for (const fn of [...(listeners.get(type) ?? [])]) {
          fn(event);
        }
      });
    },
    restore() {
      globals.window = prev;
    },
  };
}

function ControllerHarness({
  onExpand = jest.fn(),
  onClose = jest.fn(),
  isTv = false,
}: {
  readonly onExpand?: () => void;
  readonly onClose?: () => void;
  readonly isTv?: boolean;
}) {
  const i18n = createAppI18n('en');
  const controller = useMiniPlayerController({
    enabled: true,
    isTv,
    reduceMotion: true,
    viewportWidth: 1280,
    viewportHeight: 720,
    formFactor: isTv ? 'tv' : 'desktop',
    orientation: 'landscape',
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    overscan: { x: 0, y: 0 },
  });

  return (
    <Animated.View
      testID="floating-mini-player"
      style={{
        position: 'absolute',
        width: controller.width,
        height: controller.height,
        left: controller.animPos.x,
        top: controller.animPos.y,
      }}
    >
      <FloatingMiniPlayerChrome
        title="Channel One"
        subtitle="Live News"
        isLive
        isTv={isTv}
        corner={controller.corner}
        i18n={i18n}
        onExpand={onExpand}
        onClose={onClose}
        onDragStart={controller.startDrag}
        onResizeStart={controller.startResize}
        shouldSuppressExpand={controller.shouldSuppressExpand}
      />
    </Animated.View>
  );
}

describe('FloatingMiniPlayerChrome — OS edge/corner resize (Wave R4-A)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('removes the visible corner square grip and renders 8 invisible perimeter hit-zones with OS resize cursors on web', async () => {
    const webWin = installWebWindow();
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    try {
      const onResizeStart = jest.fn();
      const view = await render(
        wrap(
          <FloatingMiniPlayerChrome
            title="Cinema Film"
            isLive={false}
            isTv={false}
            i18n={createAppI18n('en')}
            onExpand={jest.fn()}
            onClose={jest.fn()}
            onDragStart={jest.fn()}
            onResizeStart={onResizeStart}
          />,
        ),
      );

      expect(screen.queryByTestId('mini-player-resize-handle')).toBeNull();
      expect(
        StyleSheet.flatten(screen.getByTestId('mini-player-top-row').props.style),
      ).toMatchObject({ justifyContent: 'flex-end' });
      expect(
        StyleSheet.flatten(screen.getByTestId('mini-player-title-bar').props.style).paddingLeft,
      ).toBeUndefined();
      expect(
        StyleSheet.flatten(screen.getByTestId('mini-player-title-bar').props.style).paddingRight,
      ).toBeUndefined();

      for (const [edge, expectedCursor] of ALL_EDGES) {
        const zone = screen.getByTestId(`mini-player-resize-${edge}`);
        const flat = StyleSheet.flatten(zone.props.style) as Record<string, unknown>;
        expect(flat.cursor).toBe(expectedCursor);
        expect(flat.backgroundColor).toBeUndefined();
        expect(flat.borderWidth).toBeUndefined();
        expect(zone.props.focusable).toBe(false);

        await fireEvent(zone, 'pointerDown', {
          clientX: 100,
          clientY: 200,
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });
        expect(onResizeStart).toHaveBeenLastCalledWith(edge, 100, 200);
      }

      expect(onResizeStart).toHaveBeenCalledTimes(8);
      await view.unmount();
    } finally {
      webWin.restore();
    }
  });

  it('keeps top-right expand and close buttons layered above resize borders and omits resize zones on TV', async () => {
    const viewDesktop = await render(
      wrap(
        <FloatingMiniPlayerChrome
          title="News"
          isLive
          isTv={false}
          i18n={createAppI18n('en')}
          onExpand={jest.fn()}
          onClose={jest.fn()}
          onResizeStart={jest.fn()}
        />,
      ),
    );

    const actionsRowStyle = StyleSheet.flatten(
      screen.getByTestId('mini-player-actions-row').props.style,
    ) as Record<string, unknown>;
    const edgeStyle = StyleSheet.flatten(
      screen.getByTestId('mini-player-resize-n').props.style,
    ) as Record<string, unknown>;
    const cornerStyle = StyleSheet.flatten(
      screen.getByTestId('mini-player-resize-ne').props.style,
    ) as Record<string, unknown>;
    expect(Number(cornerStyle.zIndex)).toBeGreaterThan(Number(edgeStyle.zIndex));
    expect(Number(actionsRowStyle.zIndex)).toBeGreaterThan(Number(cornerStyle.zIndex));
    await viewDesktop.unmount();

    const viewTv = await render(
      wrap(
        <FloatingMiniPlayerChrome
          title="News"
          isLive
          isTv
          i18n={createAppI18n('en')}
          onExpand={jest.fn()}
          onClose={jest.fn()}
          onResizeStart={jest.fn()}
        />,
      ),
    );
    for (const [edge] of ALL_EDGES) {
      expect(screen.queryByTestId(`mini-player-resize-${edge}`)).toBeNull();
    }
    await viewTv.unmount();
  });

  it('resizes smoothly from left (w), top (n), and corner (nw, se) edges preserving 16:9 ratio and opposite-edge anchors', async () => {
    const webWin = installWebWindow();
    const onExpand = jest.fn();
    try {
      const view = await render(wrap(<ControllerHarness onExpand={onExpand} />));

      // Initial bottom-right rect: x=944, y=524, width=320, height=180
      const initial = StyleSheet.flatten(screen.getByTestId('floating-mini-player').props.style);
      expect(initial.width).toBe(320);
      expect(initial.height).toBe(180);

      // Drag left ('w') edge -80px -> width=400, height=225, right stays 1264 (x=864)
      await fireEvent(screen.getByTestId('mini-player-resize-w'), 'pointerDown', {
        clientX: 944,
        clientY: 600,
        stopPropagation: jest.fn(),
        preventDefault: jest.fn(),
      });
      await webWin.emit('pointermove', { clientX: 864, clientY: 600 });
      await webWin.emit('pointerup', { clientX: 864, clientY: 600 });

      const afterWest = StyleSheet.flatten(screen.getByTestId('floating-mini-player').props.style);
      expect(afterWest.width).toBe(400);
      expect(afterWest.height).toBe(225);
      expect(afterWest.left).toBe(864);

      // Drag top ('n') edge -45px -> width=480, height=270, bottom stays 704 (y=434)
      await fireEvent(screen.getByTestId('mini-player-resize-n'), 'pointerDown', {
        clientX: 1000,
        clientY: 479,
        stopPropagation: jest.fn(),
        preventDefault: jest.fn(),
      });
      await webWin.emit('pointermove', { clientX: 1000, clientY: 434 });
      await webWin.emit('pointerup', { clientX: 1000, clientY: 434 });

      const afterNorth = StyleSheet.flatten(screen.getByTestId('floating-mini-player').props.style);
      expect(afterNorth.width).toBe(480);
      expect(afterNorth.height).toBe(270);
      expect(afterNorth.top).toBe(434);

      // Drag bottom-right ('se') corner inward (-160px) -> shrinks to 320x180 while pinning top-left (784, 434)
      await fireEvent(screen.getByTestId('mini-player-resize-se'), 'pointerDown', {
        clientX: 1264,
        clientY: 704,
        stopPropagation: jest.fn(),
        preventDefault: jest.fn(),
      });
      await webWin.emit('pointermove', { clientX: 1104, clientY: 704 });
      await webWin.emit('pointerup', { clientX: 1104, clientY: 704 });

      const afterSe = StyleSheet.flatten(screen.getByTestId('floating-mini-player').props.style);
      expect(afterSe.width).toBe(320);
      expect(afterSe.height).toBe(180);
      expect(afterSe.left).toBe(784);
      expect(afterSe.top).toBe(434);

      // Resize release suppresses accidental expand press once, then plain press expands
      await fireEvent.press(screen.getByTestId('mini-player-surface-tap'));
      expect(onExpand).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByTestId('mini-player-surface-tap'));
      expect(onExpand).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      webWin.restore();
    }
  });
});
