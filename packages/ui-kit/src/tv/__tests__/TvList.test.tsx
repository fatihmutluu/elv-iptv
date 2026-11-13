import { createFocusStore, type FocusStore } from '@elv/focus-core';
import { act, render, screen } from '@testing-library/react-native';
import { cloneElement, type ReactElement, StrictMode } from 'react';
import { Animated, Text } from 'react-native';
import { createSyntheticSource } from '../list-source';
import { TvList } from '../TvList';

const ROW_HEIGHT = 40;

function setup(visibleRows: number, count = 100_000, focusLine = 2) {
  const store = createFocusStore({
    id: 'root',
    lists: [{ id: 'l', count, index: 0, orientation: 'vertical', pageSize: 10 }],
    active: 'l',
  });
  const source = createSyntheticSource(count, (i) => `Item ${i}`);
  const prefetchSpy = jest.spyOn(source, 'prefetch');
  const renders: number[] = [];
  const onFrameCommitted = jest.fn();
  const renderRow = (item: string | undefined, focused: boolean): ReactElement => {
    renders.push(0);
    return <Text>{`${item}${focused ? '*' : ''}`}</Text>;
  };
  const ui = (
    <TvList
      listId="l"
      store={store}
      source={source}
      rowHeight={ROW_HEIGHT}
      visibleRows={visibleRows}
      focusLine={focusLine}
      renderRow={renderRow}
      testID="list"
      onFrameCommitted={onFrameCommitted}
    />
  );
  return { store, ui, renders, onFrameCommitted, prefetchSpy };
}

function move(store: FocusStore, key: 'down' | 'up', n = 1) {
  for (let i = 0; i < n; i++) {
    store.dispatch({ key, kind: 'press', time: i });
  }
}

const rowCount = () => screen.queryAllByTestId(/^list-row-\d+$/).length;

describe('TvList', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('renders exactly visibleRows + 4 rows of a 100,000-item source', async () => {
    const { ui } = setup(8);
    await render(ui);
    expect(rowCount()).toBe(12);
    expect(screen.getByTestId('list-row-0')).toBeTruthy();
  });

  it('re-renders at most three rows per step, independent of the pool size', async () => {
    const counts: number[] = [];
    for (const visibleRows of [8, 20]) {
      const { store, ui, renders } = setup(visibleRows);
      const view = await render(ui);
      await act(async () => move(store, 'down', 5));
      renders.length = 0;
      await act(async () => move(store, 'down'));
      counts.push(renders.length);
      expect(rowCount()).toBe(visibleRows + 4);
      await view.unmount();
    }
    expect(counts[0]).toBeLessThanOrEqual(3);
    expect(counts[1]).toBeLessThanOrEqual(3);
    expect(counts[1]).toBe(counts[0]);
  });

  it('keeps the focused item on the focus line and the ring at focusLine * rowHeight', async () => {
    const { store, ui } = setup(8);
    await render(ui);
    await act(async () => move(store, 'down', 50));
    const ring = screen.getByTestId('list-ring');
    expect(ring.props.style).toEqual(expect.objectContaining({ top: 2 * ROW_HEIGHT }));
    expect(screen.getByTestId('list-row-50').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('list-row-49').props.accessibilityState).toEqual({
      selected: false,
    });
    expect(screen.getByTestId('list-row-48')).toBeTruthy();
  });

  it('lets the ring leave the focus line at the top and bottom edges', async () => {
    const { store, ui } = setup(8, 30);
    await render(ui);
    expect(screen.getByTestId('list-ring').props.style.top).toBe(0);
    await act(async () => move(store, 'down', 1));
    expect(screen.getByTestId('list-ring').props.style.top).toBe(ROW_HEIGHT);
    await act(async () => move(store, 'down', 29));
    expect(screen.getByTestId('list-ring').props.style.top).toBe(7 * ROW_HEIGHT);
    expect(screen.getByTestId('list-row-29').props.accessibilityState.selected).toBe(true);
  });

  it('calls onFrameCommitted once per index change after commit', async () => {
    const { store, ui, onFrameCommitted } = setup(8);
    await render(ui);
    expect(onFrameCommitted).not.toHaveBeenCalled();
    await act(async () => move(store, 'down'));
    expect(onFrameCommitted).toHaveBeenCalledTimes(1);
    expect(onFrameCommitted).toHaveBeenLastCalledWith(1, {
      start: 0,
      end: 8,
      renderedStart: 0,
      renderedEnd: 12,
    });
    await act(async () => move(store, 'down'));
    expect(onFrameCommitted).toHaveBeenCalledTimes(2);
    await act(async () => move(store, 'up', 2));
    expect(onFrameCommitted).toHaveBeenLastCalledWith(0, {
      start: 0,
      end: 8,
      renderedStart: 0,
      renderedEnd: 12,
    });
  });

  it('reports no frame when the index returns to its value within one frame', async () => {
    const { store, ui, onFrameCommitted } = setup(8);
    await render(ui);
    await act(async () => {
      move(store, 'down');
      move(store, 'up');
    });
    expect(onFrameCommitted).not.toHaveBeenCalled();
  });

  describe('coordinates and sync', () => {
    let latest = 0;
    beforeEach(() => {
      latest = 0;
      jest.spyOn(Animated.Value.prototype, 'setValue').mockImplementation((v) => {
        latest = v;
      });
      jest.spyOn(Animated, 'timing').mockImplementation(((_: unknown, cfg: { toValue: number }) => {
        latest = cfg.toValue;
        return { start: () => {} };
      }) as never);
    });
    const translateOf = () => latest;
    const topsOf = () =>
      screen.queryAllByTestId(/^list-row-\d+$/).map((r) => r.props.style.top as number);

    it('keeps every native coordinate bounded at the end of 100,000 rows', async () => {
      const { store, ui } = setup(8);
      await render(ui);
      await act(async () => store.focus('l', 99_999));
      const pool = 12;
      const limit = 10 * pool * ROW_HEIGHT;
      expect(topsOf()).toHaveLength(pool);
      expect(Math.max(...topsOf().map(Math.abs))).toBeLessThan(limit);
      expect(Math.abs(translateOf())).toBeLessThan(limit);
      expect(screen.getByTestId('list-row-99999').props.accessibilityState.selected).toBe(true);
      const t = screen.getByTestId('list-row-99999').props.style.top + translateOf();
      expect(t).toBe(screen.getByTestId('list-ring').props.style.top);
    });

    it('keeps rows, ring and offset aligned when rowHeight changes', async () => {
      const { store, ui } = setup(8);
      const view = await render(ui);
      await act(async () => move(store, 'down', 20));
      await view.rerender(cloneElement(ui, { rowHeight: 60 }));
      const row = screen.getByTestId('list-row-20').props.style.top + translateOf();
      expect(row).toBe(screen.getByTestId('list-ring').props.style.top);
      expect(row).toBe(2 * 60);
    });

    it('keeps alignment when the source count shrinks without an index change', async () => {
      const { store, ui } = setup(8, 30);
      const view = await render(ui);
      await act(async () => store.focus('l', 29));
      await view.rerender(
        cloneElement(ui, { source: createSyntheticSource(40, (i) => `Item ${i}`) }),
      );
      const row = screen.getByTestId('list-row-29').props.style.top + translateOf();
      expect(row).toBe(screen.getByTestId('list-ring').props.style.top);
    });

    it('reports frames under StrictMode', async () => {
      const { store, ui, onFrameCommitted } = setup(8);
      await render(<StrictMode>{ui}</StrictMode>);
      await act(async () => move(store, 'down'));
      expect(onFrameCommitted).toHaveBeenCalledTimes(1);
      expect(onFrameCommitted).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ start: 0, end: 8 }),
      );
    });

    it('labels rows through rowLabel', async () => {
      const { ui } = setup(8);
      await render(
        cloneElement(ui, { rowLabel: (item: string | undefined, i: number) => `${item} #${i}` }),
      );
      expect(screen.getByTestId('list-row-3').props.accessibilityLabel).toBe('Item 3 #3');
    });

    it('prefetches when the rendered range moves, not on every render', async () => {
      const { store, ui, prefetchSpy } = setup(8);
      await render(ui);
      expect(prefetchSpy).toHaveBeenCalledWith(0, 24);
      const calls = prefetchSpy.mock.calls.length;
      await act(async () => move(store, 'up'));
      expect(prefetchSpy.mock.calls.length).toBe(calls);
      await act(async () => move(store, 'down', 10));
      expect(prefetchSpy.mock.calls.length).toBeGreaterThan(calls);
      expect(prefetchSpy).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number));
    });
  });
});
