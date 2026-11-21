import { createFocusStore, type FocusStore, findList, type KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetailNavRowDescriptor, DetailNavRowId } from './detail-model';

const ALL_DETAIL_ROW_IDS: readonly DetailNavRowId[] = [
  'back',
  'hero-actions',
  'hero-play',
  'seasons',
  'episodes',
  'retry',
  'related',
];

function createDetailFocusStore(): FocusStore {
  return createFocusStore({
    id: 'detail-scope',
    lists: ALL_DETAIL_ROW_IDS.map((id) => ({
      id,
      count: 0,
      index: 0,
      orientation: id === 'episodes' ? ('vertical' as const) : ('horizontal' as const),
      pageSize: 6,
    })),
    active: 'hero-play',
  });
}

/** Options for {@link useTvDetailNavigation}. */
export interface UseTvDetailNavigationOptions {
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly targetKey: string;
  readonly rows: readonly DetailNavRowDescriptor[];
  readonly onActivate: (rowId: DetailNavRowId, colIndex: number) => void;
  readonly onBack: () => void;
  readonly onFocusRow?: (rowId: DetailNavRowId, colIndex: number) => void;
  readonly onFocusTopNav?: () => void;
}

/** Return value of {@link useTvDetailNavigation}. */
export interface TvDetailNavigationState {
  readonly focusedRowId: DetailNavRowId | null;
  readonly focusedCol: number | null;
  readonly handleTvKey: (event: KeyEvent) => void;
}

/**
 * Manages 10-ft TV D-pad focus across DetailScreen sections via `@elv/focus-core`.
 * Initial focus lands directly on `hero-play` (`detail-play`) so Select plays immediately,
 * vertical `episodes` traverse Up/Down seamlessly into adjacent horizontal rows, `Up` from `back`
 * yields to Top Nav, and `Back` anywhere calls `onBack` immediately.
 */
export function useTvDetailNavigation({
  isTv,
  isActiveScope,
  targetKey,
  rows,
  onActivate,
  onBack,
  onFocusRow,
  onFocusTopNav,
}: UseTvDetailNavigationOptions): TvDetailNavigationState {
  const storeRef = useRef<FocusStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createDetailFocusStore();
  }
  const store = storeRef.current;

  const [activeRowId, setActiveRowId] = useState<DetailNavRowId>('hero-play');
  const [activeCol, setActiveCol] = useState(0);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const activeRowIdRef = useRef<DetailNavRowId>(activeRowId);
  activeRowIdRef.current = activeRowId;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onFocusRowRef = useRef(onFocusRow);
  onFocusRowRef.current = onFocusRow;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset initial focus onto primary Play/Resume CTA whenever targetKey changes
  useEffect(() => {
    store.activate('hero-play');
    activeRowIdRef.current = 'hero-play';
    setActiveRowId('hero-play');
    setActiveCol(0);
  }, [store, targetKey]);

  const rowSignature = rows.map((r) => `${r.id}:${r.count}`).join('|');

  // biome-ignore lint/correctness/useExhaustiveDependencies: rowSignature intentionally limits focus-store sync to row membership/count changes
  useEffect(() => {
    const currentRows = rowsRef.current;
    const countById = new Map<DetailNavRowId, number>();
    for (const row of currentRows) countById.set(row.id, row.count);
    for (const id of ALL_DETAIL_ROW_IDS) store.setCount(id, countById.get(id) ?? 0);

    const current = activeRowIdRef.current;
    const stillValid = currentRows.some((r) => r.id === current && r.count > 0);
    const nextId: DetailNavRowId = stillValid
      ? current
      : (currentRows.find((r) => r.id === 'hero-play')?.id ?? currentRows[0]?.id ?? 'hero-play');

    store.activate(nextId);
    const found = findList(store.getState().scopes, nextId)?.list;
    activeRowIdRef.current = nextId;
    setActiveRowId(nextId);
    setActiveCol(found?.index ?? 0);
  }, [rowSignature, store]);

  const moveToRow = useCallback(
    (nextRow: DetailNavRowDescriptor) => {
      store.activate(nextRow.id);
      const found = findList(store.getState().scopes, nextRow.id)?.list;
      const col = found?.index ?? 0;
      activeRowIdRef.current = nextRow.id;
      setActiveRowId(nextRow.id);
      setActiveCol(col);
      onFocusRowRef.current?.(nextRow.id, col);
    },
    [store],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      if (event.kind === 'press' && event.key === 'back') {
        onBackRef.current();
        return;
      }

      const currentRows = rowsRef.current;
      if (currentRows.length === 0) return;

      const currentIdx = Math.max(
        0,
        currentRows.findIndex((r) => r.id === activeRowIdRef.current),
      );
      const currentRow = currentRows[currentIdx];
      if (!currentRow) return;

      store.activate(currentRow.id);
      const currentList = findList(store.getState().scopes, currentRow.id)?.list;
      const currentCol = currentList?.index ?? 0;

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'up') {
        if (currentRow.orientation === 'vertical' && currentCol > 0) {
          store.dispatch(event);
          const updated = findList(store.getState().scopes, currentRow.id)?.list;
          const nextCol = updated?.index ?? 0;
          setActiveCol(nextCol);
          onFocusRowRef.current?.(currentRow.id, nextCol);
          return;
        }
        if (currentIdx === 0) {
          onFocusTopNavRef.current?.();
          return;
        }
        const prevRow = currentRows[currentIdx - 1];
        if (prevRow) moveToRow(prevRow);
        return;
      }

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'down') {
        if (currentRow.orientation === 'vertical' && currentCol < currentRow.count - 1) {
          store.dispatch(event);
          const updated = findList(store.getState().scopes, currentRow.id)?.list;
          const nextCol = updated?.index ?? 0;
          setActiveCol(nextCol);
          onFocusRowRef.current?.(currentRow.id, nextCol);
          return;
        }
        if (currentIdx >= currentRows.length - 1) return;
        const nextRow = currentRows[currentIdx + 1];
        if (nextRow) moveToRow(nextRow);
        return;
      }

      if (
        currentRow.orientation === 'vertical' &&
        (event.key === 'left' || event.key === 'right')
      ) {
        return;
      }

      const intents = store.dispatch(event);
      const updated = findList(store.getState().scopes, currentRow.id)?.list;
      const col = updated?.index ?? 0;
      setActiveCol(col);

      for (const intent of intents) {
        if (intent.kind === 'back') {
          onBackRef.current();
        } else if (intent.kind === 'select') {
          onActivateRef.current(currentRow.id, col);
        }
      }
    },
    [moveToRow, store],
  );

  const visibleFocus = isTv && isActiveScope;
  return {
    focusedRowId: visibleFocus ? activeRowId : null,
    focusedCol: visibleFocus ? activeCol : null,
    handleTvKey,
  };
}
