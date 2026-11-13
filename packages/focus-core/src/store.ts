import type { KeyEvent } from './keys';
import { type ListState, moveList } from './list';
import {
  createScope,
  type FocusState,
  findList,
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

/** Change reported to subscribers: the list whose index changed and its new index. */
export interface FocusChange {
  listId: string;
  index: number;
}

/** Index-based focus over lists with a scope stack. No React import; consumers subscribe. */
export interface FocusStore {
  /** Applies one key event to the active list of the top scope and returns the intents for the app. */
  dispatch(event: KeyEvent): Intent[];
  getState(): FocusState;
  /** Listeners run only when a list's visible index changes. Returns an unsubscribe function. */
  subscribe(listener: (change: FocusChange) => void): () => void;
  /** Pushes a scope over the current one. Throws if `active` is not among `lists`. */
  pushScope(id: string, lists: readonly ListState[], active: string): void;
  /** Pops the top scope, restoring the opener; a no-op at the root. */
  popScope(): void;
  /** Sets the item count of the topmost list with this id; its index is clamped. Unknown ids are ignored. */
  setCount(listId: string, count: number): void;
  /** Moves focus to `index` (clamped) of the topmost list with this id and makes it active. Unknown ids are ignored. */
  focus(listId: string, index: number): void;
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

  const emit = (change: FocusChange): void => {
    for (const l of [...listeners]) l(change);
  };

  function visibleIndex(list: readonly ScopeState[], id: string): number | undefined {
    return findList(list, id)?.list.index;
  }

  function notifyDiff(
    before: readonly ScopeState[],
    after: readonly ScopeState[],
    ids: Iterable<string>,
  ): void {
    for (const id of ids) {
      const a = visibleIndex(after, id);
      if (a !== undefined && a !== visibleIndex(before, id)) emit({ listId: id, index: a });
    }
  }

  function update(next: readonly ScopeState[], id: string): void {
    const before = scopes;
    scopes = next;
    notifyDiff(before, next, [id]);
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
      update(setListIndex(scopes, scopes.length - 1, list.id, result.index), list.id);
      return [];
    }
    if (result.kind === 'edge') return [{ kind: 'edge', listId: list.id, side: result.side }];
    return [{ kind: 'key', event }];
  }

  function pushScope(id: string, lists: readonly ListState[], active: string): void {
    const scope = createScope(id, lists, active);
    const before = scopes;
    scopes = [...scopes, scope];
    notifyDiff(before, scopes, Object.keys(scope.lists));
  }

  function popScope(): void {
    if (scopes.length <= 1) return;
    const before = scopes;
    const popped = scopes[scopes.length - 1] as ScopeState;
    scopes = scopes.slice(0, -1);
    notifyDiff(before, scopes, Object.keys(popped.lists));
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
      if (found) update(withCount(scopes, found.scope, listId, count), listId);
    },
    focus(listId, index) {
      const found = findList(scopes, listId);
      if (found) update(setListIndex(scopes, found.scope, listId, index, true), listId);
    },
  };
}
