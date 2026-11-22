import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowseFocusMemory } from '../shared';
import {
  type CatalogNavRowDescriptor,
  type CatalogNavRowId,
  clampGridFocus,
  computeRowCount,
  type GridFocusPosition,
} from './catalog-model';

/** Options for {@link useTvCatalogNavigation}. */
export interface UseTvCatalogNavigationOptions {
  readonly focusMemoryKey?: 'movie' | 'series';
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly isGridMode: boolean;
  readonly rows: readonly CatalogNavRowDescriptor[];
  readonly gridColumns: number;
  readonly gridItemCount: number;
  readonly onActivateRow: (rowId: CatalogNavRowId, colIndex: number) => void;
  readonly onActivateGridItem: (itemIndex: number) => void;
  readonly onExitGrid: () => void;
  readonly onFocusRow?: (rowId: CatalogNavRowId) => void;
  readonly onFocusTopNav?: () => void;
}

/** Return value of {@link useTvCatalogNavigation}. */
export interface TvCatalogNavigationState {
  readonly focusedRowId: CatalogNavRowId | null;
  readonly focusedCol: number | null;
  readonly focusedGridPos: GridFocusPosition | null;
  readonly handleTvKey: (event: KeyEvent) => boolean;
}

type FocusZone = CatalogNavRowId | 'grid' | null;

interface CatalogFocusSnapshot {
  readonly zone: FocusZone;
  readonly col: number;
  readonly gridPos: GridFocusPosition;
  readonly colByRow: Readonly<Partial<Record<CatalogNavRowId, number>>>;
}

/**
 * Manages 10-ft TV D-pad navigation across Catalog Discovery rows (`catChips`, `continue`,
 * `rail-N`, `loadMore`) and the O(1)-memory 2D `(row, col)` Category Grid viewport.
 */
export function useTvCatalogNavigation({
  focusMemoryKey,
  isTv,
  isActiveScope,
  isGridMode,
  rows,
  gridColumns,
  gridItemCount,
  onActivateRow,
  onActivateGridItem,
  onExitGrid,
  onFocusRow,
  onFocusTopNav,
}: UseTvCatalogNavigationOptions): TvCatalogNavigationState {
  const focusMemory = useBrowseFocusMemory();
  const focusMemoryRef = useRef(focusMemory);
  focusMemoryRef.current = focusMemory;
  const focusMemoryKeyRef = useRef(focusMemoryKey);
  focusMemoryKeyRef.current = focusMemoryKey;
  const savedOnMountRef = useRef<CatalogFocusSnapshot | null | undefined>(undefined);
  if (savedOnMountRef.current === undefined) {
    savedOnMountRef.current =
      focusMemoryKey !== undefined
        ? (focusMemory?.get<CatalogFocusSnapshot>(focusMemoryKey) ?? null)
        : null;
  }
  const pendingRestoreRef = useRef<CatalogFocusSnapshot | null>(savedOnMountRef.current);

  const [zone, setZone] = useState<FocusZone>(() => {
    const saved = savedOnMountRef.current;
    if (saved != null) {
      if (saved.zone === 'grid' && isGridMode && gridItemCount > 0) return 'grid';
      if (saved.zone !== null && saved.zone !== 'grid' && rows.some((r) => r.id === saved.zone)) {
        return saved.zone;
      }
    }
    return rows[0]?.id ?? null;
  });
  const [activeCol, setActiveCol] = useState(() => {
    const saved = savedOnMountRef.current;
    if (saved != null && saved.zone !== null && saved.zone !== 'grid') {
      const matched = rows.find((r) => r.id === saved.zone);
      if (matched) return Math.min(Math.max(0, saved.col), matched.count - 1);
    }
    return 0;
  });
  const [gridPos, setGridPos] = useState<GridFocusPosition>(() => {
    const saved = savedOnMountRef.current;
    if (saved != null && isGridMode && gridItemCount > 0) {
      return clampGridFocus(saved.gridPos.row, saved.gridPos.col, gridItemCount, gridColumns);
    }
    return { row: 0, col: 0 };
  });

  const zoneRef = useRef<FocusZone>(zone);
  zoneRef.current = zone;
  const activeColRef = useRef(activeCol);
  activeColRef.current = activeCol;
  const gridPosRef = useRef(gridPos);
  gridPosRef.current = gridPos;
  const colMemoryRef = useRef<Map<CatalogNavRowId, number>>(
    new Map(
      savedOnMountRef.current
        ? (Object.entries(savedOnMountRef.current.colByRow) as [CatalogNavRowId, number][])
        : [],
    ),
  );
  const prevGridModeRef = useRef(isGridMode);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const isGridModeRef = useRef(isGridMode);
  isGridModeRef.current = isGridMode;
  const gridColumnsRef = useRef(gridColumns);
  gridColumnsRef.current = gridColumns;
  const gridItemCountRef = useRef(gridItemCount);
  gridItemCountRef.current = gridItemCount;

  const onActivateRowRef = useRef(onActivateRow);
  onActivateRowRef.current = onActivateRow;
  const onActivateGridItemRef = useRef(onActivateGridItem);
  onActivateGridItemRef.current = onActivateGridItem;
  const onExitGridRef = useRef(onExitGrid);
  onExitGridRef.current = onExitGrid;
  const onFocusRowRef = useRef(onFocusRow);
  onFocusRowRef.current = onFocusRow;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;

  const persistCatalogFocus = useCallback(
    (nextZone: FocusZone, nextCol: number, nextGridPos: GridFocusPosition) => {
      const mem = focusMemoryRef.current;
      const key = focusMemoryKeyRef.current;
      if (!mem || !key || nextZone === null) return;
      const colByRow: Partial<Record<CatalogNavRowId, number>> = {};
      for (const [rowId, col] of colMemoryRef.current) colByRow[rowId] = col;
      mem.set<CatalogFocusSnapshot>(key, {
        zone: nextZone,
        col: nextCol,
        gridPos: nextGridPos,
        colByRow,
      });
    },
    [],
  );

  const commitRow = useCallback(
    (rowId: CatalogNavRowId | null, col: number, persist = true) => {
      zoneRef.current = rowId;
      activeColRef.current = col;
      if (rowId !== null) colMemoryRef.current.set(rowId, col);
      setZone(rowId);
      setActiveCol(col);
      if (persist) {
        pendingRestoreRef.current = null;
        persistCatalogFocus(rowId, col, gridPosRef.current);
      }
    },
    [persistCatalogFocus],
  );

  const commitGrid = useCallback(
    (pos: GridFocusPosition, persist = true) => {
      zoneRef.current = 'grid';
      gridPosRef.current = pos;
      setZone('grid');
      setGridPos(pos);
      if (persist) {
        pendingRestoreRef.current = null;
        persistCatalogFocus('grid', activeColRef.current, pos);
      }
    },
    [persistCatalogFocus],
  );

  // Transition focus cleanly when entering or exiting Grid Mode.
  useEffect(() => {
    const prev = prevGridModeRef.current;
    prevGridModeRef.current = isGridMode;
    if (prev === isGridMode) return;
    if (isGridMode) {
      if (gridItemCountRef.current > 0) {
        commitGrid({ row: 0, col: 0 });
      } else {
        commitRow('gridBack', 0);
      }
    } else {
      const firstRow = rowsRef.current[0];
      commitRow(firstRow?.id ?? null, 0);
    }
  }, [commitGrid, commitRow, isGridMode]);

  const rowSignature = rows.map((r) => `${r.id}:${r.count}`).join('|');

  // Keep active row/column valid when rows or grid item count change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowSignature intentionally avoids re-syncing on identical rows
  useEffect(() => {
    const currentRows = rowsRef.current;
    const currentZone = zoneRef.current;

    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      if (pending.zone === 'grid' && isGridMode && gridItemCount > 0) {
        pendingRestoreRef.current = null;
        commitGrid(
          clampGridFocus(pending.gridPos.row, pending.gridPos.col, gridItemCount, gridColumns),
          false,
        );
        return;
      }
      if (pending.zone !== null && pending.zone !== 'grid') {
        const matched = currentRows.find((r) => r.id === pending.zone);
        if (matched) {
          pendingRestoreRef.current = null;
          commitRow(matched.id, Math.min(Math.max(0, pending.col), matched.count - 1), false);
          return;
        }
      }
    }

    if (currentZone === 'grid') {
      if (!isGridMode || gridItemCount <= 0) {
        const fallback = currentRows[0] ?? null;
        commitRow(fallback?.id ?? null, 0, false);
        return;
      }
      const clamped = clampGridFocus(
        gridPosRef.current.row,
        gridPosRef.current.col,
        gridItemCount,
        gridColumns,
      );
      if (clamped.row !== gridPosRef.current.row || clamped.col !== gridPosRef.current.col) {
        commitGrid(clamped, false);
      }
      return;
    }

    if (currentRows.length === 0) {
      commitRow(null, 0, false);
      return;
    }

    const matched = currentRows.find((r) => r.id === currentZone);
    if (matched) {
      const clampedCol = Math.min(Math.max(0, activeColRef.current), matched.count - 1);
      if (clampedCol !== activeColRef.current) commitRow(matched.id, clampedCol, false);
      return;
    }

    const target = currentRows[0];
    if (target) {
      const saved = colMemoryRef.current.get(target.id) ?? 0;
      commitRow(target.id, Math.min(Math.max(0, saved), target.count - 1), false);
    }
  }, [commitGrid, commitRow, gridColumns, gridItemCount, isGridMode, rowSignature]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const currentRows = rowsRef.current;
      const inGridMode = isGridModeRef.current;

      if (event.kind === 'press' && event.key === 'back') {
        if (inGridMode) onExitGridRef.current();
        else onFocusTopNavRef.current?.();
        return true;
      }

      const isNav = event.kind === 'press' || event.kind === 'repeat';
      const currentZone = zoneRef.current;

      if (currentZone === 'grid') {
        const count = gridItemCountRef.current;
        const cols = gridColumnsRef.current;
        const pos = gridPosRef.current;
        if (event.kind === 'press' && event.key === 'select') {
          onActivateGridItemRef.current(pos.row * cols + pos.col);
          return true;
        }
        if (!isNav) return false;
        if (event.key === 'left') {
          if (pos.col > 0) commitGrid({ row: pos.row, col: pos.col - 1 });
        } else if (event.key === 'right') {
          const rowItems = Math.min(cols, count - pos.row * cols);
          if (pos.col + 1 < rowItems) commitGrid({ row: pos.row, col: pos.col + 1 });
        } else if (event.key === 'down') {
          const totalRows = computeRowCount(count, cols);
          if (pos.row + 1 < totalRows) {
            commitGrid(clampGridFocus(pos.row + 1, pos.col, count, cols));
          }
        } else if (event.key === 'up') {
          if (pos.row > 0) {
            commitGrid(clampGridFocus(pos.row - 1, pos.col, count, cols));
          } else {
            const lastHeader = currentRows[currentRows.length - 1];
            if (lastHeader) {
              const saved = colMemoryRef.current.get(lastHeader.id) ?? 0;
              commitRow(lastHeader.id, Math.min(Math.max(0, saved), lastHeader.count - 1));
              onFocusRowRef.current?.(lastHeader.id);
            }
          }
        } else {
          return false;
        }
        return true;
      }

      if (currentRows.length === 0) {
        if (event.kind === 'press' && event.key === 'up') {
          onFocusTopNavRef.current?.();
          return true;
        }
        return false;
      }

      const idx = Math.max(
        0,
        currentRows.findIndex((r) => r.id === currentZone),
      );
      const currentRow = currentRows[idx];
      if (!currentRow) return false;

      if (event.kind === 'press' && event.key === 'select') {
        onActivateRowRef.current(currentRow.id, activeColRef.current);
        return true;
      }
      if (!isNav) return false;

      if (event.key === 'up') {
        if (idx === 0) {
          onFocusTopNavRef.current?.();
          return true;
        }
        const prevRow = currentRows[idx - 1];
        if (!prevRow) return false;
        const saved = colMemoryRef.current.get(prevRow.id) ?? 0;
        commitRow(prevRow.id, Math.min(Math.max(0, saved), prevRow.count - 1));
        onFocusRowRef.current?.(prevRow.id);
        return true;
      }
      if (event.key === 'down') {
        if (idx + 1 < currentRows.length) {
          const nextRow = currentRows[idx + 1];
          if (!nextRow) return false;
          const saved = colMemoryRef.current.get(nextRow.id) ?? 0;
          commitRow(nextRow.id, Math.min(Math.max(0, saved), nextRow.count - 1));
          onFocusRowRef.current?.(nextRow.id);
        } else if (inGridMode && gridItemCountRef.current > 0) {
          commitGrid({ row: 0, col: 0 });
        }
        return true;
      }
      if (event.key === 'left') {
        const nextCol = Math.max(0, activeColRef.current - 1);
        if (nextCol !== activeColRef.current) commitRow(currentRow.id, nextCol);
        return true;
      }
      if (event.key === 'right') {
        const nextCol = Math.min(currentRow.count - 1, activeColRef.current + 1);
        if (nextCol !== activeColRef.current) commitRow(currentRow.id, nextCol);
        return true;
      }
      return false;
    },
    [commitGrid, commitRow],
  );

  const visible = isTv && isActiveScope;
  return {
    focusedRowId: visible && zone !== 'grid' ? zone : null,
    focusedCol: visible && zone !== 'grid' && zone !== null ? activeCol : null,
    focusedGridPos: visible && zone === 'grid' ? gridPos : null,
    handleTvKey,
  };
}
