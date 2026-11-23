import type { AlphabetBucket } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowseFocusMemory } from '../shared';
import {
  type CatalogNavRowDescriptor,
  type CatalogNavRowId,
  clampGridFocus,
  computeRowCount,
  type GridFocusPosition,
  resolveActiveAlphabetLetter,
  stepAlphabetRailLetter,
} from './catalog-model';

const EMPTY_BUCKETS: readonly AlphabetBucket[] = [];

/** Options for {@link useTvCatalogNavigation}. */
export interface UseTvCatalogNavigationOptions {
  readonly focusMemoryKey?: 'movie' | 'series';
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly isGridMode: boolean;
  readonly rows: readonly CatalogNavRowDescriptor[];
  readonly gridColumns: number;
  readonly gridItemCount: number;
  readonly alphabetBuckets?: readonly AlphabetBucket[];
  readonly onActivateRow: (rowId: CatalogNavRowId, colIndex: number) => void;
  readonly onActivateGridItem: (itemIndex: number) => void;
  readonly onSelectAlphabetLetter?: (letter: string, offset: number) => void;
  readonly onExitGrid: () => void;
  readonly onFocusRow?: (rowId: CatalogNavRowId) => void;
  readonly onFocusTopNav?: () => void;
}

/** Return value of {@link useTvCatalogNavigation}. */
export interface TvCatalogNavigationState {
  readonly focusedRowId: CatalogNavRowId | null;
  readonly focusedCol: number | null;
  readonly focusedGridPos: GridFocusPosition | null;
  readonly focusedAlphabetLetter: string | null;
  readonly jumpToGridPos: (pos: GridFocusPosition) => void;
  readonly handleTvKey: (event: KeyEvent) => boolean;
}

type FocusZone = CatalogNavRowId | 'grid' | 'alphabetRail' | null;

interface CatalogFocusSnapshot {
  readonly zone: FocusZone;
  readonly col: number;
  readonly gridPos: GridFocusPosition;
  readonly colByRow: Readonly<Partial<Record<CatalogNavRowId, number>>>;
}

/**
 * Manages 10-ft TV D-pad navigation across Catalog Discovery rows (`catChips`, `continue`,
 * `rail-N`, `loadMore`), the O(1)-memory 2D `(row, col)` Category Grid viewport, and the trailing
 * A–Z `AlphabetJumpRail` (`#407`).
 */
export function useTvCatalogNavigation({
  focusMemoryKey,
  isTv,
  isActiveScope,
  isGridMode,
  rows,
  gridColumns,
  gridItemCount,
  alphabetBuckets = EMPTY_BUCKETS,
  onActivateRow,
  onActivateGridItem,
  onSelectAlphabetLetter,
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
      if (
        (saved.zone === 'grid' || saved.zone === 'alphabetRail') &&
        isGridMode &&
        gridItemCount > 0
      ) {
        return 'grid';
      }
      if (
        saved.zone !== null &&
        saved.zone !== 'grid' &&
        saved.zone !== 'alphabetRail' &&
        rows.some((r) => r.id === saved.zone)
      ) {
        return saved.zone;
      }
    }
    return rows[0]?.id ?? null;
  });
  const [activeCol, setActiveCol] = useState(() => {
    const saved = savedOnMountRef.current;
    if (
      saved != null &&
      saved.zone !== null &&
      saved.zone !== 'grid' &&
      saved.zone !== 'alphabetRail'
    ) {
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
  const [alphabetLetter, setAlphabetLetter] = useState<string | null>(null);

  const availableBuckets = useMemo(
    () => alphabetBuckets.filter((b) => b.count > 0),
    [alphabetBuckets],
  );
  const availableBucketsRef = useRef(availableBuckets);
  availableBucketsRef.current = availableBuckets;

  const zoneRef = useRef<FocusZone>(zone);
  zoneRef.current = zone;
  const activeColRef = useRef(activeCol);
  activeColRef.current = activeCol;
  const gridPosRef = useRef(gridPos);
  gridPosRef.current = gridPos;
  const alphabetLetterRef = useRef<string | null>(alphabetLetter);
  alphabetLetterRef.current = alphabetLetter;
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
  const onSelectAlphabetLetterRef = useRef(onSelectAlphabetLetter);
  onSelectAlphabetLetterRef.current = onSelectAlphabetLetter;
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
        zone: nextZone === 'alphabetRail' ? 'grid' : nextZone,
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
      alphabetLetterRef.current = null;
      if (rowId !== null) colMemoryRef.current.set(rowId, col);
      setZone(rowId);
      setActiveCol(col);
      setAlphabetLetter(null);
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
      alphabetLetterRef.current = null;
      setZone('grid');
      setGridPos(pos);
      setAlphabetLetter(null);
      if (persist) {
        pendingRestoreRef.current = null;
        persistCatalogFocus('grid', activeColRef.current, pos);
      }
    },
    [persistCatalogFocus],
  );

  const commitAlphabetRail = useCallback((letter: string) => {
    zoneRef.current = 'alphabetRail';
    alphabetLetterRef.current = letter;
    setZone('alphabetRail');
    setAlphabetLetter(letter);
  }, []);

  // If alphabet rail disappears while focused, return focus to grid cleanly.
  useEffect(() => {
    if (zoneRef.current === 'alphabetRail' && availableBuckets.length === 0) {
      commitGrid(gridPosRef.current, false);
    }
  }, [availableBuckets.length, commitGrid]);

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
      if (
        (pending.zone === 'grid' || pending.zone === 'alphabetRail') &&
        isGridMode &&
        gridItemCount > 0
      ) {
        pendingRestoreRef.current = null;
        commitGrid(
          clampGridFocus(pending.gridPos.row, pending.gridPos.col, gridItemCount, gridColumns),
          false,
        );
        return;
      }
      if (pending.zone !== null && pending.zone !== 'grid' && pending.zone !== 'alphabetRail') {
        const matched = currentRows.find((r) => r.id === pending.zone);
        if (matched) {
          pendingRestoreRef.current = null;
          commitRow(matched.id, Math.min(Math.max(0, pending.col), matched.count - 1), false);
          return;
        }
      }
    }

    if (currentZone === 'grid' || currentZone === 'alphabetRail') {
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
        if (currentZone === 'grid') {
          commitGrid(clamped, false);
        } else {
          gridPosRef.current = clamped;
          setGridPos(clamped);
        }
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

  const jumpToGridPos = useCallback(
    (pos: GridFocusPosition) => {
      const count = gridItemCountRef.current;
      const cols = gridColumnsRef.current;
      commitGrid(clampGridFocus(pos.row, pos.col, count, cols));
    },
    [commitGrid],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const currentRows = rowsRef.current;
      const inGridMode = isGridModeRef.current;
      const currentZone = zoneRef.current;
      const isNav = event.kind === 'press' || event.kind === 'repeat';

      if (currentZone === 'alphabetRail') {
        const buckets = availableBucketsRef.current;
        if (event.kind === 'press' && (event.key === 'back' || event.key === 'left')) {
          commitGrid(gridPosRef.current);
          return true;
        }
        if (event.kind === 'press' && event.key === 'select') {
          const curLetter = alphabetLetterRef.current?.trim().toUpperCase() ?? null;
          const bucket =
            (curLetter !== null
              ? buckets.find((b) => b.letter.trim().toUpperCase() === curLetter)
              : undefined) ?? buckets[0];
          if (bucket) {
            onSelectAlphabetLetterRef.current?.(bucket.letter, bucket.offset);
            const cols = Math.max(1, gridColumnsRef.current);
            const count = gridItemCountRef.current;
            const targetPos = clampGridFocus(
              Math.floor(bucket.offset / cols),
              bucket.offset % cols,
              count,
              cols,
            );
            commitGrid(targetPos);
          } else {
            commitGrid(gridPosRef.current);
          }
          return true;
        }
        if (!isNav) return false;
        if (event.key === 'up' || event.key === 'down') {
          const nextLetter = stepAlphabetRailLetter(buckets, alphabetLetterRef.current, event.key);
          if (nextLetter !== null) {
            commitAlphabetRail(nextLetter);
          }
          return true;
        }
        if (event.key === 'right') {
          return true;
        }
        return false;
      }

      if (event.kind === 'press' && event.key === 'back') {
        if (inGridMode) onExitGridRef.current();
        else onFocusTopNavRef.current?.();
        return true;
      }

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
          if (pos.col + 1 < rowItems) {
            commitGrid({ row: pos.row, col: pos.col + 1 });
          } else if (availableBucketsRef.current.length > 0) {
            const currentOffset = pos.row * cols + pos.col;
            const initialLetter =
              resolveActiveAlphabetLetter(availableBucketsRef.current, currentOffset) ??
              availableBucketsRef.current[0]?.letter ??
              null;
            if (initialLetter !== null) {
              commitAlphabetRail(initialLetter);
            }
          }
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
    [commitAlphabetRail, commitGrid, commitRow],
  );

  const visible = isTv && isActiveScope;
  return {
    focusedRowId: visible && zone !== 'grid' && zone !== 'alphabetRail' ? zone : null,
    focusedCol:
      visible && zone !== 'grid' && zone !== 'alphabetRail' && zone !== null ? activeCol : null,
    focusedGridPos: visible && zone === 'grid' ? gridPos : null,
    focusedAlphabetLetter: visible && zone === 'alphabetRail' ? alphabetLetter : null,
    jumpToGridPos,
    handleTvKey,
  };
}
