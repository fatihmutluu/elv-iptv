import type { KeyEvent } from '@elv/focus-core';
import type { TvTextInputInstance } from '@elv/ui-kit';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBrowseFocusMemory } from '../shared';
import {
  type SearchFocusPosition,
  type SearchNavRowDescriptor,
  type SearchNavRowId,
  stepSearchFocus,
} from './search-model';

/** Options for {@link useTvSearchNavigation}. */
export interface UseTvSearchNavigationOptions {
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly hasQuery: boolean;
  readonly rows: readonly SearchNavRowDescriptor[];
  readonly onActivate: (rowId: SearchNavRowId, col: number) => void;
  readonly onClearSearch: () => void;
  readonly onFocusPosition?: (pos: SearchFocusPosition) => void;
  readonly onFocusTopNav?: () => void;
}

/** 10-ft TV navigation state and handlers returned by {@link useTvSearchNavigation}. */
export interface TvSearchNavigationState {
  readonly focusedRowId: SearchNavRowId | null;
  readonly focusedCol: number | null;
  readonly editingInput: boolean;
  readonly inputRef: MutableRefObject<TvTextInputInstance | null>;
  readonly startInputEdit: () => void;
  readonly endInputEdit: () => void;
  readonly handleTvKey: (event: KeyEvent) => void;
}

function getVisualRow(rows: readonly SearchNavRowDescriptor[], pos: SearchFocusPosition): number {
  const row = rows.find((r) => r.id === pos.rowId);
  const cols = row?.columns;
  return cols !== undefined && cols > 0 ? Math.floor(pos.col / cols) : 0;
}

/**
 * Coordinates 10-ft TV D-pad focus across `SearchScreen` rows (`input`, `scopes`, `recent`,
 * `live`, `movies`, `series`, `clearEmpty`), `TvTextInput` edit handoff, and `Back` semantics.
 */
export function useTvSearchNavigation({
  isTv,
  isActiveScope,
  hasQuery,
  rows,
  onActivate,
  onClearSearch,
  onFocusPosition,
  onFocusTopNav,
}: UseTvSearchNavigationOptions): TvSearchNavigationState {
  const focusMemory = useBrowseFocusMemory();
  const focusMemoryRef = useRef(focusMemory);
  focusMemoryRef.current = focusMemory;
  const savedOnMountRef = useRef<SearchFocusPosition | null | undefined>(undefined);
  if (savedOnMountRef.current === undefined) {
    savedOnMountRef.current = focusMemory?.get<SearchFocusPosition>('search') ?? null;
  }
  const pendingRestoreRef = useRef<SearchFocusPosition | null>(savedOnMountRef.current);

  const [pos, setPos] = useState<SearchFocusPosition>(() => {
    const saved = savedOnMountRef.current;
    if (saved != null) {
      const matched = rows.find((r) => r.id === saved.rowId && r.count > 0);
      if (matched) {
        pendingRestoreRef.current = null;
        return { rowId: matched.id, col: Math.min(Math.max(0, saved.col), matched.count - 1) };
      }
    }
    return { rowId: 'input', col: 0 };
  });
  const [editingInput, setEditingInput] = useState(false);

  const inputRef = useRef<TvTextInputInstance | null>(null);
  const posRef = useRef<SearchFocusPosition>(pos);
  posRef.current = pos;
  const editingInputRef = useRef(editingInput);
  editingInputRef.current = editingInput;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const hasQueryRef = useRef(hasQuery);
  hasQueryRef.current = hasQuery;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const onClearSearchRef = useRef(onClearSearch);
  onClearSearchRef.current = onClearSearch;
  const onFocusPositionRef = useRef(onFocusPosition);
  onFocusPositionRef.current = onFocusPosition;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;

  const commitPos = useCallback((next: SearchFocusPosition, persist = true) => {
    posRef.current = next;
    setPos(next);
    if (persist) {
      pendingRestoreRef.current = null;
      focusMemoryRef.current?.set<SearchFocusPosition>('search', next);
    }
  }, []);

  const rowSignature = rows.map((r) => `${r.id}:${r.count}:${r.columns ?? 0}`).join('|');

  // Keep active focus coordinate valid whenever visible rows change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowSignature tracks exact structural changes in rows
  useEffect(() => {
    const currentRows = rowsRef.current;
    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      const restored = currentRows.find((r) => r.id === pending.rowId && r.count > 0);
      if (restored) {
        pendingRestoreRef.current = null;
        commitPos(
          { rowId: restored.id, col: Math.min(Math.max(0, pending.col), restored.count - 1) },
          false,
        );
        return;
      }
    }
    const current = posRef.current;
    const matched = currentRows.find((r) => r.id === current.rowId);
    if (matched) {
      const clampedCol = Math.min(Math.max(0, current.col), matched.count - 1);
      if (clampedCol !== current.col) {
        commitPos({ rowId: matched.id, col: clampedCol }, false);
      }
      return;
    }
    const fallback = currentRows[0];
    if (fallback) {
      commitPos({ rowId: fallback.id, col: 0 }, false);
    }
  }, [commitPos, rowSignature]);

  // Reset edit mode and blur input whenever SearchScreen loses active TV focus scope.
  useEffect(() => {
    if (isActiveScope) return;
    if (editingInputRef.current) {
      inputRef.current?.blur?.();
      editingInputRef.current = false;
      setEditingInput(false);
    }
  }, [isActiveScope]);

  useLayoutEffect(() => {
    if (!isTv || !editingInput) return;
    inputRef.current?.focus();
  }, [editingInput, isTv]);

  const startInputEdit = useCallback(() => {
    editingInputRef.current = true;
    setEditingInput(true);
    inputRef.current?.focus();
  }, []);

  const endInputEdit = useCallback(() => {
    editingInputRef.current = false;
    setEditingInput(false);
  }, []);

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      if (event.kind === 'press' && event.key === 'back') {
        if (editingInputRef.current) {
          inputRef.current?.blur?.();
          editingInputRef.current = false;
          setEditingInput(false);
          return;
        }
        if (hasQueryRef.current) {
          onClearSearchRef.current();
          return;
        }
        onFocusTopNavRef.current?.();
        return;
      }

      if (event.kind === 'press' && event.key === 'select') {
        const current = posRef.current;
        if (current.rowId === 'input' && current.col === 0) {
          startInputEdit();
          return;
        }
        onActivateRef.current(current.rowId, current.col);
        return;
      }

      if (event.kind !== 'press' && event.kind !== 'repeat') return;
      if (
        event.key !== 'up' &&
        event.key !== 'down' &&
        event.key !== 'left' &&
        event.key !== 'right'
      ) {
        return;
      }

      const currentRows = rowsRef.current;
      const prevPos = posRef.current;
      const prevVisualRow = getVisualRow(currentRows, prevPos);
      const stepped = stepSearchFocus(currentRows, prevPos, event.key);
      if (stepped.edgeTop) {
        onFocusTopNavRef.current?.();
        return;
      }
      if (stepped.position !== null) {
        commitPos(stepped.position);
        const nextVisualRow = getVisualRow(currentRows, stepped.position);
        if (stepped.position.rowId !== prevPos.rowId || nextVisualRow !== prevVisualRow) {
          onFocusPositionRef.current?.(stepped.position);
        }
      }
    },
    [commitPos, startInputEdit],
  );

  const visible = isTv && isActiveScope;
  const focusedRowId = visible ? pos.rowId : null;
  const focusedCol = visible ? pos.col : null;

  return useMemo(
    () => ({
      focusedRowId,
      focusedCol,
      editingInput,
      inputRef,
      startInputEdit,
      endInputEdit,
      handleTvKey,
    }),
    [editingInput, endInputEdit, focusedCol, focusedRowId, handleTvKey, startInputEdit],
  );
}
