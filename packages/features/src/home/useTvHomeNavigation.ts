import { createFocusStore, type FocusStore, findList, type KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowseFocusMemory } from '../shared';
import type { HomeRailKind } from './home-model';

interface HomeFocusSnapshot {
  readonly rowId: HomeNavRowId;
  readonly col: number;
  readonly colByRow: Readonly<Partial<Record<HomeNavRowId, number>>>;
}

/** Navigable vertical row identifier inside {@link HomeScreen}. */
export type HomeNavRowId = 'empty' | 'hero' | HomeRailKind;

/** Descriptor of one currently visible focusable row on Home. */
export interface HomeNavRowDescriptor {
  readonly id: HomeNavRowId;
  readonly count: number;
}

const ALL_HOME_ROW_IDS: readonly HomeNavRowId[] = [
  'empty',
  'hero',
  'continue',
  'live',
  'mylist',
  'movies',
  'series',
];

function createHomeFocusStore(): FocusStore {
  return createFocusStore({
    id: 'home-scope',
    lists: ALL_HOME_ROW_IDS.map((id) => ({
      id,
      count: 0,
      index: 0,
      orientation: 'horizontal' as const,
      pageSize: 6,
    })),
    active: 'hero',
  });
}

/** Builds the ordered list of currently visible focusable Home rows for TV navigation. */
export function buildHomeNavRows(input: {
  readonly isLoading: boolean;
  readonly hasContent: boolean;
  readonly heroActionCount: number;
  readonly railOrder: readonly HomeRailKind[];
  readonly railCounts: Readonly<Record<HomeRailKind, number>>;
}): HomeNavRowDescriptor[] {
  if (input.isLoading) return [];
  if (!input.hasContent) return [{ id: 'empty', count: 1 }];
  const rows: HomeNavRowDescriptor[] = [];
  if (input.heroActionCount > 0) rows.push({ id: 'hero', count: input.heroActionCount });
  for (const id of input.railOrder) {
    const count = input.railCounts[id];
    if (count > 0) rows.push({ id, count });
  }
  return rows;
}

/** Options for {@link useTvHomeNavigation}. */
export interface UseTvHomeNavigationOptions {
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly rows: readonly HomeNavRowDescriptor[];
  readonly onActivate: (rowId: HomeNavRowId, colIndex: number) => void;
  readonly onFocusRow?: (rowId: HomeNavRowId) => void;
  readonly onFocusTopNav?: () => void;
}

/** Return value of {@link useTvHomeNavigation}. */
export interface TvHomeNavigationState {
  readonly focusedRowId: HomeNavRowId | null;
  readonly focusedCol: number | null;
  readonly handleTvKey: (event: KeyEvent) => void;
}

/**
 * Manages 10-foot TV 2D D-pad navigation across the Home Hero action row and all visible
 * horizontal rails via `@elv/focus-core`. Preserves per-row horizontal focus memory while
 * handing focus cleanly to the Top Nav on `up` from row 0 or `back`.
 */
export function useTvHomeNavigation({
  isTv,
  isActiveScope,
  rows,
  onActivate,
  onFocusRow,
  onFocusTopNav,
}: UseTvHomeNavigationOptions): TvHomeNavigationState {
  const focusMemory = useBrowseFocusMemory();
  const focusMemoryRef = useRef(focusMemory);
  focusMemoryRef.current = focusMemory;
  const initialSaved = useRef<HomeFocusSnapshot | null | undefined>(undefined);
  if (initialSaved.current === undefined) {
    initialSaved.current = focusMemory?.get<HomeFocusSnapshot>('home') ?? null;
  }
  const pendingRestoreRef = useRef<HomeFocusSnapshot | null>(initialSaved.current);

  const storeRef = useRef<FocusStore | null>(null);
  if (storeRef.current === null) {
    const created = createHomeFocusStore();
    if (rows.length > 0) {
      for (const r of rows) created.setCount(r.id, r.count);
      const saved = pendingRestoreRef.current;
      if (saved !== null) {
        for (const r of rows) {
          const savedCol = saved.colByRow[r.id];
          if (savedCol !== undefined && r.count > 0) {
            created.focus(r.id, Math.min(Math.max(0, savedCol), r.count - 1));
          }
        }
        if (rows.some((r) => r.id === saved.rowId && r.count > 0)) {
          created.activate(saved.rowId);
          pendingRestoreRef.current = null;
        }
      }
    }
    storeRef.current = created;
  }
  const store = storeRef.current;

  const [activeRowId, setActiveRowId] = useState<HomeNavRowId | null>(() => {
    const saved = initialSaved.current;
    if (saved != null && rows.some((r) => r.id === saved.rowId && r.count > 0)) {
      return saved.rowId;
    }
    return rows[0]?.id ?? null;
  });
  const [activeCol, setActiveCol] = useState(() => {
    const saved = initialSaved.current;
    if (saved != null) {
      const matched = rows.find((r) => r.id === saved.rowId && r.count > 0);
      if (matched) return Math.min(Math.max(0, saved.col), matched.count - 1);
    }
    return 0;
  });

  const persistHomeFocus = useCallback(
    (rowId: HomeNavRowId, col: number) => {
      const mem = focusMemoryRef.current;
      if (!mem) return;
      const colByRow: Partial<Record<HomeNavRowId, number>> = {};
      for (const id of ALL_HOME_ROW_IDS) {
        const list = findList(store.getState().scopes, id)?.list;
        if (list && list.count > 0) colByRow[id] = list.index;
      }
      colByRow[rowId] = col;
      mem.set<HomeFocusSnapshot>('home', { rowId, col, colByRow });
    },
    [store],
  );

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const activeRowIdRef = useRef(activeRowId);
  activeRowIdRef.current = activeRowId;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const onFocusRowRef = useRef(onFocusRow);
  onFocusRowRef.current = onFocusRow;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;

  const rowSignature = rows.map((r) => `${r.id}:${r.count}`).join('|');

  // biome-ignore lint/correctness/useExhaustiveDependencies: rowSignature intentionally avoids re-running sync when rows identity changes without membership/count changes
  useEffect(() => {
    const currentRows = rowsRef.current;
    const countById = new Map<HomeNavRowId, number>();
    for (const row of currentRows) {
      countById.set(row.id, row.count);
    }
    for (const id of ALL_HOME_ROW_IDS) {
      store.setCount(id, countById.get(id) ?? 0);
    }

    if (currentRows.length === 0) {
      setActiveRowId(null);
      setActiveCol(0);
      return;
    }

    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      for (const row of currentRows) {
        const savedCol = pending.colByRow[row.id];
        if (savedCol !== undefined && row.count > 0) {
          store.focus(row.id, Math.min(Math.max(0, savedCol), row.count - 1));
        }
      }
      const matched = currentRows.find((r) => r.id === pending.rowId && r.count > 0);
      if (matched) {
        pendingRestoreRef.current = null;
        const clamped = Math.min(Math.max(0, pending.col), matched.count - 1);
        store.focus(matched.id, clamped);
        store.activate(matched.id);
        activeRowIdRef.current = matched.id;
        setActiveRowId(matched.id);
        setActiveCol(clamped);
        return;
      }
    }

    const current = activeRowIdRef.current;
    const stillValid = current !== null && currentRows.some((r) => r.id === current && r.count > 0);
    const targetRowId = stillValid ? current : (currentRows[0]?.id ?? null);
    if (targetRowId !== null) {
      store.activate(targetRowId);
      const found = findList(store.getState().scopes, targetRowId)?.list;
      setActiveRowId(targetRowId);
      setActiveCol(found?.index ?? 0);
    }
  }, [rowSignature, store]);

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      const currentRows = rowsRef.current;
      if (currentRows.length === 0) {
        if (event.kind === 'press' && (event.key === 'up' || event.key === 'back')) {
          onFocusTopNavRef.current?.();
        }
        return;
      }

      const currentId = activeRowIdRef.current ?? currentRows[0]?.id;
      const currentIdx = Math.max(
        0,
        currentRows.findIndex((r) => r.id === currentId),
      );
      const currentRow = currentRows[currentIdx];
      if (!currentRow) return;

      pendingRestoreRef.current = null;
      store.activate(currentRow.id);

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'up') {
        if (currentIdx === 0) {
          onFocusTopNavRef.current?.();
          return;
        }
        const nextRow = currentRows[currentIdx - 1];
        if (!nextRow) return;
        store.activate(nextRow.id);
        const found = findList(store.getState().scopes, nextRow.id)?.list;
        const col = found?.index ?? 0;
        activeRowIdRef.current = nextRow.id;
        setActiveRowId(nextRow.id);
        setActiveCol(col);
        persistHomeFocus(nextRow.id, col);
        onFocusRowRef.current?.(nextRow.id);
        return;
      }

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'down') {
        if (currentIdx >= currentRows.length - 1) return;
        const nextRow = currentRows[currentIdx + 1];
        if (!nextRow) return;
        store.activate(nextRow.id);
        const found = findList(store.getState().scopes, nextRow.id)?.list;
        const col = found?.index ?? 0;
        activeRowIdRef.current = nextRow.id;
        setActiveRowId(nextRow.id);
        setActiveCol(col);
        persistHomeFocus(nextRow.id, col);
        onFocusRowRef.current?.(nextRow.id);
        return;
      }

      const intents = store.dispatch(event);
      const updated = findList(store.getState().scopes, currentRow.id)?.list;
      const col = updated?.index ?? 0;
      setActiveCol(col);
      persistHomeFocus(currentRow.id, col);

      for (const intent of intents) {
        if (intent.kind === 'back') {
          onFocusTopNavRef.current?.();
        } else if (intent.kind === 'select') {
          onActivateRef.current(currentRow.id, col);
        }
      }
    },
    [persistHomeFocus, store],
  );

  const visibleFocus = isTv && isActiveScope && activeRowId !== null;
  return {
    focusedRowId: visibleFocus ? activeRowId : null,
    focusedCol: visibleFocus ? activeCol : null,
    handleTvKey,
  };
}
