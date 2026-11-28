import type { CatalogService } from '@elv/data';
import { useEffect, useMemo, useRef } from 'react';
import type { SyncAccountPort } from './ports/wave-f9-ports';

type ResultLike = { readonly ok: boolean };

function isOkResult(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === 'object' && value !== null && (value as ResultLike).ok === true;
}

function wrapResultMutation<Args extends unknown[], R>(
  catalog: CatalogService,
  fn: ((...args: Args) => Promise<R>) | undefined,
  onSyncDirty: () => void,
): ((...args: Args) => Promise<R>) | undefined {
  if (fn === undefined) return undefined;
  return async (...args: Args): Promise<R> => {
    const res = await fn.apply(catalog, args);
    if (isOkResult(res)) {
      onSyncDirty();
    }
    return res;
  };
}

/**
 * Wraps a {@link CatalogService} so every successful user-state or source/profile/parental
 * mutation notifies the automatic background E2EE sync scheduler (`#510`, `[1.44]`).
 * Periodic 10s VOD `saveProgress` mutations ONLY invoke `onMarkSyncDirty` (marking the vault
 * dirty for the 3-minute heartbeat and pause/exit flush) and NEVER fire the 3s debounced push.
 */
export function wrapCatalogForSyncDirty(
  catalog: CatalogService,
  onSyncDirty?: () => void,
  onMarkSyncDirty?: () => void,
): CatalogService {
  if (onSyncDirty === undefined && onMarkSyncDirty === undefined) return catalog;
  const wrap = <Args extends unknown[], R>(
    fn: ((...args: Args) => Promise<R>) | undefined,
  ): ((...args: Args) => Promise<R>) | undefined =>
    onSyncDirty !== undefined ? wrapResultMutation(catalog, fn, onSyncDirty) : undefined;

  const addSource = wrap(catalog.addSource);
  const addSourceFromLink = wrap(catalog.addSourceFromLink);
  const addLocalM3uSource = wrap(catalog.addLocalM3uSource);
  const renameSource = wrap(catalog.renameSource);
  const setSourceExcludedProfiles = wrap(catalog.setSourceExcludedProfiles);
  const removeSource = wrap(catalog.removeSource);
  const updateSourceSettings = wrap(catalog.updateSourceSettings);

  const toggleFavorite = wrap(catalog.toggleFavorite);
  const setFavorite = wrap(catalog.setFavorite);
  const reorderFavorites = wrap(catalog.reorderFavorites);
  const setRating = wrap(catalog.setRating);
  const saveProgress =
    onMarkSyncDirty !== undefined
      ? wrapResultMutation(catalog, catalog.saveProgress, onMarkSyncDirty)
      : undefined;
  const setWatched = wrap(catalog.setWatched);
  const clearProgress = wrap(catalog.clearProgress);
  const dismissMyListNewEpisode = wrap(catalog.dismissMyListNewEpisode);

  const createCollection = wrap(catalog.createCollection);
  const renameCollection = wrap(catalog.renameCollection);
  const reorderCollections = wrap(catalog.reorderCollections);
  const deleteCollection = wrap(catalog.deleteCollection);
  const addItemToCollection = wrap(catalog.addItemToCollection);
  const removeItemFromCollection = wrap(catalog.removeItemFromCollection);
  const reorderCollectionItems = wrap(catalog.reorderCollectionItems);

  const createProfile = wrap(catalog.createProfile);
  const updateProfile = wrap(catalog.updateProfile);
  const deleteProfile = wrap(catalog.deleteProfile);
  const updateParentalSettings = wrap(catalog.updateParentalSettings);
  const setParentalLock = wrap(catalog.setParentalLock);
  const setParentalPin = wrap(catalog.setParentalPin);
  const clearParentalPin = wrap(catalog.clearParentalPin);

  const setChannelOverride = wrap(catalog.setChannelOverride);
  const clearChannelOverride = wrap(catalog.clearChannelOverride);
  const reorderChannels = wrap(catalog.reorderChannels);
  const createCustomGroup = wrap(catalog.createCustomGroup);
  const updateCustomGroup = wrap(catalog.updateCustomGroup);
  const deleteCustomGroup = wrap(catalog.deleteCustomGroup);
  const setCustomGroupItems = wrap(catalog.setCustomGroupItems);
  const addChannelToCustomGroup = wrap(catalog.addChannelToCustomGroup);
  const removeChannelFromCustomGroup = wrap(catalog.removeChannelFromCustomGroup);
  const createLiveFavoriteFolder = wrap(catalog.createLiveFavoriteFolder);
  const renameLiveFavoriteFolder = wrap(catalog.renameLiveFavoriteFolder);
  const deleteLiveFavoriteFolder = wrap(catalog.deleteLiveFavoriteFolder);
  const assignLiveFavoriteFolder = wrap(catalog.assignLiveFavoriteFolder);

  return {
    ...catalog,
    ...(addSource ? { addSource } : {}),
    ...(addSourceFromLink ? { addSourceFromLink } : {}),
    ...(addLocalM3uSource ? { addLocalM3uSource } : {}),
    ...(renameSource ? { renameSource } : {}),
    ...(setSourceExcludedProfiles ? { setSourceExcludedProfiles } : {}),
    ...(removeSource ? { removeSource } : {}),
    ...(updateSourceSettings ? { updateSourceSettings } : {}),
    ...(toggleFavorite ? { toggleFavorite } : {}),
    ...(setFavorite ? { setFavorite } : {}),
    ...(reorderFavorites ? { reorderFavorites } : {}),
    ...(setRating ? { setRating } : {}),
    ...(saveProgress ? { saveProgress } : {}),
    ...(setWatched ? { setWatched } : {}),
    ...(clearProgress ? { clearProgress } : {}),
    ...(dismissMyListNewEpisode ? { dismissMyListNewEpisode } : {}),
    ...(createCollection ? { createCollection } : {}),
    ...(renameCollection ? { renameCollection } : {}),
    ...(reorderCollections ? { reorderCollections } : {}),
    ...(deleteCollection ? { deleteCollection } : {}),
    ...(addItemToCollection ? { addItemToCollection } : {}),
    ...(removeItemFromCollection ? { removeItemFromCollection } : {}),
    ...(reorderCollectionItems ? { reorderCollectionItems } : {}),
    ...(createProfile ? { createProfile } : {}),
    ...(updateProfile ? { updateProfile } : {}),
    ...(deleteProfile ? { deleteProfile } : {}),
    ...(updateParentalSettings ? { updateParentalSettings } : {}),
    ...(setParentalLock ? { setParentalLock } : {}),
    ...(setParentalPin ? { setParentalPin } : {}),
    ...(clearParentalPin ? { clearParentalPin } : {}),
    ...(setChannelOverride ? { setChannelOverride } : {}),
    ...(clearChannelOverride ? { clearChannelOverride } : {}),
    ...(reorderChannels ? { reorderChannels } : {}),
    ...(createCustomGroup ? { createCustomGroup } : {}),
    ...(updateCustomGroup ? { updateCustomGroup } : {}),
    ...(deleteCustomGroup ? { deleteCustomGroup } : {}),
    ...(setCustomGroupItems ? { setCustomGroupItems } : {}),
    ...(addChannelToCustomGroup ? { addChannelToCustomGroup } : {}),
    ...(removeChannelFromCustomGroup ? { removeChannelFromCustomGroup } : {}),
    ...(createLiveFavoriteFolder ? { createLiveFavoriteFolder } : {}),
    ...(renameLiveFavoriteFolder ? { renameLiveFavoriteFolder } : {}),
    ...(deleteLiveFavoriteFolder ? { deleteLiveFavoriteFolder } : {}),
    ...(assignLiveFavoriteFolder ? { assignLiveFavoriteFolder } : {}),
  };
}

/** Stable memoized wrapper that marks E2EE auto-sync dirty on any catalog mutation (`#510`). */
export function useSyncDirtyCatalog(
  catalog: CatalogService,
  syncAccount?: SyncAccountPort,
): CatalogService {
  const syncRef = useRef(syncAccount);
  syncRef.current = syncAccount;
  const hasSync = syncAccount !== undefined;

  return useMemo(() => {
    if (!hasSync) return catalog;
    return wrapCatalogForSyncDirty(
      catalog,
      () => {
        syncRef.current?.notifySyncDirty?.();
      },
      () => {
        syncRef.current?.markSyncDirty?.();
      },
    );
  }, [catalog, hasSync]);
}

/**
 * Synchronizes active playback state (`setViewingActive`) and pause transitions
 * (`notifyPlaybackPause`) with the automatic background E2EE sync scheduler (`#510`, `[1.44]`).
 */
export function usePlaybackAutoSyncHooks(params: {
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly isViewingActive: boolean;
  readonly hasPlayerTarget: boolean;
}): void {
  const { syncAccount, isViewingActive, hasPlayerTarget } = params;
  const syncRef = useRef(syncAccount);
  syncRef.current = syncAccount;
  const prevViewingRef = useRef(isViewingActive);

  useEffect(() => {
    syncRef.current?.setViewingActive?.(isViewingActive);
    const wasViewing = prevViewingRef.current;
    prevViewingRef.current = isViewingActive;
    if (wasViewing && !isViewingActive && hasPlayerTarget) {
      syncRef.current?.notifyPlaybackPause?.();
    }
  }, [hasPlayerTarget, isViewingActive]);

  useEffect(() => {
    return () => {
      syncRef.current?.setViewingActive?.(false);
    };
  }, []);
}
