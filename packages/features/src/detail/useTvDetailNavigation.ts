import { createFocusStore, type FocusStore, findList, type KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowseFocusMemory } from '../shared';
import type { DetailNavRowDescriptor, DetailNavRowId } from './detail-model';

interface DetailFocusSnapshot {
  readonly rowId: DetailNavRowId;
  readonly col: number;
  readonly colByRow: Readonly<Partial<Record<DetailNavRowId, number>>>;
}

const ALL_DETAIL_ROW_IDS: readonly DetailNavRowId[] = [
  'back',
  'hero-actions',
  'hero-play',
  'cast',
  'seasons',
  'episode-chunks',
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
  readonly selectedChunkIndex?: number;
  readonly onActivate: (rowId: DetailNavRowId, colIndex: number) => void;
  readonly onBack: () => void;
  readonly onFocusRow?: (rowId: DetailNavRowId, colIndex: number) => void;
  readonly onFocusTopNav?: () => void;
}

/** Return value of {@link useTvDetailNavigation}. */
export interface TvDetailNavigationState {
  readonly focusedRowId: DetailNavRowId | null;
  readonly focusedCol: number | null;
  readonly handleTvKey: (event: KeyEvent) => boolean;
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
  selectedChunkIndex,
  onActivate,
  onBack,
  onFocusRow,
  onFocusTopNav,
}: UseTvDetailNavigationOptions): TvDetailNavigationState {
  const focusMemory = useBrowseFocusMemory();
  const focusMemoryRef = useRef(focusMemory);
  focusMemoryRef.current = focusMemory;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const savedOnMountRef = useRef<DetailFocusSnapshot | null | undefined>(undefined);
  if (savedOnMountRef.current === undefined) {
    savedOnMountRef.current = focusMemory?.get<DetailFocusSnapshot>(`detail:${targetKey}`) ?? null;
  }
  const pendingRestoreRef = useRef<DetailFocusSnapshot | null>(savedOnMountRef.current);

  const storeRef = useRef<FocusStore | null>(null);
  if (storeRef.current === null) {
    const created = createDetailFocusStore();
    for (const r of rows) created.setCount(r.id, r.count);
    const saved = pendingRestoreRef.current;
    if (saved !== null) {
      for (const r of rows) {
        const c = saved.colByRow[r.id];
        if (c !== undefined && r.count > 0) {
          created.focus(r.id, Math.min(Math.max(0, c), r.count - 1));
        }
      }
      const matched = rows.find((r) => r.id === saved.rowId && r.count > 0);
      if (matched) {
        created.focus(matched.id, Math.min(Math.max(0, saved.col), matched.count - 1));
        created.activate(matched.id);
        pendingRestoreRef.current = null;
      }
    }
    storeRef.current = created;
  }
  const store = storeRef.current;

  const [activeRowId, setActiveRowId] = useState<DetailNavRowId>(() => {
    const saved = savedOnMountRef.current;
    if (saved != null && rows.some((r) => r.id === saved.rowId && r.count > 0)) {
      return saved.rowId;
    }
    return 'hero-play';
  });
  const [activeCol, setActiveCol] = useState(() => {
    const saved = savedOnMountRef.current;
    if (saved != null) {
      const matched = rows.find((r) => r.id === saved.rowId && r.count > 0);
      if (matched) return Math.min(Math.max(0, saved.col), matched.count - 1);
    }
    return 0;
  });

  const persistDetailFocus = useCallback(
    (rowId: DetailNavRowId, col: number) => {
      const mem = focusMemoryRef.current;
      if (!mem) return;
      const colByRow: Partial<Record<DetailNavRowId, number>> = {};
      for (const id of ALL_DETAIL_ROW_IDS) {
        const list = findList(store.getState().scopes, id)?.list;
        if (list && list.count > 0) colByRow[id] = list.index;
      }
      colByRow[rowId] = col;
      mem.set<DetailFocusSnapshot>(`detail:${targetKeyRef.current}`, { rowId, col, colByRow });
    },
    [store],
  );

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

  const prevTargetKeyRef = useRef(targetKey);
  useEffect(() => {
    if (prevTargetKeyRef.current === targetKey) return;
    prevTargetKeyRef.current = targetKey;
    const saved = focusMemoryRef.current?.get<DetailFocusSnapshot>(`detail:${targetKey}`) ?? null;
    pendingRestoreRef.current = saved;
    if (saved !== null) {
      const matched = rowsRef.current.find((r) => r.id === saved.rowId && r.count > 0);
      if (matched) {
        const clamped = Math.min(Math.max(0, saved.col), matched.count - 1);
        store.focus(matched.id, clamped);
        store.activate(matched.id);
        pendingRestoreRef.current = null;
        activeRowIdRef.current = matched.id;
        setActiveRowId(matched.id);
        setActiveCol(clamped);
        return;
      }
    }
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

    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      for (const row of currentRows) {
        const c = pending.colByRow[row.id];
        if (c !== undefined && row.count > 0) {
          store.focus(row.id, Math.min(Math.max(0, c), row.count - 1));
        }
      }
      const matched = currentRows.find((r) => r.id === pending.rowId && r.count > 0);
      if (matched) {
        const clamped = Math.min(Math.max(0, pending.col), matched.count - 1);
        store.focus(matched.id, clamped);
        store.activate(matched.id);
        pendingRestoreRef.current = null;
        activeRowIdRef.current = matched.id;
        setActiveRowId(matched.id);
        setActiveCol(clamped);
        return;
      }
    }

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: align inactive episode-chunks focus memory with auto-selected chunk after row counts sync
  useEffect(() => {
    if (selectedChunkIndex === undefined || activeRowIdRef.current === 'episode-chunks') return;
    const chunkList = findList(store.getState().scopes, 'episode-chunks')?.list;
    if (!chunkList || chunkList.count <= 0) return;
    const currentActive = activeRowIdRef.current;
    store.focus('episode-chunks', selectedChunkIndex);
    store.activate(currentActive);
  }, [rowSignature, selectedChunkIndex, store]);

  const moveToRow = useCallback(
    (nextRow: DetailNavRowDescriptor) => {
      pendingRestoreRef.current = null;
      store.activate(nextRow.id);
      const found = findList(store.getState().scopes, nextRow.id)?.list;
      const col = found?.index ?? 0;
      activeRowIdRef.current = nextRow.id;
      setActiveRowId(nextRow.id);
      setActiveCol(col);
      persistDetailFocus(nextRow.id, col);
      onFocusRowRef.current?.(nextRow.id, col);
    },
    [persistDetailFocus, store],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onBackRef.current();
        return true;
      }

      const currentRows = rowsRef.current;
      if (currentRows.length === 0) return false;

      const currentIdx = Math.max(
        0,
        currentRows.findIndex((r) => r.id === activeRowIdRef.current),
      );
      const currentRow = currentRows[currentIdx];
      if (!currentRow) return false;

      if (
        (event.kind === 'press' || event.kind === 'repeat') &&
        (event.key === 'up' ||
          event.key === 'down' ||
          event.key === 'left' ||
          event.key === 'right' ||
          event.key === 'select')
      ) {
        pendingRestoreRef.current = null;
      }

      store.activate(currentRow.id);
      const currentList = findList(store.getState().scopes, currentRow.id)?.list;
      const currentCol = currentList?.index ?? 0;

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'up') {
        if (currentRow.orientation === 'vertical' && currentCol > 0) {
          pendingRestoreRef.current = null;
          store.dispatch(event);
          const updated = findList(store.getState().scopes, currentRow.id)?.list;
          const nextCol = updated?.index ?? 0;
          setActiveCol(nextCol);
          persistDetailFocus(currentRow.id, nextCol);
          onFocusRowRef.current?.(currentRow.id, nextCol);
          return true;
        }
        if (currentIdx === 0) {
          onFocusTopNavRef.current?.();
          return true;
        }
        const prevRow = currentRows[currentIdx - 1];
        if (prevRow) moveToRow(prevRow);
        return true;
      }

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'down') {
        if (currentRow.orientation === 'vertical' && currentCol < currentRow.count - 1) {
          pendingRestoreRef.current = null;
          store.dispatch(event);
          const updated = findList(store.getState().scopes, currentRow.id)?.list;
          const nextCol = updated?.index ?? 0;
          setActiveCol(nextCol);
          persistDetailFocus(currentRow.id, nextCol);
          onFocusRowRef.current?.(currentRow.id, nextCol);
          return true;
        }
        if (currentIdx >= currentRows.length - 1) return false;
        const nextRow = currentRows[currentIdx + 1];
        if (nextRow) moveToRow(nextRow);
        return true;
      }

      if (
        currentRow.orientation === 'vertical' &&
        (event.key === 'left' || event.key === 'right')
      ) {
        return false;
      }

      const intents = store.dispatch(event);
      const updated = findList(store.getState().scopes, currentRow.id)?.list;
      const col = updated?.index ?? 0;
      setActiveCol(col);
      persistDetailFocus(currentRow.id, col);

      for (const intent of intents) {
        if (intent.kind === 'back') {
          onBackRef.current();
          return true;
        }
        if (intent.kind === 'select') {
          onActivateRef.current(currentRow.id, col);
          return true;
        }
      }
      return event.key === 'left' || event.key === 'right';
    },
    [moveToRow, persistDetailFocus, store],
  );

  const visibleFocus = isTv && isActiveScope;
  return {
    focusedRowId: visibleFocus ? activeRowId : null,
    focusedCol: visibleFocus ? activeCol : null,
    handleTvKey,
  };
}
