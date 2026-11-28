import {
  type ChannelOverrideRecord,
  type ContinueWatchingDismissalRow,
  type CustomGroupRecord,
  customGroupCategoryId,
  DEFAULT_PROFILE_ID,
  type FavoriteRow,
  type ItemRow,
  type LiveFavoriteFolderAssignment,
  type LiveFavoriteFolderRecord,
  type ProfileRecord,
  pinSecretKey,
  type RatingRow,
  type VodCollectionRecord,
  type WatchProgressRow,
} from '@elv/data';
import type { SecretStore } from '@elv/domain';
import {
  createEmptyVaultSnapshot,
  encodeEpisodeBitfield,
  type SyncCollection,
  type SyncContinueWatchingDismissal,
  type SyncCustomGroup,
  type SyncEpisodeBitfield,
  type SyncKeyedFlag,
  type SyncLiveFavoriteFolder,
  type SyncProfileRecord,
  type SyncRatingRecord,
  type SyncWatchProgress,
  VAULT_SCHEMA_VERSION,
  type VaultSnapshot,
} from '@elv/sync';
import {
  type CatalogClientMessage,
  type CatalogRpcMethodCall,
  isCatalogWorkerMessage,
} from '../../shared/catalog-ipc.ts';
import type { CatalogCoordinator } from '../catalog/coordinator.ts';
import {
  applyDesktopMergedSnapshot,
  asArray,
  asParentalSettings,
  type DesktopSnapshotRpcCaller,
} from './desktop-snapshot-apply.ts';
import { exportDesktopSources } from './snapshot-source-helpers.ts';

/** Subset of Electron's `MessagePortMain` used by {@link createDesktopCatalogSnapshotBridge}. */
export interface DesktopCatalogPortLike {
  on(event: 'message', listener: (messageEvent: { readonly data: unknown }) => void): unknown;
  off(event: 'message', listener: (messageEvent: { readonly data: unknown }) => void): unknown;
  postMessage(message: CatalogClientMessage): void;
  start(): void;
  close(): void;
}

/** Dependencies for {@link createDesktopCatalogSnapshotBridge}. */
export interface DesktopCatalogSnapshotDeps {
  readonly getCoordinator: () =>
    | Pick<CatalogCoordinator<DesktopCatalogPortLike>, 'connectClient' | 'disconnectClient'>
    | undefined;
  readonly secretStore: Pick<SecretStore, 'get' | 'set' | 'delete'>;
  readonly clock?: () => number;
  readonly onApplied?: () => void;
}

/** Local vault snapshot export/apply callbacks wired into `createDesktopSyncService`. */
export interface DesktopCatalogSnapshotBridge {
  getLocalSnapshot(): Promise<VaultSnapshot>;
  applyMergedSnapshot(snapshot: VaultSnapshot): Promise<void>;
}

function createPortCaller(port: DesktopCatalogPortLike): {
  call<T>(rpc: CatalogRpcMethodCall): Promise<T>;
  dispose(): void;
} {
  let nextReqId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  const onMessage = (event: { readonly data: unknown }): void => {
    const raw = event.data;
    if (!isCatalogWorkerMessage(raw) || raw.type === 'progress') return;
    const entry = pending.get(raw.reqId);
    if (!entry) return;
    pending.delete(raw.reqId);
    if (raw.type === 'result') {
      entry.resolve(raw.value);
    } else {
      entry.reject(new Error(`catalog worker fault: ${raw.error.category}/${raw.error.code}`));
    }
  };

  port.on('message', onMessage);
  port.start();

  return {
    call<T>(rpc: CatalogRpcMethodCall): Promise<T> {
      const reqId = ++nextReqId;
      return new Promise<T>((resolve, reject) => {
        pending.set(reqId, {
          resolve: (val) => resolve(val as T),
          reject,
        });
        port.postMessage({ type: 'call', reqId, call: rpc });
      });
    },
    dispose(): void {
      port.off('message', onMessage);
      for (const entry of pending.values()) {
        entry.reject(new Error('desktop sync snapshot port disposed'));
      }
      pending.clear();
      port.close();
    },
  };
}

/**
 * Bridges Electron main's `CatalogCoordinator` utility process and encrypted `SecretStore`
 * with `@elv/sync`'s full VaultSnapshot v2 export and merge-apply lifecycle (`#26`, `#510`).
 * Source credentials and profile PIN hashes stay strictly inside `SecretStore` and E2EE vault blobs.
 */
export function createDesktopCatalogSnapshotBridge(
  deps: DesktopCatalogSnapshotDeps,
): DesktopCatalogSnapshotBridge {
  const now = (): number => (deps.clock ? deps.clock() : Date.now());

  const withCatalogPort = async <T>(
    run: (call: DesktopSnapshotRpcCaller) => Promise<T>,
  ): Promise<T | undefined> => {
    const coordinator = deps.getCoordinator();
    if (coordinator === undefined) return undefined;
    const { clientId, rendererPort } = await coordinator.connectClient();
    const caller = createPortCaller(rendererPort);
    try {
      return await run((rpc) => caller.call(rpc));
    } finally {
      caller.dispose();
      coordinator.disconnectClient(clientId);
    }
  };

  return {
    async getLocalSnapshot(): Promise<VaultSnapshot> {
      const result = await withCatalogPort(async (call) => {
        const [sources, profileRows] = await Promise.all([
          exportDesktopSources(call, deps.secretStore),
          call<unknown>({ method: 'listProfiles' })
            .then((r) => asArray<ProfileRecord>(r))
            .catch(() => [] as ProfileRecord[]),
        ]);

        const profiles: SyncProfileRecord[] = [];
        for (const prof of profileRows) {
          const [parentalRaw, pinHash] = await Promise.all([
            call<unknown>({ method: 'getParentalSettings', profileId: prof.id }).catch(() => null),
            deps.secretStore.get(pinSecretKey(prof.id)).catch(() => undefined),
          ]);
          const parental = asParentalSettings(parentalRaw);
          profiles.push({
            id: prof.id,
            name: prof.name,
            avatarToken: prof.avatarToken,
            isKids: prof.isKids,
            isDefault: prof.isDefault,
            updatedAt: Math.max(prof.updatedAt, parental?.updatedAt ?? 0),
            deleted: false,
            pinHash: pinHash ?? null,
            parentalEnabled: parental?.enabled ?? false,
            parentalMaxRating:
              parental?.maxRatingAge !== null && parental?.maxRatingAge !== undefined
                ? String(parental.maxRatingAge)
                : null,
          });
        }

        const profileIds =
          profileRows.length > 0 ? profileRows.map((p) => p.id) : [DEFAULT_PROFILE_ID];

        const favorites: SyncKeyedFlag[] = [];
        const hiddenChannels: SyncKeyedFlag[] = [];
        const customGroups: SyncCustomGroup[] = [];
        const collections: SyncCollection[] = [];
        const watchProgress: SyncWatchProgress[] = [];
        const watchedEpisodesBitfields: SyncEpisodeBitfield[] = [];
        const continueWatchingDismissals: SyncContinueWatchingDismissal[] = [];
        const ratings: SyncRatingRecord[] = [];
        const liveFavoriteFolders: SyncLiveFavoriteFolder[] = [];
        const seenGroupIds = new Set<string>();

        for (const pid of profileIds) {
          const isDefault = pid === DEFAULT_PROFILE_ID;
          const pidOpt = isDefault ? {} : { profileId: pid };
          const [
            favoriteRows,
            allProgressRows,
            overrideRows,
            customGroupRows,
            collectionRows,
            ratingRows,
            dismissalRows,
            liveFolderRows,
            liveFolderAssignments,
          ] = await Promise.all([
            call<unknown>({
              method: 'listFavorites',
              limit: 500,
              ...(isDefault ? {} : { profileId: pid }),
              opts: { includeHidden: true, parentalUnlocked: true },
            })
              .then((r) => asArray<FavoriteRow>(r))
              .catch(() => [] as FavoriteRow[]),
            call<unknown>({
              method: 'listAllWatchProgress',
              ...(isDefault ? {} : { profileId: pid }),
              limit: 2_000,
            })
              .then((r) => asArray<WatchProgressRow>(r))
              .catch(() => [] as WatchProgressRow[]),
            call<unknown>({
              method: 'listChannelOverrides',
              ...(isDefault ? {} : { profileId: pid }),
            })
              .then((r) => asArray<ChannelOverrideRecord>(r))
              .catch(() => [] as ChannelOverrideRecord[]),
            call<unknown>({
              method: 'listCustomGroups',
              ...(isDefault ? {} : { profileId: pid }),
              opts: { includeHidden: true, parentalUnlocked: true },
            })
              .then((r) => asArray<CustomGroupRecord>(r))
              .catch(() => [] as CustomGroupRecord[]),
            call<unknown>({
              method: 'listCollections',
              ...(isDefault ? {} : { profileId: pid }),
              opts: { parentalUnlocked: true },
            })
              .then((r) => asArray<VodCollectionRecord>(r))
              .catch(() => [] as VodCollectionRecord[]),
            call<unknown>({
              method: 'listRatings',
              opts: {
                limit: 250,
                ...(isDefault ? {} : { profileId: pid }),
                parentalUnlocked: true,
              },
            })
              .then((r) => asArray<RatingRow>(r))
              .catch(() => [] as RatingRow[]),
            call<unknown>({
              method: 'listContinueWatchingDismissals',
              profileId: pid,
            })
              .then((r) => asArray<ContinueWatchingDismissalRow>(r))
              .catch(() => [] as ContinueWatchingDismissalRow[]),
            call<unknown>({
              method: 'listLiveFavoriteFolders',
              ...(isDefault ? {} : { profileId: pid }),
              opts: { parentalUnlocked: true },
            })
              .then((r) => asArray<LiveFavoriteFolderRecord>(r))
              .catch(() => [] as LiveFavoriteFolderRecord[]),
            call<unknown>({
              method: 'listLiveFavoriteFolderAssignments',
              ...(isDefault ? {} : { profileId: pid }),
            })
              .then((r) => asArray<LiveFavoriteFolderAssignment>(r))
              .catch(() => [] as LiveFavoriteFolderAssignment[]),
          ]);

          const progressRows =
            allProgressRows.length > 0
              ? allProgressRows
              : await call<unknown>({
                  method: 'listContinueWatching',
                  limit: 200,
                  ...(isDefault ? {} : { profileId: pid }),
                  opts: { parentalUnlocked: true },
                })
                  .then((r) => asArray<WatchProgressRow>(r))
                  .catch(() => [] as WatchProgressRow[]);

          for (const fav of favoriteRows) {
            favorites.push({
              key: fav.itemKey,
              ...(typeof fav.sortOrder === 'number' ? { sortOrder: fav.sortOrder } : {}),
              ...pidOpt,
              updatedAt: fav.addedAt,
            });
          }

          for (const ov of overrideRows) {
            if (!ov.isHidden) continue;
            hiddenChannels.push({ key: ov.itemKey, ...pidOpt, updatedAt: ov.updatedAt });
          }

          for (const group of customGroupRows) {
            if (seenGroupIds.has(group.id)) continue;
            seenGroupIds.add(group.id);
            const items = asArray<ItemRow>(
              await call<unknown>({
                method: 'items',
                categoryId: customGroupCategoryId(group.id),
                offset: 0,
                limit: 500,
                opts: { includeHidden: true, parentalUnlocked: true },
              }).catch(() => []),
            );
            customGroups.push({
              id: group.id,
              name: group.name,
              channelKeys: items.map((item) => item.key),
              sortOrder: group.sortOrder,
              updatedAt: group.updatedAt,
            });
          }

          for (const col of collectionRows) {
            let itemKeys = asArray<string>(
              await call<unknown>({
                method: 'listCollectionRawItemKeys',
                collectionId: col.id,
                ...(isDefault ? {} : { profileId: pid }),
              }).catch(() => []),
            );
            if (itemKeys.length === 0 && (col.itemCount === undefined || col.itemCount > 0)) {
              const items = asArray<ItemRow>(
                await call<unknown>({
                  method: 'listCollectionItems',
                  collectionId: col.id,
                  opts: { parentalUnlocked: true },
                }).catch(() => []),
              );
              itemKeys = items.map((item) => item.key);
            }
            collections.push({
              id: col.id,
              name: col.name,
              itemKeys,
              ...(typeof col.sortOrder === 'number' ? { sortOrder: col.sortOrder } : {}),
              ...pidOpt,
              updatedAt: col.updatedAt,
            });
          }

          const bitfieldBuckets = new Map<
            string,
            { seriesKey: string; season: number; indices: number[]; updatedAt: number }
          >();
          for (const prog of progressRows) {
            if (prog.positionMs <= 0 && !prog.watched) continue;
            watchProgress.push({
              key: prog.itemKey,
              positionMs: prog.positionMs,
              durationMs: prog.durationMs,
              completed: prog.watched,
              ...pidOpt,
              updatedAt: prog.updatedAt,
            });
            if (
              prog.watched &&
              prog.kind === 'episode' &&
              prog.seriesKey !== null &&
              prog.seriesKey.length > 0 &&
              prog.episode !== null &&
              prog.episode >= 0
            ) {
              const season = prog.season !== null && prog.season >= 0 ? prog.season : 0;
              const bKey = `${prog.seriesKey}\u0000${season}`;
              const bucket = bitfieldBuckets.get(bKey);
              if (bucket === undefined) {
                bitfieldBuckets.set(bKey, {
                  seriesKey: prog.seriesKey,
                  season,
                  indices: [prog.episode],
                  updatedAt: prog.updatedAt,
                });
              } else {
                bucket.indices.push(prog.episode);
                if (prog.updatedAt > bucket.updatedAt) bucket.updatedAt = prog.updatedAt;
              }
            }
          }
          for (const bucket of bitfieldBuckets.values()) {
            const bitsB64 = encodeEpisodeBitfield(bucket.indices);
            if (bitsB64.length === 0) continue;
            watchedEpisodesBitfields.push({
              seriesKey: bucket.seriesKey,
              bitsB64,
              season: bucket.season,
              ...pidOpt,
              updatedAt: bucket.updatedAt,
            });
          }

          for (const dis of dismissalRows) {
            continueWatchingDismissals.push({
              profileId: dis.profileId,
              seriesKey: dis.seriesKey,
              sourceId: dis.sourceId,
              dismissedAt: dis.dismissedAt,
              deleted: false,
            });
          }

          for (const row of ratingRows) {
            ratings.push({
              key: row.itemKey,
              sourceId: row.sourceId,
              kind: row.kind,
              value: row.value,
              title: row.title,
              ...(row.logo !== null ? { logo: row.logo } : {}),
              ...(row.year !== null ? { year: row.year } : {}),
              ...(row.rating !== null ? { rating: row.rating } : {}),
              ...pidOpt,
              updatedAt: row.updatedAt,
            });
          }

          if (liveFolderRows.length > 0) {
            const keysByFolder = new Map<string, string[]>();
            for (const a of liveFolderAssignments) {
              const bucket = keysByFolder.get(a.folderId);
              if (bucket === undefined) keysByFolder.set(a.folderId, [a.itemKey]);
              else bucket.push(a.itemKey);
            }
            for (const folder of liveFolderRows) {
              liveFavoriteFolders.push({
                id: folder.id,
                name: folder.name,
                channelKeys: keysByFolder.get(folder.id) ?? [],
                sortOrder: folder.sortOrder,
                ...pidOpt,
                updatedAt: folder.updatedAt,
              });
            }
          }
        }

        return {
          schemaVersion: VAULT_SCHEMA_VERSION,
          updatedAt: now(),
          sources,
          favorites,
          hiddenChannels,
          pinnedChannels: [],
          customGroups,
          collections,
          watchProgress,
          watchedEpisodesBitfields,
          ...(continueWatchingDismissals.length > 0 ? { continueWatchingDismissals } : {}),
          ...(ratings.length > 0 ? { ratings } : {}),
          ...(profiles.length > 0 ? { profiles } : {}),
          ...(liveFavoriteFolders.length > 0 ? { liveFavoriteFolders } : {}),
        } satisfies VaultSnapshot;
      });

      return result ?? createEmptyVaultSnapshot(now());
    },

    async applyMergedSnapshot(snapshot: VaultSnapshot): Promise<void> {
      const changed = await withCatalogPort((call) =>
        applyDesktopMergedSnapshot(snapshot, call, deps.secretStore),
      );
      if (changed === true) {
        deps.onApplied?.();
      }
    },
  };
}
