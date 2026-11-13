import { type FocusStore, findList } from '@elv/focus-core';
import {
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
} from 'react';
import { Animated, View } from 'react-native';
import { FocusRing } from './FocusRing';
import type { ListSource } from './list-source';

/** Extra rows rendered beyond the visible ones, two above and two below. */
const BUFFER_ROWS = 4;
/** Duration of the offset animation for a single step. */
const STEP_MS = 90;
/** Index changes closer together than this are treated as a held key: the offset is set without animating. */
const REPEAT_WINDOW_MS = 150;
/** Native coordinates are anchored every this many pools of rows, so they stay far below float32 precision limits. */
const ANCHOR_POOLS = 8;

/** What a committed frame showed: the visible rows `[start, end)` and the rows rendered `[renderedStart, renderedEnd)`. */
export interface FrameWindow {
  start: number;
  end: number;
  renderedStart: number;
  renderedEnd: number;
}

/** Props of {@link TvList}. */
export interface TvListProps<T> {
  listId: string;
  store: FocusStore;
  source: ListSource<T>;
  rowHeight: number;
  visibleRows: number;
  /** Row slot (0-based from the top of the viewport) where the focused item rests mid-list. Default 2. */
  focusLine?: number;
  renderRow: (item: T | undefined, focused: boolean) => ReactElement;
  /** Accessibility label of a row, so a screen reader can read the focused one. */
  rowLabel?: (item: T | undefined, index: number) => string;
  testID?: string;
  /** Called once per focused-index change, on the first animation frame after the new row and ring committed, with the window that frame showed. Not called when the index returns to its previous value before a frame. */
  onFrameCommitted?: (index: number, window: FrameWindow) => void;
}

interface RowProps<T> {
  index: number;
  top: number;
  height: number;
  focused: boolean;
  version: number;
  source: ListSource<T>;
  renderRow: (item: T | undefined, focused: boolean) => ReactElement;
  rowLabel?: (item: T | undefined, index: number) => string;
  testID?: string;
}

function RowImpl<T>({
  index,
  top,
  height,
  focused,
  source,
  renderRow,
  rowLabel,
  testID,
}: RowProps<T>) {
  const item = source.get(index);
  return (
    <View
      accessibilityLabel={rowLabel?.(item, index)}
      testID={testID === undefined ? undefined : `${testID}-row-${index}`}
      accessibilityState={{ selected: focused }}
      style={{ position: 'absolute', left: 0, right: 0, top, height }}
    >
      {renderRow(item, focused)}
    </View>
  );
}
const Row = memo(RowImpl) as typeof RowImpl;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * A windowed vertical list driven only by a focus store. It renders `visibleRows + 4` row slots; slot `i % pool`
 * always hosts item `i`, so one step re-renders the entering slot plus the rows losing and gaining focus (at most
 * three), whatever the pool size. The viewport slides with a native-driven `Animated.Value`. Mid-list the focused
 * item rests on `focusLine` and the ring sits at `focusLine * rowHeight`; at the ends the window cannot slide, so the
 * ring leaves the line there. Native coordinates are relative to an anchor row that moves every
 * `8 * pool` rows (all rows re-render once then), so they stay bounded at 100,000 rows. Rows never use `onPress`.
 */
export function TvList<T>({
  listId,
  store,
  source,
  rowHeight,
  visibleRows,
  focusLine = 2,
  renderRow,
  rowLabel,
  testID,
  onFrameCommitted,
}: TvListProps<T>): ReactElement {
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getIndex = useCallback(
    () => findList(store.getState().scopes, listId)?.list.index ?? 0,
    [store, listId],
  );
  const index = useSyncExternalStore(subscribe, getIndex, getIndex);
  const [version, bump] = useReducer((v: number) => v + 1, 0);
  useEffect(() => source.onChange(bump), [source]);

  const count = source.count();
  const pool = visibleRows + BUFFER_ROWS;
  const windowStart = clamp(index - focusLine, 0, count - visibleRows);
  const rangeStart = clamp(windowStart - BUFFER_ROWS / 2, 0, count - pool);
  const rangeEnd = Math.min(count, rangeStart + pool);

  const anchor = pool * ANCHOR_POOLS;
  const base = Math.floor(rangeStart / anchor) * anchor;
  const translate = -(windowStart - base) * rowHeight;

  const offset = useRef<Animated.Value>(null as unknown as Animated.Value);
  if (offset.current === null) offset.current = new Animated.Value(translate);
  const synced = useRef({ base, rowHeight, start: windowStart, at: 0 });
  const callback = useRef(onFrameCommitted);
  callback.current = onFrameCommitted;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const prev = synced.current;
    if (prev.base === base && prev.rowHeight === rowHeight && prev.start === windowStart) return;
    const now = performance.now();
    const step = prev.base === base && prev.rowHeight === rowHeight;
    const held = now - prev.at < REPEAT_WINDOW_MS;
    synced.current = { base, rowHeight, start: windowStart, at: now };
    if (step && !held) {
      Animated.timing(offset.current, {
        toValue: translate,
        duration: STEP_MS,
        useNativeDriver: true,
      }).start();
    } else {
      offset.current.setValue(translate);
    }
  }, [base, rowHeight, windowStart, translate]);

  const shownIndex = useRef(index);
  useLayoutEffect(() => {
    if (shownIndex.current === index) return;
    shownIndex.current = index;
    const shown: FrameWindow = {
      start: windowStart,
      end: windowStart + visibleRows,
      renderedStart: rangeStart,
      renderedEnd: rangeEnd,
    };
    requestAnimationFrame(() => {
      if (mounted.current) callback.current?.(index, shown);
    });
  }, [index, windowStart, visibleRows, rangeStart, rangeEnd]);

  const prefetchStart = Math.max(0, rangeStart - pool);
  const prefetchEnd = Math.min(count, rangeEnd + pool);
  useEffect(() => {
    source.prefetch(prefetchStart, prefetchEnd);
  }, [source, prefetchStart, prefetchEnd]);

  const rows: ReactElement[] = [];
  for (let i = rangeStart; i < rangeEnd; i++) {
    rows.push(
      <Row
        key={i % pool}
        index={i}
        top={(i - base) * rowHeight}
        height={rowHeight}
        focused={i === index}
        version={version}
        source={source}
        renderRow={renderRow}
        rowLabel={rowLabel}
        testID={testID}
      />,
    );
  }

  return (
    <View testID={testID} style={{ height: visibleRows * rowHeight, overflow: 'hidden' }}>
      <Animated.View style={{ transform: [{ translateY: offset.current }] }}>{rows}</Animated.View>
      <FocusRing
        testID={testID === undefined ? undefined : `${testID}-ring`}
        top={(index - windowStart) * rowHeight}
        height={rowHeight}
      />
    </View>
  );
}
