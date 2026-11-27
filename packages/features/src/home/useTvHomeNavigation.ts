import type { HomeLayoutSectionId } from '@elv/domain';
import { createFocusStore, type FocusStore, findList, type KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowseFocusMemory } from '../shared';
import type { HomeCollectionRailId, HomeRailKind } from './home-model';

interface HomeFocusSnapshot {
  readonly rowId: HomeNavRowId;
  readonly col: number;
  readonly colByRow: Readonly<Partial<Record<HomeNavRowId, number>>>;
}

/** Navigable vertical row identifier inside {@link HomeScreen}. */
export type HomeNavRowId = 'empty' | 'hero' | HomeRailKind | HomeCollectionRailId;

/** Descriptor of one currently visible focusable row on Home. */
export interface HomeNavRowDescriptor {
  readonly id: HomeNavRowId;
  readonly count: number;
}

const STATIC_HOME_ROW_IDS: readonly HomeNavRowId[] = [
  'empty',
  'hero',
  'continue',
  'elvShowcase',
  'newEpisodes',
  'live',
  'movies',
  'series',
  'mylist',
];

function collectRowIds(rows: readonly HomeNavRowDescriptor[]): HomeNavRowId[] {
  const seen = new Set<HomeNavRowId>(STATIC_HOME_ROW_IDS);
  const ids: HomeNavRowId[] = [...STATIC_HOME_ROW_IDS];
  for (const r of rows) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      ids.push(r.id);
    }
  }
  return ids;
}

function createHomeFocusStore(
  rowIds: readonly HomeNavRowId[],
  previous?: FocusStore | null,
  activeId?: HomeNavRowId | null,
): FocusStore {
  const prevScopes = previous?.getState().scopes;
  const lists = rowIds.map((id) => {
    const prevList = prevScopes ? findList(prevScopes, id)?.list : undefined;
    return {
      id,
      count: prevList?.count ?? 0,
      index: prevList?.index ?? 0,
      orientation: 'horizontal' as const,
      pageSize: 6,
    };
  });
  const active =
    activeId !== undefined && activeId !== null && rowIds.includes(activeId) ? activeId : 'hero';
  return createFocusStore({ id: 'home-scope', lists, active });
}

/** Builds the ordered list of currently visible focusable Home rows for TV navigation. */
export function buildHomeNavRows(input: {
  readonly isLoading: boolean;
  readonly hasContent: boolean;
  readonly heroActionCount: number;
  readonly railOrder: readonly HomeRailKind[];
  readonly railCounts: Readonly<Record<HomeRailKind, number>>;
  readonly sectionOrder?: readonly HomeLayoutSectionId[];
  readonly collectionRails?: readonly {
    readonly id: HomeCollectionRailId;
    readonly count: number;
  }[];
}): HomeNavRowDescriptor[] {
  if (input.isLoading) return [];
  if (!input.hasContent) return [{ id: 'empty', count: 1 }];
  const rows: HomeNavRowDescriptor[] = [];
  if (input.heroActionCount > 0) rows.push({ id: 'hero', count: input.heroActionCount });

  const pushCollections = (): void => {
    for (const col of input.collectionRails ?? []) {
      if (col.count > 0) rows.push({ id: col.id, count: col.count });
    }
  };

  if (input.sectionOrder !== undefined) {
    const showcaseCount = input.railCounts.elvShowcase ?? 0;
    const hasContinueSection = input.sectionOrder.includes('continue');
    if (showcaseCount > 0 && !hasContinueSection) {
      rows.push({ id: 'elvShowcase', count: showcaseCount });
    }
    for (const sectionId of input.sectionOrder) {
      if (sectionId === 'collections') {
        pushCollections();
      } else {
        const count = input.railCounts[sectionId];
        if (count > 0) rows.push({ id: sectionId, count });
        if (sectionId === 'continue' && showcaseCount > 0) {
          rows.push({ id: 'elvShowcase', count: showcaseCount });
        }
      }
    }
    return rows;
  }

  for (const id of input.railOrder) {
    const count = input.railCounts[id];
    if (count > 0) rows.push({ id, count });
  }
  pushCollections();
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
  readonly handleTvKey: (event: KeyEvent) => boolean;
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
  const knownRowIdsRef = useRef<HomeNavRowId[]>(collectRowIds(rows));
  if (storeRef.current === null) {
    const created = createHomeFocusStore(knownRowIdsRef.current);
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

  const persistHomeFocus = useCallback((rowId: HomeNavRowId, col: number) => {
    const mem = focusMemoryRef.current;
    const store = storeRef.current;
    if (!mem || !store) return;
    const colByRow: Partial<Record<HomeNavRowId, number>> = {};
    for (const id of knownRowIdsRef.current) {
      const list = findList(store.getState().scopes, id)?.list;
      if (list && list.count > 0) colByRow[id] = list.index;
    }
    colByRow[rowId] = col;
    mem.set<HomeFocusSnapshot>('home', { rowId, col, colByRow });
  }, []);

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
    const neededIds = collectRowIds(currentRows);
    const hasNewId = neededIds.some((id) => !knownRowIdsRef.current.includes(id));
    if (hasNewId || storeRef.current === null) {
      knownRowIdsRef.current = neededIds;
      storeRef.current = createHomeFocusStore(neededIds, storeRef.current, activeRowIdRef.current);
    }
    const store = storeRef.current;
    const countById = new Map<HomeNavRowId, number>();
    for (const row of currentRows) {
      countById.set(row.id, row.count);
    }
    for (const id of knownRowIdsRef.current) {
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
  }, [rowSignature]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const store = storeRef.current;
      const currentRows = rowsRef.current;
      if (!store || currentRows.length === 0) {
        if (event.kind === 'press' && (event.key === 'up' || event.key === 'back')) {
          onFocusTopNavRef.current?.();
          return true;
        }
        return false;
      }

      const currentId = activeRowIdRef.current ?? currentRows[0]?.id;
      const currentIdx = Math.max(
        0,
        currentRows.findIndex((r) => r.id === currentId),
      );
      const currentRow = currentRows[currentIdx];
      if (!currentRow) return false;

      pendingRestoreRef.current = null;
      store.activate(currentRow.id);

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'up') {
        if (currentIdx === 0) {
          onFocusTopNavRef.current?.();
          return true;
        }
        const nextRow = currentRows[currentIdx - 1];
        if (!nextRow) return false;
        store.activate(nextRow.id);
        const found = findList(store.getState().scopes, nextRow.id)?.list;
        const col = found?.index ?? 0;
        activeRowIdRef.current = nextRow.id;
        setActiveRowId(nextRow.id);
        setActiveCol(col);
        persistHomeFocus(nextRow.id, col);
        onFocusRowRef.current?.(nextRow.id);
        return true;
      }

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'down') {
        if (currentIdx >= currentRows.length - 1) return false;
        const nextRow = currentRows[currentIdx + 1];
        if (!nextRow) return false;
        store.activate(nextRow.id);
        const found = findList(store.getState().scopes, nextRow.id)?.list;
        const col = found?.index ?? 0;
        activeRowIdRef.current = nextRow.id;
        setActiveRowId(nextRow.id);
        setActiveCol(col);
        persistHomeFocus(nextRow.id, col);
        onFocusRowRef.current?.(nextRow.id);
        return true;
      }

      const intents = store.dispatch(event);
      const updated = findList(store.getState().scopes, currentRow.id)?.list;
      const col = updated?.index ?? 0;
      setActiveCol(col);
      persistHomeFocus(currentRow.id, col);

      for (const intent of intents) {
        if (intent.kind === 'back') {
          onFocusTopNavRef.current?.();
          return true;
        }
        if (intent.kind === 'select') {
          onActivateRef.current(currentRow.id, col);
          return true;
        }
      }
      return event.key === 'left' || event.key === 'right';
    },
    [persistHomeFocus],
  );

  const visibleFocus = isTv && isActiveScope && activeRowId !== null;
  return {
    focusedRowId: visibleFocus ? activeRowId : null,
    focusedCol: visibleFocus ? activeCol : null,
    handleTvKey,
  };
}
