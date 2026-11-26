import type { ItemRow, NowNextEntry } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, useTheme, useViewport, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { type CatalogLayoutMetrics, computeCatalogLayout } from '../../shared';
import { LiveContextMenu } from '../LiveContextMenu';
import { LiveZapDrawer } from '../LiveZapDrawer';
import { createStaticPagedListSource } from '../live-model';

function makeChannel(index: number): ItemRow {
  const num = 101 + index;
  return {
    id: index + 1,
    key: `x:src-1:live:${num}`,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(num),
    name: `Channel ${num}`,
    logo: null,
    rating: null,
    year: null,
    num,
  };
}

function LayoutProvider({
  children,
}: {
  readonly children: (layout: CatalogLayoutMetrics) => React.ReactElement;
}) {
  const viewport = useViewport();
  const theme = useTheme();
  return children(computeCatalogLayout(viewport, theme));
}

function wrap(ui: React.ReactElement) {
  return (
    <I18nProvider i18n={createAppI18n('en')}>
      <ThemeProvider>
        <ViewportProvider value={{ width: 1440, height: 900, formFactor: 'desktop' }}>
          {ui}
        </ViewportProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

describe('LiveZapDrawer drag-to-reorder & keyboard reorder', () => {
  const origOs = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
  });

  it('shows drag handles on web and commits reorder on pointer drag', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const channels = [makeChannel(0), makeChannel(1), makeChannel(2)];
    const source = createStaticPagedListSource(channels);
    const onReorderFavorite = jest.fn();

    const listeners = new Map<string, Set<(e: { clientY?: number }) => void>>();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: { clientY?: number }) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      fn: (e: { clientY?: number }) => void,
    ) => {
      listeners.get(type)?.delete(fn);
    };

    try {
      const view = await render(
        wrap(
          <LayoutProvider>
            {(layout) => (
              <LiveZapDrawer
                docked
                channelSource={source}
                sourceVersion={0}
                nowNextByKey={new Map<string, NowNextEntry>()}
                nowNextVersion={0}
                activeChannelKey={channels[0]?.key ?? null}
                focusedZapIndex={null}
                layout={layout}
                hydrateNowNext={jest.fn()}
                onSelectChannel={jest.fn()}
                onReorderFavorite={onReorderFavorite}
              />
            )}
          </LayoutProvider>,
        ),
      );

      const handle0 = screen.getByTestId('live-zap-drag-handle-0');
      expect(handle0).toBeTruthy();

      await act(async () => {
        (handle0.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          clientY: 100,
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });
      });

      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) {
          fn({ clientY: 210 });
        }
      });

      expect(screen.getByTestId('live-zap-drop-below-2')).toBeTruthy();

      await act(async () => {
        for (const fn of listeners.get('pointerup') ?? []) {
          fn({});
        }
      });

      expect(onReorderFavorite).toHaveBeenCalledWith(0, 2);
      await view.unmount();
    } finally {
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
    }
  });

  it('supports Alt+ArrowUp and Alt+ArrowDown keyboard reorder on web', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const channels = [makeChannel(0), makeChannel(1), makeChannel(2)];
    const source = createStaticPagedListSource(channels);
    const onReorderFavorite = jest.fn();

    const view = await render(
      wrap(
        <LayoutProvider>
          {(layout) => (
            <LiveZapDrawer
              docked
              channelSource={source}
              sourceVersion={0}
              nowNextByKey={new Map<string, NowNextEntry>()}
              nowNextVersion={0}
              activeChannelKey={channels[1]?.key ?? null}
              focusedZapIndex={null}
              layout={layout}
              hydrateNowNext={jest.fn()}
              onSelectChannel={jest.fn()}
              onReorderFavorite={onReorderFavorite}
            />
          )}
        </LayoutProvider>,
      ),
    );

    const row1 = screen.getByTestId('live-zap-row-1');
    await act(async () => {
      (row1.props.onKeyDown as ((e: unknown) => void) | undefined)?.({
        altKey: true,
        key: 'ArrowUp',
        preventDefault: jest.fn(),
      });
      (row1.props.onKeyDown as ((e: unknown) => void) | undefined)?.({
        altKey: true,
        key: 'ArrowDown',
        preventDefault: jest.fn(),
      });
    });

    expect(onReorderFavorite).toHaveBeenNthCalledWith(1, 1, 0);
    expect(onReorderFavorite).toHaveBeenNthCalledWith(2, 1, 2);
    await view.unmount();
  });

  it('cancels active drag on window blur without committing and suppresses row click-through after grip press (P1-4)', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const channels = [makeChannel(0), makeChannel(1), makeChannel(2)];
    const source = createStaticPagedListSource(channels);
    const onReorderFavorite = jest.fn();
    const onSelectChannel = jest.fn();

    const listeners = new Map<string, Set<(e: { clientY?: number }) => void>>();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: { clientY?: number }) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      fn: (e: { clientY?: number }) => void,
    ) => {
      listeners.get(type)?.delete(fn);
    };

    try {
      const view = await render(
        wrap(
          <LayoutProvider>
            {(layout) => (
              <LiveZapDrawer
                docked
                channelSource={source}
                sourceVersion={0}
                nowNextByKey={new Map<string, NowNextEntry>()}
                nowNextVersion={0}
                activeChannelKey={channels[0]?.key ?? null}
                focusedZapIndex={null}
                layout={layout}
                hydrateNowNext={jest.fn()}
                onSelectChannel={onSelectChannel}
                onReorderFavorite={onReorderFavorite}
              />
            )}
          </LayoutProvider>,
        ),
      );

      const handle0 = screen.getByTestId('live-zap-drag-handle-0');
      const row0 = screen.getByTestId('live-zap-row-0');

      await act(async () => {
        (handle0.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          clientY: 100,
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });
      });

      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) fn({ clientY: 210 });
      });
      expect(screen.getByTestId('live-zap-drop-below-2')).toBeTruthy();

      // Window blur cancels drag without committing reorder
      await act(async () => {
        for (const fn of listeners.get('blur') ?? []) fn({});
      });
      expect(onReorderFavorite).not.toHaveBeenCalled();
      expect(screen.queryByTestId('live-zap-drop-below-2')).toBeNull();

      // Trailing click/press after grip interaction does NOT select the channel
      await fireEvent.press(row0);
      expect(onSelectChannel).not.toHaveBeenCalled();

      // Subsequent normal row press DOES select the channel
      await fireEvent.press(row0);
      expect(onSelectChannel).toHaveBeenCalledWith(channels[0], 0);

      await view.unmount();
    } finally {
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
    }
  });
});

describe('LiveContextMenu enhanced Wave P4 actions', () => {
  it('renders Multi-View, Popout, and Move Up/Down actions when wired', async () => {
    const channel = makeChannel(1);
    const onPlay = jest.fn();
    const onOpenMultiView = jest.fn();
    const onOpenPopout = jest.fn();
    const onMoveFavorite = jest.fn();
    const onClose = jest.fn();

    const view = await render(
      wrap(
        <LiveContextMenu
          visible
          channel={channel}
          channelIndex={1}
          programme={null}
          isFavorite
          isTv={false}
          onPlay={onPlay}
          onOpenMultiView={onOpenMultiView}
          onOpenPopout={onOpenPopout}
          onToggleFavorite={jest.fn()}
          canMoveUp
          canMoveDown
          onMoveFavorite={onMoveFavorite}
          onClose={onClose}
        />,
      ),
    );

    expect(screen.getByTestId('live-context-multiview')).toBeTruthy();
    expect(screen.getByTestId('live-context-popout')).toBeTruthy();
    expect(screen.getByTestId('live-context-move-up')).toBeTruthy();
    expect(screen.getByTestId('live-context-move-down')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('live-context-multiview'));
    expect(onOpenMultiView).toHaveBeenCalledWith(channel, 1);

    await fireEvent.press(screen.getByTestId('live-context-popout'));
    expect(onOpenPopout).toHaveBeenCalledWith(channel, 1);

    await fireEvent.press(screen.getByTestId('live-context-move-up'));
    expect(onMoveFavorite).toHaveBeenCalledWith('up');

    await fireEvent.press(screen.getByTestId('live-context-move-down'));
    expect(onMoveFavorite).toHaveBeenCalledWith('down');

    await view.unmount();
  });

  it('hides Move Up/Down for non-favorite channels or at list boundaries', async () => {
    const channel = makeChannel(0);
    const view = await render(
      wrap(
        <LiveContextMenu
          visible
          channel={channel}
          channelIndex={0}
          programme={null}
          isFavorite={false}
          isTv={false}
          onPlay={jest.fn()}
          canMoveUp
          canMoveDown
          onMoveFavorite={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );

    expect(screen.queryByTestId('live-context-move-up')).toBeNull();
    expect(screen.queryByTestId('live-context-move-down')).toBeNull();
    expect(screen.queryByTestId('live-context-multiview')).toBeNull();
    expect(screen.queryByTestId('live-context-popout')).toBeNull();

    await view.unmount();
  });
});
