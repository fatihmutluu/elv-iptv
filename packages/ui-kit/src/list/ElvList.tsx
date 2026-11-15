import { createFocusStore, type FocusStore, findList } from '@elv/focus-core';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  View,
  VirtualizedList,
} from 'react-native';
import { type FormFactor, useFormFactor } from '../form-factor';
import type { ListSource } from '../tv/list-source';
import { TvList } from '../tv/TvList';

const PREFETCH_BEHIND = 20;
const PREFETCH_AHEAD = 40;
const SCROLL_QUANTUM = 10;

/** Props of {@link ElvList}. */
export interface ElvListProps<T> {
  listId: string;
  store?: FocusStore;
  source: ListSource<T>;
  rowHeight: number;
  visibleRows: number;
  selectedIndex: number;
  onSelectIndex?: (index: number) => void;
  onActivateIndex: (index: number) => void;
  renderRow: (item: T | undefined, active: boolean, index: number) => ReactElement;
  rowLabel?: (item: T | undefined, index: number) => string;
  testID?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

interface DesktopKeyboardEventLike {
  key?: unknown;
  ctrlKey?: unknown;
  altKey?: unknown;
  metaKey?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  __elvHandled?: boolean;
}

interface ScrollOffsetTarget {
  scrollToOffset(params: { offset: number; animated?: boolean }): void;
}

function ElvListTv<T>({
  listId,
  store,
  source,
  rowHeight,
  visibleRows,
  selectedIndex,
  onSelectIndex,
  renderRow,
  rowLabel,
  testID,
}: ElvListProps<T>): ReactElement {
  const fallbackStoreRef = useRef<{ listId: string; store: FocusStore } | null>(null);
  if (store === undefined && fallbackStoreRef.current?.listId !== listId) {
    fallbackStoreRef.current = {
      listId,
      store: createFocusStore({
        id: `${listId}-fallback`,
        lists: [
          {
            id: listId,
            count: Math.max(0, source.count()),
            index: Math.max(0, Math.floor(selectedIndex)),
            orientation: 'vertical',
            pageSize: Math.max(1, visibleRows),
          },
        ],
        active: listId,
      }),
    };
  }
  const activeStore = store ?? (fallbackStoreRef.current as { store: FocusStore }).store;

  const [, bump] = useReducer((v: number) => v + 1, 0);
  useEffect(() => source.onChange(bump), [source]);

  const count = Math.max(0, source.count());
  const prevSourceRef = useRef(source);
  const prevSelectedPropRef = useRef(selectedIndex);
  const pendingRestoreRef = useRef<number | null>(selectedIndex);
  const syncingRef = useRef(false);

  const lastReportedRef = useRef(selectedIndex);
  const onSelectRef = useRef(onSelectIndex);
  onSelectRef.current = onSelectIndex;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useLayoutEffect(() => {
    if (prevSourceRef.current !== source) {
      prevSourceRef.current = source;
      prevSelectedPropRef.current = selectedIndex;
      pendingRestoreRef.current = selectedIndex;
    } else if (prevSelectedPropRef.current !== selectedIndex) {
      prevSelectedPropRef.current = selectedIndex;
      pendingRestoreRef.current = selectedIndex;
    }

    syncingRef.current = true;
    try {
      activeStore.setCount(listId, count);
      if (count > 0 && pendingRestoreRef.current !== null) {
        const target = clamp(Math.floor(pendingRestoreRef.current), 0, count - 1);
        pendingRestoreRef.current = null;
        lastReportedRef.current = target;
        const found = findList(activeStore.getState().scopes, listId);
        if (found && found.list.index !== target) {
          const prevScopeActive = activeStore.getState().scopes[found.scope]?.active;
          activeStore.focus(listId, target);
          if (prevScopeActive !== undefined && prevScopeActive !== listId) {
            activeStore.activate(prevScopeActive);
          }
        }
      }
    } finally {
      syncingRef.current = false;
    }
  }, [activeStore, count, listId, selectedIndex, source]);

  useEffect(() => {
    return activeStore.subscribe((change) => {
      if (syncingRef.current || change.listId !== listId) return;
      if (sourceRef.current.count() <= 0) return;
      pendingRestoreRef.current = null;
      if (change.index !== lastReportedRef.current) {
        lastReportedRef.current = change.index;
        onSelectRef.current?.(change.index);
      }
    });
  }, [activeStore, listId]);

  return (
    <TvList
      listId={listId}
      store={activeStore}
      source={source}
      rowHeight={rowHeight}
      visibleRows={visibleRows}
      renderRow={renderRow}
      {...(rowLabel !== undefined ? { rowLabel } : {})}
      {...(testID !== undefined ? { testID } : {})}
    />
  );
}

function ElvListPointer<T>({
  source,
  rowHeight,
  visibleRows,
  selectedIndex,
  onSelectIndex,
  onActivateIndex,
  renderRow,
  rowLabel,
  testID,
  formFactor,
}: ElvListProps<T> & { formFactor: Exclude<FormFactor, 'tv'> }): ReactElement {
  const containerRef = useRef<{ focus?: () => void } | null>(null);
  const listRef = useRef<ScrollOffsetTarget | null>(null);
  const [version, bump] = useReducer((v: number) => v + 1, 0);
  useEffect(() => source.onChange(bump), [source]);

  const count = Math.max(0, source.count());
  const safeSelected = count > 0 ? clamp(Math.floor(selectedIndex), 0, count - 1) : 0;
  const [scrollBucket, setScrollBucket] = useState(() => Math.floor(safeSelected / SCROLL_QUANTUM));

  const prevSourceRef = useRef(source);
  useEffect(() => {
    if (prevSourceRef.current === source) return;
    prevSourceRef.current = source;
    const nextCount = Math.max(0, source.count());
    const target = nextCount > 0 ? clamp(Math.floor(selectedIndex), 0, nextCount - 1) : 0;
    setScrollBucket(Math.floor(target / SCROLL_QUANTUM));
    listRef.current?.scrollToOffset({ offset: target * rowHeight, animated: false });
  }, [rowHeight, selectedIndex, source]);

  useEffect(() => {
    if (count <= 0) return;
    const anchor = scrollBucket * SCROLL_QUANTUM;
    const start = Math.max(0, anchor - PREFETCH_BEHIND);
    const end = Math.min(count, anchor + visibleRows + PREFETCH_AHEAD);
    source.prefetch(start, end);
  }, [count, scrollBucket, source, visibleRows]);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (rowHeight <= 0) return;
      const firstRow = Math.max(0, Math.floor(e.nativeEvent.contentOffset.y / rowHeight));
      const nextBucket = Math.floor(firstRow / SCROLL_QUANTUM);
      setScrollBucket((prev) => (prev === nextBucket ? prev : nextBucket));
    },
    [rowHeight],
  );

  const scrollRowIntoView = useCallback(
    (index: number) => {
      const targetOffset = Math.max(0, (index - Math.floor(visibleRows / 2)) * rowHeight);
      listRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
      setScrollBucket(Math.floor(index / SCROLL_QUANTUM));
    },
    [rowHeight, visibleRows],
  );

  const handleDesktopKeyDown = useCallback(
    (event: DesktopKeyboardEventLike) => {
      if (count <= 0 || !event || typeof event.key !== 'string') return;
      if (event.__elvHandled) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Enter') {
        event.__elvHandled = true;
        event.preventDefault?.();
        event.stopPropagation?.();
        containerRef.current?.focus?.();
        onActivateIndex(safeSelected);
        return;
      }
      let next: number | undefined;
      if (event.key === 'ArrowDown') next = clamp(safeSelected + 1, 0, count - 1);
      else if (event.key === 'ArrowUp') next = clamp(safeSelected - 1, 0, count - 1);
      else if (event.key === 'PageDown') next = clamp(safeSelected + visibleRows, 0, count - 1);
      else if (event.key === 'PageUp') next = clamp(safeSelected - visibleRows, 0, count - 1);
      if (next !== undefined) {
        event.__elvHandled = true;
        event.preventDefault?.();
        containerRef.current?.focus?.();
        onSelectIndex?.(next);
        scrollRowIntoView(next);
      }
    },
    [count, onActivateIndex, onSelectIndex, safeSelected, scrollRowIntoView, visibleRows],
  );

  const bindContainerRef = useCallback((node: unknown) => {
    containerRef.current = node as { focus?: () => void } | null;
  }, []);
  const bindListRef = useCallback((node: unknown) => {
    listRef.current = node as ScrollOffsetTarget | null;
  }, []);
  const getItemCount = useCallback(() => Math.max(0, source.count()), [source]);
  const getItem = useCallback((_data: unknown, index: number) => source.get(index), [source]);
  const keyExtractor = useCallback((_item: unknown, index: number) => String(index), []);
  const getItemLayout = useCallback(
    (_data: unknown, index: number) => ({
      length: rowHeight,
      offset: rowHeight * index,
      index,
    }),
    [rowHeight],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: unknown; index: number }) => {
      const typedItem = item as T | undefined;
      const active = count > 0 && index === safeSelected;
      const desktopRowProps: Record<string, unknown> =
        formFactor === 'desktop' ? { tabIndex: -1 } : {};
      return (
        <Pressable
          testID={testID === undefined ? undefined : `${testID}-row-${index}`}
          accessibilityRole="button"
          accessibilityLabel={rowLabel?.(typedItem, index)}
          accessibilityState={{ selected: active }}
          {...desktopRowProps}
          onPress={(event: unknown) => {
            if (formFactor === 'desktop') {
              if ((event as { type?: unknown } | null)?.type === 'keyup') return;
              containerRef.current?.focus?.();
            }
            onSelectIndex?.(index);
            onActivateIndex(index);
          }}
          style={{ height: rowHeight, justifyContent: 'center' }}
        >
          {renderRow(typedItem, active, index)}
        </Pressable>
      );
    },
    [
      count,
      formFactor,
      onActivateIndex,
      onSelectIndex,
      renderRow,
      rowHeight,
      rowLabel,
      safeSelected,
      testID,
    ],
  );

  const viewportHeight = visibleRows * rowHeight;
  const desktopKeyProps: Record<string, unknown> =
    formFactor === 'desktop'
      ? {
          tabIndex: 0,
          onKeyDownCapture: handleDesktopKeyDown,
          onKeyDown: handleDesktopKeyDown,
        }
      : {};

  return (
    <View
      ref={bindContainerRef}
      testID={
        formFactor === 'desktop' && testID !== undefined ? `${testID}-desktop-keys` : undefined
      }
      style={{ height: viewportHeight, overflow: 'hidden' }}
      {...desktopKeyProps}
    >
      <VirtualizedList
        key={count === 0 ? 'empty' : 'ready'}
        ref={bindListRef}
        testID={testID}
        data={source}
        extraData={{ version, safeSelected, renderRow }}
        getItemCount={getItemCount}
        getItem={getItem}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        renderItem={renderItem}
        initialNumToRender={visibleRows + 4}
        maxToRenderPerBatch={visibleRows + 4}
        windowSize={5}
        {...(count > 0 && safeSelected > 0 ? { initialScrollIndex: safeSelected } : {})}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        style={{ height: viewportHeight }}
      />
    </View>
  );
}

/**
 * Windowed vertical list over an O(1) {@link ListSource}. Delegates to {@link TvList} on `'tv'` and
 * to a fixed-height `VirtualizedList` on `'phone'`, `'tablet'`, and `'desktop'`, never materializing
 * full category arrays in memory.
 */
export function ElvList<T>(props: ElvListProps<T>): ReactElement {
  const formFactor = useFormFactor();
  if (formFactor === 'tv') {
    return <ElvListTv {...props} />;
  }
  return <ElvListPointer {...props} formFactor={formFactor} />;
}
