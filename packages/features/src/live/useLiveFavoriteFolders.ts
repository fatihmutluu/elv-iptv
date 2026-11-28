import type { CatalogService, ItemRow, LiveFavoriteFolderRecord } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PagedListSource, useCatalogUiCache } from '../shared';
import { createStaticPagedListSource } from './live-model';

/** Active filter selected in {@link LiveFavoriteFolderStrip}: `'all'`, `'unfiled'`, or a folder ID. */
export type LiveFavoriteFolderFilter = 'all' | 'unfiled' | (string & {});

/** Options for {@link useLiveFavoriteFolders}. */
export interface UseLiveFavoriteFoldersOptions {
  readonly catalog: CatalogService;
  readonly favoriteChannels: readonly ItemRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly hasReadySources?: boolean;
  readonly onFavoritesMutated?: () => void;
}

/** Reactive Live TV favorite folder state and optimistic CRUD actions (`Wave Q7-B`, `F-11`). */
export interface LiveFavoriteFoldersState {
  readonly supported: boolean;
  readonly folders: readonly LiveFavoriteFolderRecord[];
  readonly assignmentByItemKey: ReadonlyMap<string, string>;
  readonly activeFolderFilter: LiveFavoriteFolderFilter;
  readonly setActiveFolderFilter: (next: LiveFavoriteFolderFilter) => void;
  readonly filteredFavoriteChannels: readonly ItemRow[];
  readonly filteredFavoriteSource: PagedListSource<ItemRow>;
  readonly filteredVersion: number;
  readonly createFolder: (name: string) => Promise<LiveFavoriteFolderRecord | null>;
  readonly renameFolder: (id: string, name: string) => Promise<boolean>;
  readonly deleteFolder: (id: string) => Promise<boolean>;
  readonly moveChannelToFolder: (channel: ItemRow, folderId: string | null) => Promise<boolean>;
}

const EMPTY_FOLDERS: readonly LiveFavoriteFolderRecord[] = [];
const EMPTY_ASSIGNMENTS: ReadonlyMap<string, string> = new Map();

function countFolderItems(
  folders: readonly LiveFavoriteFolderRecord[],
  assignments: ReadonlyMap<string, string>,
  favoriteChannels: readonly ItemRow[],
): readonly LiveFavoriteFolderRecord[] {
  const liveKeys = new Set(favoriteChannels.map((c) => c.key));
  const counts = new Map<string, number>();
  for (const [itemKey, folderId] of assignments) {
    if (liveKeys.has(itemKey)) {
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
  }
  return folders.map((f) => ({ ...f, itemCount: counts.get(f.id) ?? 0 }));
}

/**
 * Loads cross-source Live TV favorite folders & channel assignments with zero-blink `CatalogUiCache`
 * hydration, folder filtering (`'all' | 'unfiled' | folderId`), and optimistic CRUD + rollback.
 */
export function useLiveFavoriteFolders(
  opts: UseLiveFavoriteFoldersOptions,
): LiveFavoriteFoldersState {
  const {
    catalog,
    favoriteChannels,
    refreshToken,
    userStateVersion = 0,
    hasReadySources = true,
    onFavoritesMutated,
  } = opts;
  const uiCache = useCatalogUiCache();
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;
  const onFavoritesMutatedRef = useRef(onFavoritesMutated);
  onFavoritesMutatedRef.current = onFavoritesMutated;

  const supported =
    catalog.listLiveFavoriteFolders !== undefined && catalog.assignLiveFavoriteFolder !== undefined;

  const cachedLive = hasReadySources ? (uiCache?.getLive() ?? null) : null;
  const [folders, setFolders] = useState<readonly LiveFavoriteFolderRecord[]>(
    () => cachedLive?.favoriteFolders ?? EMPTY_FOLDERS,
  );
  const [assignmentByItemKey, setAssignmentByItemKey] = useState<ReadonlyMap<string, string>>(
    () => cachedLive?.favoriteFolderAssignments ?? EMPTY_ASSIGNMENTS,
  );
  const [activeFolderFilter, setActiveFolderFilterState] =
    useState<LiveFavoriteFolderFilter>('all');
  const activeFolderFilterRef = useRef<LiveFavoriteFolderFilter>(activeFolderFilter);
  activeFolderFilterRef.current = activeFolderFilter;
  const setActiveFolderFilter = useCallback((next: LiveFavoriteFolderFilter) => {
    activeFolderFilterRef.current = next;
    setActiveFolderFilterState(next);
  }, []);
  const [version, setVersion] = useState(0);

  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const assignmentsRef = useRef(assignmentByItemKey);
  assignmentsRef.current = assignmentByItemKey;
  const favoriteChannelsRef = useRef(favoriteChannels);
  favoriteChannelsRef.current = favoriteChannels;
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const commitState = useCallback(
    (
      nextFolders: readonly LiveFavoriteFolderRecord[],
      nextAssignments: ReadonlyMap<string, string>,
    ) => {
      foldersRef.current = nextFolders;
      assignmentsRef.current = nextAssignments;
      setFolders(nextFolders);
      setAssignmentByItemKey(nextAssignments);
      setVersion((v) => v + 1);
      uiCacheRef.current?.setLiveFavoriteFolders?.(nextFolders, nextAssignments);
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion reload folders
  useEffect(() => {
    let active = true;
    if (!hasReadySources || !supported) {
      if (!hasReadySources) {
        commitState(EMPTY_FOLDERS, EMPTY_ASSIGNMENTS);
      }
      return undefined;
    }

    const listFolders = catalog.listLiveFavoriteFolders;
    const listAssignments = catalog.listLiveFavoriteFolderAssignments;
    if (!listFolders || !listAssignments) return undefined;

    void Promise.all([listFolders().catch(() => null), listAssignments().catch(() => null)]).then(
      ([rawFolders, rawAssignments]) => {
        if (!active || !aliveRef.current) return;
        if (rawFolders === null && rawAssignments === null) return;
        const nextFolders = rawFolders ?? foldersRef.current;
        const nextAssignments =
          rawAssignments !== null
            ? new Map(rawAssignments.map((a) => [a.itemKey, a.folderId]))
            : assignmentsRef.current;
        commitState(nextFolders, nextAssignments);
      },
    );

    return () => {
      active = false;
    };
  }, [catalog, commitState, hasReadySources, refreshToken, supported, userStateVersion]);

  useEffect(() => {
    if (activeFolderFilter === 'all' || activeFolderFilter === 'unfiled') return;
    if (!folders.some((f) => f.id === activeFolderFilter)) {
      setActiveFolderFilter('all');
    }
  }, [activeFolderFilter, folders, setActiveFolderFilter]);

  const filteredFavoriteChannels = useMemo<readonly ItemRow[]>(() => {
    if (activeFolderFilter === 'all') return favoriteChannels;
    if (activeFolderFilter === 'unfiled') {
      return favoriteChannels.filter((ch) => !assignmentByItemKey.has(ch.key));
    }
    return favoriteChannels.filter((ch) => assignmentByItemKey.get(ch.key) === activeFolderFilter);
  }, [activeFolderFilter, assignmentByItemKey, favoriteChannels]);

  const filteredFavoriteSource = useMemo(
    () => createStaticPagedListSource(filteredFavoriteChannels),
    [filteredFavoriteChannels],
  );

  const createFolder = useCallback(
    async (name: string): Promise<LiveFavoriteFolderRecord | null> => {
      if (!catalog.createLiveFavoriteFolder) return null;
      const trimmed = name.trim();
      if (trimmed.length === 0) return null;
      const res = await catalog.createLiveFavoriteFolder({ name: trimmed }).catch(() => null);
      if (!aliveRef.current || res === null || !res.ok) return null;
      const nextFolders = [...foldersRef.current, res.value];
      commitState(nextFolders, assignmentsRef.current);
      return res.value;
    },
    [catalog, commitState],
  );

  const renameFolder = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      if (!catalog.renameLiveFavoriteFolder) return false;
      const trimmed = name.trim();
      if (trimmed.length === 0) return false;
      const prevFolder = foldersRef.current.find((f) => f.id === id);
      const optimistic = foldersRef.current.map((f) => (f.id === id ? { ...f, name: trimmed } : f));
      commitState(optimistic, assignmentsRef.current);

      const res = await catalog.renameLiveFavoriteFolder(id, trimmed).catch(() => null);
      if (!aliveRef.current) return false;
      if (res === null || !res.ok) {
        if (prevFolder !== undefined) {
          commitState(
            foldersRef.current.map((f) =>
              f.id === id && f.name === trimmed ? { ...f, name: prevFolder.name } : f,
            ),
            assignmentsRef.current,
          );
        }
        return false;
      }
      commitState(
        foldersRef.current.map((f) => (f.id === id ? res.value : f)),
        assignmentsRef.current,
      );
      return true;
    },
    [catalog, commitState],
  );

  const deleteFolder = useCallback(
    async (id: string): Promise<boolean> => {
      if (!catalog.deleteLiveFavoriteFolder) return false;
      const deletedFolder = foldersRef.current.find((f) => f.id === id);
      const deletedAssignments: Array<readonly [string, string]> = [];
      const nextAssignments = new Map<string, string>();
      for (const [k, fid] of assignmentsRef.current) {
        if (fid === id) deletedAssignments.push([k, fid]);
        else nextAssignments.set(k, fid);
      }
      const prevFilter = activeFolderFilterRef.current;
      const resetFilter = prevFilter === id;
      commitState(
        foldersRef.current.filter((f) => f.id !== id),
        nextAssignments,
      );
      if (resetFilter) setActiveFolderFilter('all');

      const res = await catalog.deleteLiveFavoriteFolder(id).catch(() => null);
      if (!aliveRef.current) return false;
      if (res === null || !res.ok) {
        const restoredAssignments = new Map(assignmentsRef.current);
        for (const [k, fid] of deletedAssignments) {
          if (!restoredAssignments.has(k)) restoredAssignments.set(k, fid);
        }
        const curFolders = foldersRef.current;
        const withRestored =
          deletedFolder !== undefined && !curFolders.some((f) => f.id === id)
            ? [...curFolders, deletedFolder].sort(
                (a, b) =>
                  a.sortOrder - b.sortOrder ||
                  a.createdAt - b.createdAt ||
                  a.id.localeCompare(b.id),
              )
            : curFolders;
        commitState(
          countFolderItems(withRestored, restoredAssignments, favoriteChannelsRef.current),
          restoredAssignments,
        );
        if (resetFilter && activeFolderFilterRef.current === 'all') {
          setActiveFolderFilter(prevFilter);
        }
        return false;
      }
      return true;
    },
    [catalog, commitState, setActiveFolderFilter],
  );

  const moveChannelToFolder = useCallback(
    async (channel: ItemRow, folderId: string | null): Promise<boolean> => {
      if (!catalog.assignLiveFavoriteFolder) return false;
      const prevAssignedFolderId = assignmentsRef.current.get(channel.key);
      const nextAssignments = new Map(assignmentsRef.current);
      if (folderId === null) nextAssignments.delete(channel.key);
      else nextAssignments.set(channel.key, folderId);

      const nextFolders = countFolderItems(
        foldersRef.current,
        nextAssignments,
        favoriteChannelsRef.current,
      );
      commitState(nextFolders, nextAssignments);

      const res = await catalog
        .assignLiveFavoriteFolder({
          itemKey: channel.key,
          sourceId: channel.sourceId,
          folderId,
          title: channel.name,
          logo: channel.logo,
        })
        .catch(() => null);
      if (!aliveRef.current) return false;
      if (res === null || !res.ok) {
        const expectedOptimistic = folderId ?? undefined;
        if (assignmentsRef.current.get(channel.key) === expectedOptimistic) {
          const revertedAssignments = new Map(assignmentsRef.current);
          if (prevAssignedFolderId === undefined) revertedAssignments.delete(channel.key);
          else revertedAssignments.set(channel.key, prevAssignedFolderId);
          commitState(
            countFolderItems(foldersRef.current, revertedAssignments, favoriteChannelsRef.current),
            revertedAssignments,
          );
        }
        return false;
      }
      onFavoritesMutatedRef.current?.();
      return true;
    },
    [catalog, commitState],
  );

  return {
    supported,
    folders,
    assignmentByItemKey,
    activeFolderFilter,
    setActiveFolderFilter,
    filteredFavoriteChannels,
    filteredFavoriteSource,
    filteredVersion: version,
    createFolder,
    renameFolder,
    deleteFolder,
    moveChannelToFolder,
  };
}
