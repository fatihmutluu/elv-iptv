import { clampIndex, type ListState } from './list';

/** One entry of the scope stack: its lists, the active one, and (in each list's `index`) the focus memory. */
export interface ScopeState {
  id: string;
  lists: Readonly<Record<string, ListState>>;
  active: string;
}

/** Immutable snapshot of the whole focus tree; its size is O(scopes + lists). */
export interface FocusState {
  scopes: readonly ScopeState[];
}

/** Builds a scope, clamping every list index. Throws on an empty scope, duplicate list ids or an unknown `active`. */
export function createScope(id: string, lists: readonly ListState[], active: string): ScopeState {
  const byId: Record<string, ListState> = {};
  for (const list of lists) {
    if (byId[list.id]) throw new Error(`Duplicate list id "${list.id}" in scope "${id}"`);
    const count = Math.max(0, Math.floor(list.count) || 0);
    byId[list.id] = { ...list, count, index: clampIndex(list.index, count) };
  }
  if (!byId[active]) throw new Error(`Active list "${active}" is not in scope "${id}"`);
  return { id, lists: byId, active };
}

/** Finds the list in the topmost scope that owns `listId`. */
export function findList(
  scopes: readonly ScopeState[],
  listId: string,
): { scope: number; list: ListState } | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const list = scopes[i]?.lists[listId];
    if (list) return { scope: i, list };
  }
  return undefined;
}

function replaceList(
  scopes: readonly ScopeState[],
  scopeIndex: number,
  list: ListState,
  makeActive: boolean,
): readonly ScopeState[] {
  return scopes.map((s, i) =>
    i === scopeIndex
      ? {
          ...s,
          lists: { ...s.lists, [list.id]: list },
          active: makeActive ? list.id : s.active,
        }
      : s,
  );
}

/** Returns scopes with `listId` in scope `scopeIndex` set to `index` (clamped), optionally making it active. */
export function setListIndex(
  scopes: readonly ScopeState[],
  scopeIndex: number,
  listId: string,
  index: number,
  makeActive = false,
): readonly ScopeState[] {
  const list = scopes[scopeIndex]?.lists[listId];
  if (!list) return scopes;
  return replaceList(
    scopes,
    scopeIndex,
    { ...list, index: clampIndex(index, list.count) },
    makeActive,
  );
}

/** Returns scopes with the count of `listId` in scope `scopeIndex` set (floored at 0) and its index clamped. */
export function withCount(
  scopes: readonly ScopeState[],
  scopeIndex: number,
  listId: string,
  count: number,
): readonly ScopeState[] {
  const list = scopes[scopeIndex]?.lists[listId];
  if (!list) return scopes;
  const next = Math.max(0, Math.floor(count) || 0);
  return replaceList(
    scopes,
    scopeIndex,
    { ...list, count: next, index: clampIndex(list.index, next) },
    false,
  );
}
