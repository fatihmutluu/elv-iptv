import type { FocusStore } from '@elv/focus-core';
import type { ListSource } from '@elv/ui-kit';
import type { ThirdPartyNotice } from './notices-data';

export const NOTICES_LIST_ID = 'notices-list';
const PARKED_SCOPE_ID = '__notices_parked__';
const PARKED_LIST_ID = '__notices_parked_list__';

export function createNoticesListSource(
  items: readonly ThirdPartyNotice[],
): ListSource<ThirdPartyNotice> {
  return {
    count: () => items.length,
    get: (index) => (index >= 0 && index < items.length ? items[index] : undefined),
    prefetch: () => undefined,
    onChange: () => () => undefined,
  };
}

export function syncNoticesScopeActive(store: FocusStore, isActiveScope: boolean): void {
  const scopes = store.getState().scopes;
  const isParked = scopes[scopes.length - 1]?.id === PARKED_SCOPE_ID;
  if (!isActiveScope) {
    if (!isParked) {
      store.pushScope(
        PARKED_SCOPE_ID,
        [{ id: PARKED_LIST_ID, count: 0, index: 0, orientation: 'vertical', pageSize: 1 }],
        PARKED_LIST_ID,
      );
    }
    return;
  }
  if (isParked) store.popScope();
  if (!store.isActive(NOTICES_LIST_ID)) store.activate(NOTICES_LIST_ID);
}
