import { createFocusStore } from '@elv/focus-core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { type FormFactor, FormFactorProvider } from '../form-factor';
import { ElvList } from '../list/ElvList';
import type { ListSource } from '../tv/list-source';

const ROW_HEIGHT = 44;
const VISIBLE_ROWS = 8;

function createSpySource(count: number, loaded = true) {
  const items = new Map<number, string>();
  const listeners = new Set<() => void>();
  let getCalls = 0;
  const prefetches: Array<[number, number]> = [];

  const source: ListSource<string> = {
    count: () => count,
    get(index: number) {
      getCalls += 1;
      if (index < 0 || index >= count) return undefined;
      if (items.has(index)) return items.get(index);
      return loaded ? `Row ${index}` : undefined;
    },
    prefetch(start: number, end: number) {
      prefetches.push([start, end]);
    },
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    source,
    getCalls: () => getCalls,
    prefetches,
    populate(start: number, end: number) {
      for (let i = start; i < end; i++) {
        items.set(i, `Loaded ${i}`);
      }
      for (const fn of listeners) fn();
    },
  };
}

describe('ElvList', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('delegates to TvList on tv, renders visibleRows + 4 slots for 100k items, prefetches, and syncs onSelectIndex', async () => {
    const spy = createSpySource(100_000);
    const store = createFocusStore({
      id: 'tv-root',
      lists: [{ id: 'channels', count: 100_000, index: 0, orientation: 'vertical', pageSize: 8 }],
      active: 'channels',
    });
    const onSelectIndex = jest.fn();
    const onActivateIndex = jest.fn();
    const renderRow = (item: string | undefined, active: boolean): ReactElement => (
      <Text>{`${item ?? '...'}${active ? ' [active]' : ''}`}</Text>
    );

    const view = await render(
      <FormFactorProvider value="tv">
        <ElvList
          listId="channels"
          store={store}
          source={spy.source}
          rowHeight={ROW_HEIGHT}
          visibleRows={VISIBLE_ROWS}
          selectedIndex={0}
          onSelectIndex={onSelectIndex}
          onActivateIndex={onActivateIndex}
          renderRow={renderRow}
          rowLabel={(item, idx) => item ?? `Item ${idx}`}
          testID="channels"
        />
      </FormFactorProvider>,
    );

    expect(screen.queryAllByTestId(/^channels-row-\d+$/)).toHaveLength(VISIBLE_ROWS + 4);
    expect(screen.getByTestId('channels-ring')).toBeTruthy();
    expect(spy.getCalls()).toBeLessThanOrEqual(40);
    expect(spy.prefetches.length).toBeGreaterThan(0);
    expect(spy.prefetches[0]).toEqual([0, 24]);

    await act(async () => {
      store.dispatch({ key: 'down', kind: 'press', time: 10 });
    });
    expect(onSelectIndex).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('channels-row-1').props.accessibilityState.selected).toBe(true);

    await view.unmount();
  });

  it('preserves active pane focus on tv when syncing selectedIndex on an inactive pane', async () => {
    const spy = createSpySource(1_000);
    const store = createFocusStore({
      id: 'tv-split',
      lists: [
        { id: 'cats', count: 10, index: 2, orientation: 'vertical', pageSize: 8 },
        { id: 'items', count: 1_000, index: 0, orientation: 'vertical', pageSize: 8 },
      ],
      active: 'cats',
    });

    const view = await render(
      <FormFactorProvider value="tv">
        <ElvList
          listId="items"
          store={store}
          source={spy.source}
          rowHeight={ROW_HEIGHT}
          visibleRows={VISIBLE_ROWS}
          selectedIndex={15}
          onActivateIndex={jest.fn()}
          renderRow={(item) => <Text>{item ?? '...'}</Text>}
          testID="items"
        />
      </FormFactorProvider>,
    );

    expect(store.isActive('cats')).toBe(true);
    expect(store.isActive('items')).toBe(false);
    expect(screen.queryByTestId('items-ring')).toBeNull();
    expect(screen.getByTestId('items-row-15')).toBeTruthy();

    await view.unmount();
  });

  it.each<FormFactor>(['phone', 'tablet', 'desktop'])(
    'windows 100k items on %s via VirtualizedList, prefetches, updates on source.onChange, and activates on press',
    async (formFactor) => {
      const spy = createSpySource(100_000, false);
      const onSelectIndex = jest.fn();
      const onActivateIndex = jest.fn();

      const view = await render(
        <FormFactorProvider value={formFactor}>
          <ElvList
            listId="movies"
            source={spy.source}
            rowHeight={ROW_HEIGHT}
            visibleRows={VISIBLE_ROWS}
            selectedIndex={2}
            onSelectIndex={onSelectIndex}
            onActivateIndex={onActivateIndex}
            renderRow={(item, active) => (
              <Text>{`${item ?? 'loading'}${active ? ' [selected]' : ''}`}</Text>
            )}
            rowLabel={(item, idx) => item ?? `Movie ${idx}`}
            testID="movies"
          />
        </FormFactorProvider>,
      );

      expect(spy.prefetches[0]).toEqual([0, VISIBLE_ROWS + 40]);
      expect(spy.getCalls()).toBeLessThan(60);
      expect(screen.getByTestId('movies-row-2').props.accessibilityState.selected).toBe(true);
      expect(screen.getByText('loading [selected]')).toBeTruthy();

      await act(async () => {
        spy.populate(0, 30);
      });
      expect(screen.getByText('Loaded 2 [selected]')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('movies-row-4'));
      expect(onSelectIndex).toHaveBeenCalledWith(4);
      expect(onActivateIndex).toHaveBeenCalledWith(4);

      await view.unmount();
    },
  );

  it('restores initialScrollIndex = 4200 on remount without scanning rows 0..4199 and handles desktop keys', async () => {
    const spy = createSpySource(100_000);
    const onSelectIndex = jest.fn();
    const onActivateIndex = jest.fn();

    const view = await render(
      <FormFactorProvider value="desktop">
        <ElvList
          listId="live"
          source={spy.source}
          rowHeight={ROW_HEIGHT}
          visibleRows={VISIBLE_ROWS}
          selectedIndex={4_200}
          onSelectIndex={onSelectIndex}
          onActivateIndex={onActivateIndex}
          renderRow={(item, active) => <Text>{`${item}${active ? '*' : ''}`}</Text>}
          testID="live"
        />
      </FormFactorProvider>,
    );

    expect(screen.getByTestId('live-row-4200')).toBeTruthy();
    expect(screen.queryByTestId('live-row-0')).toBeNull();
    expect(spy.prefetches[0]).toEqual([4_180, 4_200 + VISIBLE_ROWS + 40]);
    expect(spy.getCalls()).toBeLessThan(60);

    await fireEvent(screen.getByTestId('live-desktop-keys'), 'keyDown', { key: 'ArrowDown' });
    expect(onSelectIndex).toHaveBeenCalledWith(4_201);

    await fireEvent(screen.getByTestId('live-desktop-keys'), 'keyDown', { key: 'Enter' });
    expect(onActivateIndex).toHaveBeenCalledWith(4_200);

    await view.unmount();
  });
});
