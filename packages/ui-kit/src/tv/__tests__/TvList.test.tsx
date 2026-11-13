import { createFocusStore, type FocusStore } from '@elv/focus-core';
import { act, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
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
  return { store, ui, renders, onFrameCommitted };
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
    expect(onFrameCommitted).toHaveBeenLastCalledWith(1);
    await act(async () => move(store, 'down'));
    expect(onFrameCommitted).toHaveBeenCalledTimes(2);
    await act(async () => move(store, 'up', 2));
    expect(onFrameCommitted).toHaveBeenLastCalledWith(0);
  });
});
