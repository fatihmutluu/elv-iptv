import {
  type CatalogService,
  customGroupCategoryId,
  DEFAULT_PROFILE_ID,
  pinSecretKey,
} from '@elv/data';
import type { SecretStore } from '@elv/domain';
import {
  encodeEpisodeBitfield,
  type SyncCollection,
  type SyncContinueWatchingDismissal,
  type SyncCustomGroup,
  type SyncEpisodeBitfield,
  type SyncKeyedFlag,
  type SyncProfileRecord,
  type SyncRatingRecord,
  type SyncWatchProgress,
  VAULT_SCHEMA_VERSION,
  type VaultSnapshot,
} from '@elv/sync';
import { applyMobileMergedSnapshot } from './mobile-snapshot-apply';
import { exportMobileSources } from './snapshot-source-helpers';

/** Dependencies for {@link createTvMobileCatalogSnapshotBridge}. */
export interface TvMobileCatalogSnapshotDeps {
  readonly getCatalog: () => Promise<CatalogService>;
  readonly secretStore: Pick<SecretStore, 'get' | 'set' | 'delete'>;
  readonly clock?: () => number;
  readonly onApplied?: () => void;
}

/** Local vault snapshot export/apply callbacks wired into `createTvMobileSyncPorts`. */
export interface TvMobileCatalogSnapshotBridge {
  getLocalSnapshot(): Promise<VaultSnapshot>;
  applyMergedSnapshot(snapshot: VaultSnapshot): Promise<void>;
}

/**
 * Bridges `tv-mobile`'s local SQLite {@link CatalogService} and encrypted {@link SecretStore}
 * with `@elv/sync`'s full VaultSnapshot v2 export and merge-apply lifecycle (`#26`, `#510`).
 * Source credentials and profile PIN hashes stay strictly inside `SecretStore` and E2EE vault blobs.
 */
export function createTvMobileCatalogSnapshotBridge(
  deps: TvMobileCatalogSnapshotDeps,
): TvMobileCatalogSnapshotBridge {
  const now = (): number => (deps.clock ? deps.clock() : Date.now());

  return {
    async getLocalSnapshot(): Promise<VaultSnapshot> {
      const catalog = await deps.getCatalog();
      const [sources, profileRows] = await Promise.all([
        exportMobileSources(catalog, deps.secretStore),
        catalog.listProfiles?.().catch(() => []) ?? Promise.resolve([]),
      ]);

      const profiles: SyncProfileRecord[] = [];
      for (const prof of profileRows) {
        const [parental, pinHash] = await Promise.all([
          catalog.getParentalSettings?.(prof.id).catch(() => null) ?? Promise.resolve(null),
          deps.secretStore.get(pinSecretKey(prof.id)).catch(() => undefined),
        ]);
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
      const seenGroupIds = new Set<string>();

      for (const pid of profileIds) {
        const isDefault = pid === DEFAULT_PROFILE_ID;
        const pidArg = isDefault ? undefined : pid;
        const pidOpt = isDefault ? {} : { profileId: pid };
        const [
          favoriteRows,
          allProgressRows,
          overrideRows,
          customGroupRows,
          collectionRows,
          ratingRows,
          dismissalRows,
        ] = await Promise.all([
          catalog
            .listFavorites?.(500, pidArg, { includeHidden: true, parentalUnlocked: true })
            .catch(() => []) ?? Promise.resolve([]),
          catalog.listAllWatchProgress?.(pidArg, 2_000).catch(() => []) ?? Promise.resolve([]),
          catalog.listChannelOverrides?.(pidArg).catch(() => []) ?? Promise.resolve([]),
          catalog
            .listCustomGroups?.(pidArg, { includeHidden: true, parentalUnlocked: true })
            .catch(() => []) ?? Promise.resolve([]),
          catalog.listCollections?.(pidArg, { parentalUnlocked: true }).catch(() => []) ??
            Promise.resolve([]),
          catalog
            .listRatings?.({ limit: 250, ...pidOpt, parentalUnlocked: true })
            .catch(() => []) ?? Promise.resolve([]),
          catalog.listContinueWatchingDismissals?.(pid).catch(() => []) ?? Promise.resolve([]),
        ]);

        const progressRows =
          allProgressRows.length > 0
            ? allProgressRows
            : ((await catalog
                .listContinueWatching?.(200, pidArg, { parentalUnlocked: true })
                .catch(() => [])) ?? []);

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
          const items = await catalog
            .items(customGroupCategoryId(group.id), 0, 500, {
              includeHidden: true,
              parentalUnlocked: true,
            })
            .catch(() => []);
          customGroups.push({
            id: group.id,
            name: group.name,
            channelKeys: items.map((item) => item.key),
            sortOrder: group.sortOrder,
            updatedAt: group.updatedAt,
          });
        }

        for (const col of collectionRows) {
          let itemKeys =
            (await catalog.listCollectionRawItemKeys?.(col.id, pidArg).catch(() => [])) ?? [];
          if (
            itemKeys.length === 0 &&
            (catalog.listCollectionRawItemKeys === undefined ||
              col.itemCount === undefined ||
              col.itemCount > 0)
          ) {
            const items =
              (await catalog
                .listCollectionItems?.(col.id, { parentalUnlocked: true })
                .catch(() => [])) ?? [];
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
      };
    },

    async applyMergedSnapshot(snapshot: VaultSnapshot): Promise<void> {
      const catalog = await deps.getCatalog();
      const changed = await applyMobileMergedSnapshot(snapshot, catalog, deps.secretStore);
      if (changed) {
        deps.onApplied?.();
      }
    },
  };
}
