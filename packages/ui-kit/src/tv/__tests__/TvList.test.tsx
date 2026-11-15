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

    it('keeps every native coordinate bounded at the end of 100,000 rows without re-anchoring every 100 rows', async () => {
      const { store, ui } = setup(8);
      await render(ui);
      await act(async () => store.focus('l', 200));
      expect(screen.getByTestId('list-row-200').props.style.top).toBe(200 * ROW_HEIGHT);
      await act(async () => store.focus('l', 99_999));
      const pool = 12;
      const limit = 514 * pool * ROW_HEIGHT;
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

    it('prefetches in quantized half-pool buckets rather than on every 1-row step', async () => {
      const { store, ui, prefetchSpy } = setup(8);
      await render(ui);
      expect(prefetchSpy).toHaveBeenCalledWith(0, 24);
      const calls = prefetchSpy.mock.calls.length;
      await act(async () => move(store, 'up'));
      expect(prefetchSpy.mock.calls.length).toBe(calls);
      await act(async () => move(store, 'down', 5));
      const afterFirstBucket = prefetchSpy.mock.calls.length;
      expect(afterFirstBucket).toBe(calls + 1);
      expect(prefetchSpy).toHaveBeenLastCalledWith(0, 30);
      for (let step = 0; step < 4; step++) {
        await act(async () => move(store, 'down', 1));
      }
      expect(prefetchSpy.mock.calls.length).toBe(afterFirstBucket);
    });

    it('animates 1-row steps with timing but snaps page jumps and source swaps with setValue', async () => {
      let now = 1000;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      const setValueSpy = jest.spyOn(Animated.Value.prototype, 'setValue');
      const timingSpy = jest.spyOn(Animated, 'timing');
      const { store, ui } = setup(8);
      const view = await render(ui);
      await act(async () => store.focus('l', 10));
      const nextTurn = () => {
        timingSpy.mockClear();
        setValueSpy.mockClear();
        now += 500;
      };

      nextTurn();
      await act(async () => move(store, 'down', 1));
      expect(timingSpy).toHaveBeenCalledTimes(1);
      expect(setValueSpy).not.toHaveBeenCalled();

      nextTurn();
      await act(async () => store.dispatch({ key: 'channelDown', kind: 'press', time: now }));
      expect(timingSpy).not.toHaveBeenCalled();
      expect(setValueSpy).toHaveBeenCalledTimes(1);

      nextTurn();
      await act(async () => store.focus('l', 22));
      nextTurn();
      await view.rerender(
        cloneElement(ui, { source: createSyntheticSource(22, (i) => `Alt ${i}`) }),
      );
      expect(timingSpy).not.toHaveBeenCalled();
    });
  });

  describe('active state, empty source, clamping, FocusRing a11y and off-screen prefetch isolation', () => {
    it('shows FocusRing and selected row only on the active list of the top scope, and hides both when empty', async () => {
      const store = createFocusStore({
        id: 'root',
        lists: [
          { id: 'cats', count: 5, index: 1, orientation: 'vertical', pageSize: 5 },
          { id: 'chans', count: 5, index: 2, orientation: 'vertical', pageSize: 5 },
        ],
        active: 'cats',
      });
      const src = createSyntheticSource(5, (i) => `Row ${i}`);
      const renderItem = (item: string | undefined, focused: boolean) => (
        <Text>{`${item}${focused ? '*' : ''}`}</Text>
      );
      const pane = (id: string) => (
        <TvList
          listId={id}
          store={store}
          source={src}
          rowHeight={ROW_HEIGHT}
          visibleRows={5}
          renderRow={renderItem}
          testID={id}
        />
      );
      const isSelected = (id: string) => screen.getByTestId(id).props.accessibilityState.selected;
      await render(
        <>
          {pane('cats')}
          {pane('chans')}
        </>,
      );

      const catsRing = screen.getByTestId('cats-ring');
      expect(catsRing.props.pointerEvents).toBe('none');
      expect(catsRing.props.accessible).toBe(false);
      expect(catsRing.props.importantForAccessibility).toBe('no');
      expect(screen.queryByTestId('chans-ring')).toBeNull();
      expect(isSelected('cats-row-1')).toBe(true);
      expect(isSelected('chans-row-2')).toBe(false);

      await act(async () => void store.activate('chans'));
      expect(screen.queryByTestId('cats-ring')).toBeNull();
      expect(screen.getByTestId('chans-ring')).toBeTruthy();
      expect(isSelected('cats-row-1')).toBe(false);
      expect(isSelected('chans-row-2')).toBe(true);

      await act(async () =>
        store.pushScope(
          'dlg',
          [{ id: 'd', count: 3, index: 0, orientation: 'vertical', pageSize: 3 }],
          'd',
        ),
      );
      expect(screen.queryByTestId('cats-ring')).toBeNull();
      expect(screen.queryByTestId('chans-ring')).toBeNull();

      await act(async () => store.popScope());
      expect(screen.getByTestId('chans-ring')).toBeTruthy();
      expect(isSelected('chans-row-2')).toBe(true);

      await render(setup(5, 0).ui);
      expect(screen.queryByTestId('list-ring')).toBeNull();
    });

    it('clamps out-of-range store index and compact focusLine inside the viewport', async () => {
      const store = createFocusStore({
        id: 'root',
        lists: [{ id: 'l', count: 50, index: 25, orientation: 'vertical', pageSize: 5 }],
        active: 'l',
      });
      const shortSource = createSyntheticSource(5, (i) => `Item ${i}`);
      const props = {
        listId: 'l',
        store,
        source: shortSource,
        rowHeight: ROW_HEIGHT,
        visibleRows: 2,
        focusLine: 5,
      };
      await render(
        <TvList {...props} renderRow={(item) => <Text>{item}</Text>} testID="compact" />,
      );
      expect(screen.getByTestId('compact-ring').props.style.top).toBe(1 * ROW_HEIGHT);
      expect(screen.getByTestId('compact-row-4').props.accessibilityState).toEqual({
        selected: true,
      });
    });

    it('re-renders zero visible rows when source.onChange fires for off-screen items', async () => {
      const items = new Map<number, { label: string }>();
      for (let i = 0; i < 20; i++) items.set(i, { label: `Row ${i}` });
      items.delete(2);
      const listeners = new Set<() => void>();
      const source = {
        count: () => 100,
        get: (i: number) => items.get(i),
        prefetch: () => {},
        onChange: (fn: () => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
      const store = createFocusStore({
        id: 'root',
        lists: [{ id: 'l', count: 100, index: 0, orientation: 'vertical', pageSize: 5 }],
        active: 'l',
      });
      const rendered: number[] = [];
      const renderRow = (item: { label: string } | undefined) => {
        rendered.push(1);
        return <Text>{item?.label ?? '...'}</Text>;
      };
      const props = {
        listId: 'l',
        store,
        source,
        rowHeight: ROW_HEIGHT,
        visibleRows: 4,
        renderRow,
      };
      await render(<TvList {...props} testID="iso" />);
      rendered.length = 0;

      await act(async () => {
        items.set(50, { label: 'Offscreen 50' });
        for (const fn of listeners) fn();
      });
      expect(rendered).toHaveLength(0);

      await act(async () => {
        items.set(2, { label: 'Row 2' });
        for (const fn of listeners) fn();
      });
      expect(rendered).toHaveLength(1);
      expect(screen.getByText('Row 2')).toBeTruthy();
    });
  });
});
