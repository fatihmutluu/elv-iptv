import {
  createFocusStore,
  createKeyInterpreter,
  type FocusStore,
  findList,
  type Key,
  type KeyEvent,
} from '@elv/focus-core';
import { createSyntheticSource, type FrameWindow, TvList, useTvKeySource } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { createAutoDriver } from './driver';
import { createRecorder, gateLine } from './metrics';
import type { GateParams } from './routes';

const LIST_ID = 'list';
const ROW_HEIGHT = 72;
const VISIBLE_ROWS = 10;
const FOCUS_LINE = 2;
const LAG_INTERVAL_MS = 4;
const WARMUP_MS = 500;
const SETTLE_POLL_MS = 25;
const SETTLE_TIMEOUT_MS = 2000;
const IDLE_FLUSH_MS = 2000;
const TICK_MS = 16;

interface Channel {
  number: number;
  name: string;
}

const makeChannel = (index: number): Channel => ({
  number: index + 1,
  name: `Channel ${index + 1}`,
});

function renderChannel(item: Channel | undefined, focused: boolean): ReactElement {
  return (
    <View style={[styles.row, focused && styles.rowFocused]}>
      <Text style={styles.number}>{item?.number}</Text>
      <Text style={styles.name}>{item?.name}</Text>
    </View>
  );
}

const rowLabel = (item: Channel | undefined): string => item?.name ?? '';

const currentIndex = (store: FocusStore): number =>
  findList(store.getState().scopes, LIST_ID)?.list.index ?? 0;

/** Props of {@link GateListScreen}. */
export interface GateListScreenProps {
  params: GateParams;
}

/**
 * Development gate for the TV list. It shows `params.items` synthetic channels and measures key-to-highlight latency
 * and event-loop gaps while the list is driven, either by the auto-driver (`params.auto`, one `ELV_GATE {json}`
 * console line when the run finishes) or by real remote keys (one line after 2 s without a move). Counters live in
 * refs and the recorder, so a move never re-renders this screen.
 */
export function GateListScreen({ params }: GateListScreenProps): ReactElement {
  const { items, auto, rate, moves } = params;
  const store = useMemo(
    () =>
      createFocusStore({
        id: 'gate',
        lists: [
          { id: LIST_ID, count: items, index: 0, orientation: 'vertical', pageSize: VISIBLE_ROWS },
        ],
        active: LIST_ID,
      }),
    [items],
  );
  const source = useMemo(() => createSyntheticSource(items, makeChannel), [items]);
  const recorder = useMemo(() => createRecorder({ items }), [items]);
  const interpreter = useMemo(() => createKeyInterpreter(), []);
  const active = useRef(!auto);
  const lastRepeat = useRef<Key | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCommitted = useRef(0);
  const frameCheck = useRef(false);
  const held = useRef(new Set<Key>());
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const emit = useCallback(() => {
    // biome-ignore lint/suspicious/noConsole: the gate runner reads this line from logcat
    console.log(gateLine(recorder.finish()));
  }, [recorder]);

  const apply = useCallback(
    (event: KeyEvent, t0: number) => {
      const before = currentIndex(store);
      store.dispatch(event);
      if (currentIndex(store) === before) return;
      recorder.move(t0);
      if (frameCheck.current) return;
      frameCheck.current = true;
      requestAnimationFrame(() => {
        frameCheck.current = false;
        if (recorder.pending() > 0 && currentIndex(store) === lastCommitted.current) {
          recorder.resolve(performance.now());
        }
      });
    },
    [store, recorder],
  );

  const deliver = useCallback(
    (event: KeyEvent) => {
      if (event.kind === 'repeat') lastRepeat.current = event.key;
      apply(event, event.time);
      if (!auto) {
        clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(emit, IDLE_FLUSH_MS);
      }
    },
    [apply, auto, emit],
  );

  const stopTicker = useCallback(() => {
    clearInterval(ticker.current);
    ticker.current = undefined;
  }, []);

  const onInput = useCallback(
    (k: Parameters<typeof interpreter.input>[0]) => {
      if (k.action === 'down') {
        held.current.add(k.key);
        ticker.current ??= setInterval(() => {
          for (const e of interpreter.tick(performance.now())) deliver(e);
        }, TICK_MS);
      } else if (k.action === 'up') {
        held.current.delete(k.key);
        if (held.current.size === 0) stopTicker();
      }
      for (const e of interpreter.input(k)) deliver(e);
    },
    [interpreter, deliver, stopTicker],
  );
  useTvKeySource(onInput);

  const onFrameCommitted = useCallback(
    (index: number, window: FrameWindow) => {
      lastCommitted.current = index;
      recorder.commit(performance.now(), index, currentIndex(store), window);
      if (lastRepeat.current !== undefined) interpreter.acknowledge(lastRepeat.current);
    },
    [recorder, store, interpreter],
  );

  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const gap = now - last - LAG_INTERVAL_MS;
      last = now;
      if (active.current && gap > 0.5) recorder.gap(gap);
    }, LAG_INTERVAL_MS);
    return () => clearInterval(id);
  }, [recorder]);

  useEffect(() => {
    if (!auto) return;
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!cancelled) fn();
      }, ms);
      timers.add(id);
    };
    const driver = createAutoDriver(
      (event) => {
        if (event.kind === 'repeat' && recorder.pending() > 0) {
          recorder.coalesce();
          return;
        }
        apply(event, performance.now());
      },
      { rate, moves, now: () => performance.now(), schedule: later },
    );
    const settleStart = { at: 0 };
    const settle = () => {
      if (cancelled) return;
      if (recorder.pending() === 0 || performance.now() - settleStart.at > SETTLE_TIMEOUT_MS) {
        active.current = false;
        emit();
        return;
      }
      later(settle, SETTLE_POLL_MS);
    };
    later(() => {
      active.current = true;
      void driver.start().then(() => {
        if (cancelled) return;
        settleStart.at = performance.now();
        settle();
      });
    }, WARMUP_MS);
    return () => {
      cancelled = true;
      driver.stop();
      recorder.finish();
      for (const id of timers) clearTimeout(id);
    };
  }, [auto, rate, moves, recorder, apply, emit]);

  useEffect(
    () => () => {
      clearTimeout(idleTimer.current);
      clearInterval(ticker.current);
    },
    [],
  );

  return (
    <View style={styles.root}>
      <Text style={styles.header}>{`${items} items`}</Text>
      <TvList
        listId={LIST_ID}
        store={store}
        source={source}
        rowHeight={ROW_HEIGHT}
        visibleRows={VISIBLE_ROWS}
        focusLine={FOCUS_LINE}
        renderRow={renderChannel}
        rowLabel={rowLabel}
        testID="gate-list"
        onFrameCommitted={onFrameCommitted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0e14', paddingHorizontal: 48, paddingTop: 24 },
  header: { color: '#9aa4b2', fontSize: 24, height: 40 },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24 },
  rowFocused: { backgroundColor: '#1c2433' },
  number: { color: '#6b7686', fontSize: 28, width: 140 },
  name: { color: '#ffffff', fontSize: 32 },
});
