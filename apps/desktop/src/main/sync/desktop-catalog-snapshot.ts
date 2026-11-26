import {
  type ChannelOverrideRecord,
  type CustomGroupRecord,
  customGroupCategoryId,
  type FavoriteRow,
  type ItemDetailRow,
  type ItemRow,
  type RatingRow,
  type RatingValue,
  type SourceRow,
  secretKey,
  sourceOfKey,
  type UserItemKind,
  type VodCollectionRecord,
  type WatchProgressRow,
} from '@elv/data';
import type { Result, SecretStore } from '@elv/domain';
import {
  createEmptyVaultSnapshot,
  type SyncCollection,
  type SyncCustomGroup,
  type SyncKeyedFlag,
  type SyncRatingRecord,
  type SyncSourceRecord,
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

interface ParsedXtreamSecret {
  readonly server: string;
  readonly username: string;
  readonly password: string;
}

function parseXtreamSecret(raw: string | undefined): ParsedXtreamSecret | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (
      typeof rec.server !== 'string' ||
      rec.server.trim().length === 0 ||
      typeof rec.username !== 'string' ||
      rec.username.trim().length === 0 ||
      typeof rec.password !== 'string' ||
      rec.password.trim().length === 0
    ) {
      return null;
    }
    return {
      server: rec.server.trim(),
      username: rec.username.trim(),
      password: rec.password,
    };
  } catch {
    return null;
  }
}

function parseGuideUrlFromUrlVars(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
    const val = (obj as Record<string, unknown>)['g:url'];
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  } catch {
    return undefined;
  }
}

function sourceFingerprint(kind: 'm3u' | 'xtream', url: string, username?: string): string {
  const normalizedUrl = url.trim().replace(/\/+$/, '').toLowerCase();
  return kind === 'xtream'
    ? `xtream|${normalizedUrl}|${(username ?? '').trim().toLowerCase()}`
    : `m3u|${normalizedUrl}`;
}

function inferItemKind(itemKey: string): UserItemKind {
  const segment = itemKey.split(':')[2];
  if (segment === 'movie' || segment === 'series' || segment === 'episode' || segment === 'live') {
    return segment;
  }
  return 'live';
}

function inferVodKind(itemKey: string): 'movie' | 'series' | undefined {
  const segment = itemKey.split(':')[2];
  if (segment === 'movie' || segment === 'series') return segment;
  return undefined;
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
 * with `@elv/sync`'s {@link VaultSnapshot} export and merge-apply lifecycle (`#26`).
 * Source credentials are read from and written strictly through `SecretStore`; credentials never enter SQLite.
 */
export function createDesktopCatalogSnapshotBridge(
  deps: DesktopCatalogSnapshotDeps,
): DesktopCatalogSnapshotBridge {
  const now = (): number => (deps.clock ? deps.clock() : Date.now());

  const withCatalogPort = async <T>(
    run: (call: <R>(rpc: CatalogRpcMethodCall) => Promise<R>) => Promise<T>,
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
        const [
          sourceRows,
          favoriteRows,
          progressRows,
          overrideRows,
          customGroupRows,
          collectionRows,
          ratingRows,
        ] = await Promise.all([
          call<SourceRow[]>({ method: 'listSources' }).catch(() => [] as SourceRow[]),
          call<FavoriteRow[]>({
            method: 'listFavorites',
            limit: 500,
            opts: { includeHidden: true, parentalUnlocked: true },
          }).catch(() => [] as FavoriteRow[]),
          call<WatchProgressRow[]>({
            method: 'listContinueWatching',
            limit: 200,
            opts: { parentalUnlocked: true },
          }).catch(() => [] as WatchProgressRow[]),
          call<ChannelOverrideRecord[]>({ method: 'listChannelOverrides' }).catch(
            () => [] as ChannelOverrideRecord[],
          ),
          call<CustomGroupRecord[]>({
            method: 'listCustomGroups',
            opts: { includeHidden: true, parentalUnlocked: true },
          }).catch(() => [] as CustomGroupRecord[]),
          call<VodCollectionRecord[]>({
            method: 'listCollections',
            opts: { parentalUnlocked: true },
          }).catch(() => [] as VodCollectionRecord[]),
          call<RatingRow[]>({
            method: 'listRatings',
            opts: { limit: 250, parentalUnlocked: true },
          }).catch(() => [] as RatingRow[]),
        ]);

        const sources: SyncSourceRecord[] = [];
        for (const row of sourceRows) {
          const rawUrlVars = await deps.secretStore
            .get(secretKey(row.id, 'urlvars'))
            .catch(() => undefined);
          const epgUrl = parseGuideUrlFromUrlVars(rawUrlVars);

          if (row.kind === 'xtream') {
            const parsed = parseXtreamSecret(
              await deps.secretStore.get(secretKey(row.id, 'xtream')).catch(() => undefined),
            );
            if (parsed !== null) {
              sources.push({
                id: row.id,
                kind: 'xtream',
                name: row.name,
                url: parsed.server,
                username: parsed.username,
                password: parsed.password,
                ...(epgUrl !== undefined ? { epgUrl } : {}),
                updatedAt: row.createdAt,
              });
            }
          } else if (row.kind === 'm3u' && row.isLocalPlaylist !== true) {
            const rawPlaylist = await deps.secretStore
              .get(secretKey(row.id, 'playlist'))
              .catch(() => undefined);
            const playlistUrl = rawPlaylist?.trim() ?? '';
            if (playlistUrl.length > 0) {
              sources.push({
                id: row.id,
                kind: 'm3u',
                name: row.name,
                url: playlistUrl,
                ...(epgUrl !== undefined ? { epgUrl } : {}),
                updatedAt: row.createdAt,
              });
            }
          }
        }

        const favorites: SyncKeyedFlag[] = favoriteRows.map((fav) => ({
          key: fav.itemKey,
          updatedAt: fav.addedAt,
        }));

        const hiddenChannels: SyncKeyedFlag[] = overrideRows
          .filter((ov) => ov.isHidden)
          .map((ov) => ({
            key: ov.itemKey,
            updatedAt: ov.updatedAt,
          }));

        const customGroups: SyncCustomGroup[] = [];
        for (const group of customGroupRows) {
          const items = await call<ItemRow[]>({
            method: 'items',
            categoryId: customGroupCategoryId(group.id),
            offset: 0,
            limit: 500,
            opts: { includeHidden: true, parentalUnlocked: true },
          }).catch(() => [] as ItemRow[]);
          customGroups.push({
            id: group.id,
            name: group.name,
            channelKeys: items.map((item) => item.key),
            sortOrder: group.sortOrder,
            updatedAt: group.updatedAt,
          });
        }

        const collections: SyncCollection[] = [];
        for (const col of collectionRows) {
          const items = await call<ItemRow[]>({
            method: 'listCollectionItems',
            collectionId: col.id,
            opts: { parentalUnlocked: true },
          }).catch(() => [] as ItemRow[]);
          collections.push({
            id: col.id,
            name: col.name,
            itemKeys: items.map((item) => item.key),
            updatedAt: col.updatedAt,
          });
        }

        const watchProgress: SyncWatchProgress[] = progressRows
          .filter((prog) => prog.positionMs > 0 || prog.watched)
          .map((prog) => ({
            key: prog.itemKey,
            positionMs: prog.positionMs,
            durationMs: prog.durationMs,
            completed: prog.watched,
            updatedAt: prog.updatedAt,
          }));

        const ratings: SyncRatingRecord[] = ratingRows.map((row) => ({
          key: row.itemKey,
          sourceId: row.sourceId,
          kind: row.kind,
          value: row.value,
          title: row.title,
          ...(row.logo !== null ? { logo: row.logo } : {}),
          ...(row.year !== null ? { year: row.year } : {}),
          ...(row.rating !== null ? { rating: row.rating } : {}),
          updatedAt: row.updatedAt,
        }));

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
          watchedEpisodesBitfields: [],
          ...(ratings.length > 0 ? { ratings } : {}),
        } satisfies VaultSnapshot;
      });

      return result ?? createEmptyVaultSnapshot(now());
    },

    async applyMergedSnapshot(snapshot: VaultSnapshot): Promise<void> {
      const changed = await withCatalogPort(async (call) => {
        let mutated = false;

        // 1. Sources (credentials written strictly through SecretStore via addSource)
        const existingSources = await call<SourceRow[]>({ method: 'listSources' }).catch(
          () => [] as SourceRow[],
        );
        const existingById = new Map(existingSources.map((s) => [s.id, s]));
        const existingFingerprints = new Set<string>();
        for (const s of existingSources) {
          if (s.kind === 'xtream') {
            const parsed = parseXtreamSecret(
              await deps.secretStore.get(secretKey(s.id, 'xtream')).catch(() => undefined),
            );
            if (parsed !== null) {
              existingFingerprints.add(sourceFingerprint('xtream', parsed.server, parsed.username));
            }
          } else if (s.kind === 'm3u' && s.isLocalPlaylist !== true) {
            const url = await deps.secretStore
              .get(secretKey(s.id, 'playlist'))
              .catch(() => undefined);
            if (url && url.trim().length > 0) {
              existingFingerprints.add(sourceFingerprint('m3u', url));
            }
          }
        }

        for (const src of snapshot.sources) {
          if (src.deleted === true) {
            if (existingById.has(src.id)) {
              const removed = await call<Result<void>>({
                method: 'removeSource',
                id: src.id,
              }).catch(() => null);
              if (removed?.ok) {
                existingById.delete(src.id);
                mutated = true;
              }
            }
            continue;
          }
          const fp = sourceFingerprint(src.kind, src.url, src.username);
          if (existingById.has(src.id) || existingFingerprints.has(fp)) continue;

          if (
            src.kind === 'xtream' &&
            src.url.trim().length > 0 &&
            typeof src.username === 'string' &&
            src.username.trim().length > 0 &&
            typeof src.password === 'string' &&
            src.password.trim().length > 0
          ) {
            const added = await call<Result<SourceRow>>({
              method: 'addSource',
              input: {
                kind: 'xtream',
                name: src.name,
                server: src.url,
                username: src.username,
                password: src.password,
                ...(src.epgUrl ? { guideUrl: src.epgUrl } : {}),
              },
            }).catch(() => null);
            if (added?.ok) {
              existingFingerprints.add(fp);
              mutated = true;
            }
          } else if (src.kind === 'm3u' && src.url.trim().length > 0) {
            const added = await call<Result<SourceRow>>({
              method: 'addSource',
              input: {
                kind: 'm3u',
                name: src.name,
                playlistUrl: src.url,
                ...(src.epgUrl ? { guideUrl: src.epgUrl } : {}),
              },
            }).catch(() => null);
            if (added?.ok) {
              existingFingerprints.add(fp);
              mutated = true;
            }
          }
        }

        // 2. Favorites
        const existingFavKeys = new Set(
          await call<string[]>({ method: 'listFavoriteKeys' }).catch(() => [] as string[]),
        );
        for (const fav of snapshot.favorites) {
          if (fav.deleted === true) {
            if (existingFavKeys.has(fav.key)) {
              const res = await call<Result<boolean>>({
                method: 'setFavorite',
                input: {
                  sourceId: sourceOfKey(fav.key) ?? 'sync',
                  itemKey: fav.key,
                  kind: inferItemKind(fav.key),
                  title: fav.key,
                },
                active: false,
              }).catch(() => null);
              if (res?.ok) {
                existingFavKeys.delete(fav.key);
                mutated = true;
              }
            }
            continue;
          }
          if (existingFavKeys.has(fav.key)) continue;
          const detail = await call<ItemDetailRow | null>({
            method: 'itemDetail',
            itemKey: fav.key,
            opts: { parentalUnlocked: true },
          }).catch(() => null);
          const sourceId = detail?.sourceId ?? sourceOfKey(fav.key);
          if (sourceId === undefined) continue;
          const res = await call<Result<boolean>>({
            method: 'setFavorite',
            input: {
              sourceId,
              itemKey: fav.key,
              kind: detail?.kind ?? inferItemKind(fav.key),
              title: detail?.name ?? fav.key,
              logo: detail?.logo ?? null,
              year: detail?.year ?? null,
              rating: detail?.rating ?? null,
            },
            active: true,
          }).catch(() => null);
          if (res?.ok) {
            existingFavKeys.add(fav.key);
            mutated = true;
          }
        }

        // 3. Hidden channels
        const existingOverrides = await call<ChannelOverrideRecord[]>({
          method: 'listChannelOverrides',
        }).catch(() => [] as ChannelOverrideRecord[]);
        const overrideByKey = new Map(existingOverrides.map((ov) => [ov.itemKey, ov]));
        for (const hidden of snapshot.hiddenChannels) {
          const existing = overrideByKey.get(hidden.key);
          const sourceId = existing?.sourceId ?? sourceOfKey(hidden.key);
          if (sourceId === undefined) continue;
          if (hidden.deleted === true) {
            if (existing?.isHidden) {
              const res = await call<Result<ChannelOverrideRecord>>({
                method: 'setChannelOverride',
                input: { itemKey: hidden.key, sourceId, isHidden: false },
              }).catch(() => null);
              if (res?.ok) mutated = true;
            }
          } else if (!existing?.isHidden) {
            const res = await call<Result<ChannelOverrideRecord>>({
              method: 'setChannelOverride',
              input: { itemKey: hidden.key, sourceId, isHidden: true },
            }).catch(() => null);
            if (res?.ok) mutated = true;
          }
        }

        // 4. Custom groups
        if (snapshot.customGroups.length > 0) {
          const existingGroups = await call<CustomGroupRecord[]>({
            method: 'listCustomGroups',
            opts: { includeHidden: true, parentalUnlocked: true },
          }).catch(() => [] as CustomGroupRecord[]);
          const groupById = new Map(existingGroups.map((g) => [g.id, g]));
          const groupByName = new Map(existingGroups.map((g) => [g.name.toLowerCase(), g]));
          for (const grp of snapshot.customGroups) {
            const existing = groupById.get(grp.id) ?? groupByName.get(grp.name.toLowerCase());
            if (grp.deleted === true) {
              if (existing !== undefined) {
                const res = await call<Result<void>>({
                  method: 'deleteCustomGroup',
                  groupId: existing.id,
                }).catch(() => null);
                if (res?.ok) mutated = true;
              }
              continue;
            }
            let targetGroupId = existing?.id;
            if (existing === undefined) {
              const created = await call<Result<CustomGroupRecord>>({
                method: 'createCustomGroup',
                input: { name: grp.name, sortOrder: grp.sortOrder },
              }).catch(() => null);
              if (created?.ok) {
                targetGroupId = created.value.id;
                mutated = true;
              }
            } else if (
              (existing.name !== grp.name || existing.sortOrder !== grp.sortOrder) &&
              grp.updatedAt > existing.updatedAt
            ) {
              const updated = await call<Result<CustomGroupRecord>>({
                method: 'updateCustomGroup',
                groupId: existing.id,
                patch: { name: grp.name, sortOrder: grp.sortOrder },
              }).catch(() => null);
              if (updated?.ok) mutated = true;
            }
            if (targetGroupId !== undefined && grp.channelKeys.length > 0) {
              const items = grp.channelKeys
                .map((itemKey) => {
                  const sid = sourceOfKey(itemKey);
                  return sid !== undefined ? { itemKey, sourceId: sid } : null;
                })
                .filter((item): item is { itemKey: string; sourceId: string } => item !== null);
              if (items.length > 0) {
                const res = await call<Result<void>>({
                  method: 'setCustomGroupItems',
                  groupId: targetGroupId,
                  items,
                }).catch(() => null);
                if (res?.ok) mutated = true;
              }
            }
          }
        }

        // 5. VOD collections
        if (snapshot.collections.length > 0) {
          const existingCols = await call<VodCollectionRecord[]>({
            method: 'listCollections',
            opts: { parentalUnlocked: true },
          }).catch(() => [] as VodCollectionRecord[]);
          const colById = new Map(existingCols.map((c) => [c.id, c]));
          const colByName = new Map(existingCols.map((c) => [c.name.toLowerCase(), c]));
          for (const col of snapshot.collections) {
            const existing = colById.get(col.id) ?? colByName.get(col.name.toLowerCase());
            if (col.deleted === true) {
              if (existing !== undefined) {
                const res = await call<Result<void>>({
                  method: 'deleteCollection',
                  id: existing.id,
                }).catch(() => null);
                if (res?.ok) mutated = true;
              }
              continue;
            }
            let targetColId = existing?.id;
            if (existing === undefined) {
              const created = await call<Result<VodCollectionRecord>>({
                method: 'createCollection',
                input: { id: col.id, name: col.name },
              }).catch(() => null);
              if (created?.ok) {
                targetColId = created.value.id;
                mutated = true;
              }
            } else if (existing.name !== col.name && col.updatedAt > existing.updatedAt) {
              const renamed = await call<Result<VodCollectionRecord>>({
                method: 'renameCollection',
                id: existing.id,
                name: col.name,
              }).catch(() => null);
              if (renamed?.ok) mutated = true;
            }
            if (targetColId !== undefined && col.itemKeys.length > 0) {
              for (const itemKey of col.itemKeys) {
                if (sourceOfKey(itemKey) === undefined) continue;
                const detail = await call<ItemDetailRow | null>({
                  method: 'itemDetail',
                  itemKey,
                  opts: { parentalUnlocked: true },
                }).catch(() => null);
                const kind =
                  detail?.kind === 'movie' || detail?.kind === 'series'
                    ? detail.kind
                    : inferVodKind(itemKey);
                if (kind === undefined) continue;
                const res = await call<Result<void>>({
                  method: 'addItemToCollection',
                  collectionId: targetColId,
                  itemKey,
                  kind,
                }).catch(() => null);
                if (res?.ok) mutated = true;
              }
            }
          }
        }

        // 6. Watch progress (LWW)
        for (const prog of snapshot.watchProgress) {
          if (prog.deleted === true) {
            const cleared = await call<Result<void>>({
              method: 'clearProgress',
              itemKey: prog.key,
            }).catch(() => null);
            if (cleared?.ok) mutated = true;
            continue;
          }
          const existing = await call<WatchProgressRow | null>({
            method: 'getProgress',
            itemKey: prog.key,
          }).catch(() => null);
          if (existing !== null && prog.updatedAt <= existing.updatedAt) continue;
          const detail =
            existing !== null
              ? null
              : await call<ItemDetailRow | null>({
                  method: 'itemDetail',
                  itemKey: prog.key,
                  opts: { parentalUnlocked: true },
                }).catch(() => null);
          const sourceId = existing?.sourceId ?? detail?.sourceId ?? sourceOfKey(prog.key);
          if (sourceId === undefined) continue;
          const res = await call<Result<WatchProgressRow>>({
            method: 'saveProgress',
            input: {
              sourceId,
              itemKey: prog.key,
              kind: existing?.kind ?? detail?.kind ?? inferItemKind(prog.key),
              title: existing?.title ?? detail?.name ?? prog.key,
              subtitle: existing?.subtitle ?? null,
              logo: existing?.logo ?? detail?.logo ?? null,
              seriesKey: existing?.seriesKey ?? null,
              season: existing?.season ?? null,
              episode: existing?.episode ?? null,
              positionMs: prog.positionMs,
              durationMs: prog.durationMs,
              watched: prog.completed,
            },
          }).catch(() => null);
          if (res?.ok) mutated = true;
        }

        // 7. Ratings (Movies & Series Like/Dislike, LWW + tombstones)
        if (snapshot.ratings !== undefined && snapshot.ratings.length > 0) {
          const existingRatings = await call<RatingRow[]>({
            method: 'listRatings',
            opts: { limit: 250, parentalUnlocked: true },
          }).catch(() => [] as RatingRow[]);
          const existingByKey = new Map(existingRatings.map((r) => [r.itemKey, r]));
          for (const rec of snapshot.ratings) {
            const existing = existingByKey.get(rec.key);
            if (rec.deleted === true) {
              if (existing !== undefined && rec.updatedAt >= existing.updatedAt) {
                const cleared = await call<Result<RatingValue | null>>({
                  method: 'setRating',
                  input: {
                    sourceId: existing.sourceId,
                    itemKey: existing.itemKey,
                    kind: existing.kind,
                    title: existing.title,
                  },
                  value: null,
                }).catch(() => null);
                if (cleared?.ok) mutated = true;
              }
              continue;
            }
            if (existing !== undefined && rec.updatedAt <= existing.updatedAt) continue;
            const res = await call<Result<RatingValue | null>>({
              method: 'setRating',
              input: {
                sourceId: rec.sourceId,
                itemKey: rec.key,
                kind: rec.kind,
                title: rec.title,
                logo: rec.logo ?? null,
                year: rec.year ?? null,
                rating: rec.rating ?? null,
              },
              value: rec.value,
            }).catch(() => null);
            if (res?.ok) mutated = true;
          }
        }

        if (mutated) {
          await call<void>({ method: 'flushPendingWrites' }).catch(() => undefined);
        }
        return mutated;
      });

      if (changed === true) {
        deps.onApplied?.();
      }
    },
  };
}
