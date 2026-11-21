import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CatalogNavRowDescriptor,
  type CatalogNavRowId,
  clampGridFocus,
  computeRowCount,
  type GridFocusPosition,
} from './catalog-model';

/** Options for {@link useTvCatalogNavigation}. */
export interface UseTvCatalogNavigationOptions {
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
  readonly handleTvKey: (event: KeyEvent) => void;
}

type FocusZone = CatalogNavRowId | 'grid' | null;

/**
 * Manages 10-ft TV D-pad navigation across Catalog Discovery rows (`catChips`, `continue`,
 * `rail-N`, `loadMore`) and the O(1)-memory 2D `(row, col)` Category Grid viewport.
 */
export function useTvCatalogNavigation({
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
  const [zone, setZone] = useState<FocusZone>(() => rows[0]?.id ?? null);
  const [activeCol, setActiveCol] = useState(0);
  const [gridPos, setGridPos] = useState<GridFocusPosition>({ row: 0, col: 0 });

  const zoneRef = useRef<FocusZone>(zone);
  zoneRef.current = zone;
  const activeColRef = useRef(activeCol);
  activeColRef.current = activeCol;
  const gridPosRef = useRef(gridPos);
  gridPosRef.current = gridPos;
  const colMemoryRef = useRef<Map<CatalogNavRowId, number>>(new Map());
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

  const commitRow = useCallback((rowId: CatalogNavRowId | null, col: number) => {
    zoneRef.current = rowId;
    activeColRef.current = col;
    if (rowId !== null) colMemoryRef.current.set(rowId, col);
    setZone(rowId);
    setActiveCol(col);
  }, []);

  const commitGrid = useCallback((pos: GridFocusPosition) => {
    zoneRef.current = 'grid';
    gridPosRef.current = pos;
    setZone('grid');
    setGridPos(pos);
  }, []);

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

    if (currentZone === 'grid') {
      if (!isGridMode || gridItemCount <= 0) {
        const fallback = currentRows[0] ?? null;
        commitRow(fallback?.id ?? null, 0);
        return;
      }
      const clamped = clampGridFocus(
        gridPosRef.current.row,
        gridPosRef.current.col,
        gridItemCount,
        gridColumns,
      );
      if (clamped.row !== gridPosRef.current.row || clamped.col !== gridPosRef.current.col) {
        commitGrid(clamped);
      }
      return;
    }

    if (currentRows.length === 0) {
      commitRow(null, 0);
      return;
    }

    const matched = currentRows.find((r) => r.id === currentZone);
    if (matched) {
      const clampedCol = Math.min(Math.max(0, activeColRef.current), matched.count - 1);
      if (clampedCol !== activeColRef.current) commitRow(matched.id, clampedCol);
      return;
    }

    const target = currentRows[0];
    if (target) {
      const saved = colMemoryRef.current.get(target.id) ?? 0;
      commitRow(target.id, Math.min(Math.max(0, saved), target.count - 1));
    }
  }, [commitGrid, commitRow, gridColumns, gridItemCount, isGridMode, rowSignature]);

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      const currentRows = rowsRef.current;
      const inGridMode = isGridModeRef.current;

      if (event.kind === 'press' && event.key === 'back') {
        if (inGridMode) onExitGridRef.current();
        else onFocusTopNavRef.current?.();
        return;
      }

      const isNav = event.kind === 'press' || event.kind === 'repeat';
      const currentZone = zoneRef.current;

      if (currentZone === 'grid') {
        const count = gridItemCountRef.current;
        const cols = gridColumnsRef.current;
        const pos = gridPosRef.current;
        if (event.kind === 'press' && event.key === 'select') {
          onActivateGridItemRef.current(pos.row * cols + pos.col);
          return;
        }
        if (!isNav) return;
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
        }
        return;
      }

      if (currentRows.length === 0) {
        if (event.kind === 'press' && event.key === 'up') onFocusTopNavRef.current?.();
        return;
      }

      const idx = Math.max(
        0,
        currentRows.findIndex((r) => r.id === currentZone),
      );
      const currentRow = currentRows[idx];
      if (!currentRow) return;

      if (event.kind === 'press' && event.key === 'select') {
        onActivateRowRef.current(currentRow.id, activeColRef.current);
        return;
      }
      if (!isNav) return;

      if (event.key === 'up') {
        if (idx === 0) {
          onFocusTopNavRef.current?.();
          return;
        }
        const prevRow = currentRows[idx - 1];
        if (!prevRow) return;
        const saved = colMemoryRef.current.get(prevRow.id) ?? 0;
        commitRow(prevRow.id, Math.min(Math.max(0, saved), prevRow.count - 1));
        onFocusRowRef.current?.(prevRow.id);
      } else if (event.key === 'down') {
        if (idx + 1 < currentRows.length) {
          const nextRow = currentRows[idx + 1];
          if (!nextRow) return;
          const saved = colMemoryRef.current.get(nextRow.id) ?? 0;
          commitRow(nextRow.id, Math.min(Math.max(0, saved), nextRow.count - 1));
          onFocusRowRef.current?.(nextRow.id);
        } else if (inGridMode && gridItemCountRef.current > 0) {
          commitGrid({ row: 0, col: 0 });
        }
      } else if (event.key === 'left') {
        const nextCol = Math.max(0, activeColRef.current - 1);
        if (nextCol !== activeColRef.current) commitRow(currentRow.id, nextCol);
      } else if (event.key === 'right') {
        const nextCol = Math.min(currentRow.count - 1, activeColRef.current + 1);
        if (nextCol !== activeColRef.current) commitRow(currentRow.id, nextCol);
      }
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
