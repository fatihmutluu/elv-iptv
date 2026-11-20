import type { KeyEvent } from './keys';
import { clampIndex, type ListState, moveList } from './list';
import {
  createScope,
  type FocusState,
  findList,
  resolveFallbackId,
  type ScopeState,
  setListIndex,
  withCount,
} from './scope';

/** What the app should do after a key event. */
export type Intent =
  | { kind: 'select'; listId: string; index: number }
  | { kind: 'long'; listId: string; index: number }
  | { kind: 'back' }
  | { kind: 'backLong' }
  | { kind: 'edge'; listId: string; side: 'start' | 'end' }
  | { kind: 'key'; event: KeyEvent };

/** Change reported to subscribers on a focus, active-list, emptiness, or scope transition. */
export interface FocusChange {
  listId: string;
  index: number;
}

/** Index-based focus over lists with a scope stack. No React import; consumers subscribe. */
export interface FocusStore {
  /** Applies one key event to the active list of the top scope and returns the intents for the app. */
  dispatch(event: KeyEvent): Intent[];
  getState(): FocusState;
  /** Listeners run FIFO on every focus, active-list, emptiness, or scope transition. Returns an unsubscribe function. */
  subscribe(listener: (change: FocusChange) => void): () => void;
  /** Pushes a scope over the current one. Throws if `active` is not among `lists`. */
  pushScope(id: string, lists: readonly ListState[], active: string): void;
  /** Pops the top scope, restoring the opener; a no-op at the root. */
  popScope(): void;
  /** Sets the item count of the topmost list with this id; its index is clamped. Unknown ids are ignored. */
  setCount(listId: string, count: number): void;
  /** Moves focus to `index` (clamped, or kept if omitted) of the topmost list with this id and makes it active. */
  focus(listId: string, index?: number): void;
  /** Makes the topmost list with `listId` active, preserving its focus memory. Returns `false` for unknown ids. */
  activate(listId: string): boolean;
  /** Whether `listId` is the `active` list of the topmost scope. */
  isActive(listId: string): boolean;
}

/**
 * Creates a focus store. `select` press and long become `select`/`long` intents (nothing for an empty list); `back`
 * press pops a pushed scope, or at the root gives `back`; `back` long gives `backLong` and never pops; a list edge
 * gives `edge`; every other key the active list does not consume gives `key`.
 */
export function createFocusStore(root: {
  id: string;
  lists: readonly ListState[];
  active: string;
}): FocusStore {
  let scopes: readonly ScopeState[] = [createScope(root.id, root.lists, root.active)];
  const listeners = new Set<(change: FocusChange) => void>();
  const queue: FocusChange[] = [];
  let flushing = false;

  function enqueue(...changes: FocusChange[]): void {
    if (changes.length === 0) return;
    queue.push(...changes);
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift() as FocusChange;
        for (const l of [...listeners]) {
          if (listeners.has(l)) l(next);
        }
      }
    } finally {
      queue.length = 0;
      flushing = false;
    }
  }

  function visibleIndex(list: readonly ScopeState[], id: string): number | undefined {
    return findList(list, id)?.list.index;
  }

  function dispatch(event: KeyEvent): Intent[] {
    const top = scopes[scopes.length - 1] as ScopeState;
    const list = top.lists[top.active] as ListState;
    if (event.key === 'back') {
      if (event.kind === 'long') return [{ kind: 'backLong' }];
      if (event.kind === 'press') {
        if (scopes.length === 1) return [{ kind: 'back' }];
        popScope();
        return [];
      }
    }
    if (event.key === 'select' && event.kind !== 'repeat') {
      if (list.count <= 0) return [];
      return [
        { kind: event.kind === 'long' ? 'long' : 'select', listId: list.id, index: list.index },
      ];
    }
    const result = moveList(list, event);
    if (result.kind === 'moved') {
      scopes = setListIndex(scopes, scopes.length - 1, list.id, result.index);
      enqueue({ listId: list.id, index: result.index });
      return [];
    }
    if (result.kind === 'edge') return [{ kind: 'edge', listId: list.id, side: result.side }];
    return [{ kind: 'key', event }];
  }

  function pushScope(id: string, lists: readonly ListState[], active: string): void {
    const scope = createScope(id, lists, active);
    const before = scopes;
    scopes = [...scopes, scope];
    for (const listId of Object.keys(scope.lists)) {
      if (listId === scope.active) continue;
      const next = (scope.lists[listId] as ListState).index;
      if (next !== visibleIndex(before, listId)) enqueue({ listId, index: next });
    }
    enqueue({ listId: scope.active, index: (scope.lists[scope.active] as ListState).index });
  }

  function popScope(): void {
    if (scopes.length <= 1) return;
    const popped = scopes[scopes.length - 1] as ScopeState;
    scopes = scopes.slice(0, -1);
    let restored = scopes[scopes.length - 1] as ScopeState;
    const activeList = restored.lists[restored.active] as ListState;
    if (activeList.count === 0) {
      const fallbackId = resolveFallbackId(restored, restored.active);
      if (fallbackId !== undefined) {
        const target = restored.lists[fallbackId] as ListState;
        scopes = setListIndex(scopes, scopes.length - 1, fallbackId, target.index, true);
        restored = scopes[scopes.length - 1] as ScopeState;
      }
    }
    const changes: FocusChange[] = [];
    for (const listId of Object.keys(popped.lists)) {
      if (listId === restored.active) continue;
      const next = visibleIndex(scopes, listId);
      if (next !== undefined && next !== (popped.lists[listId] as ListState).index) {
        changes.push({ listId, index: next });
      }
    }
    changes.push({
      listId: restored.active,
      index: (restored.lists[restored.active] as ListState).index,
    });
    enqueue(...changes);
  }

  function focusList(listId: string, index?: number): boolean {
    const found = findList(scopes, listId);
    if (!found) return false;
    const nextIndex = index === undefined ? found.list.index : clampIndex(index, found.list.count);
    const wasActive = (scopes[found.scope] as ScopeState).active === listId;
    if (wasActive && nextIndex === found.list.index) return true;
    scopes = setListIndex(scopes, found.scope, listId, nextIndex, true);
    enqueue({ listId, index: nextIndex });
    return true;
  }

  return {
    dispatch,
    getState: () => ({ scopes }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pushScope,
    popScope,
    setCount(listId, count) {
      const found = findList(scopes, listId);
      if (!found) return;
      const nextCount = Math.max(0, Math.floor(count) || 0);
      if (nextCount === found.list.count) return;
      const nextIndex = clampIndex(found.list.index, nextCount);
      scopes = withCount(scopes, found.scope, listId, nextCount);
      const changes: FocusChange[] = [];
      if (nextIndex !== found.list.index || found.list.count > 0 !== nextCount > 0) {
        changes.push({ listId, index: nextIndex });
      }
      const scope = scopes[found.scope] as ScopeState;
      if (nextCount === 0 && scope.active === listId) {
        const fallbackId = resolveFallbackId(scope, listId);
        if (fallbackId !== undefined) {
          const target = scope.lists[fallbackId] as ListState;
          scopes = setListIndex(scopes, found.scope, fallbackId, target.index, true);
          changes.push({ listId: fallbackId, index: target.index });
        }
      }
      enqueue(...changes);
    },
    focus(listId, index) {
      focusList(listId, index);
    },
    activate: (listId) => focusList(listId),
    isActive(listId) {
      const top = scopes[scopes.length - 1] as ScopeState;
      return top.active === listId;
    },
  };
}
