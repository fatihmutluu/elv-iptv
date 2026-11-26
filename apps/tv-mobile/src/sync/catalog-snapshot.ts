import {
  type CatalogService,
  customGroupCategoryId,
  secretKey,
  sourceOfKey,
  type UserItemKind,
} from '@elv/data';
import type { SecretStore } from '@elv/domain';
import {
  type SyncCollection,
  type SyncCustomGroup,
  type SyncKeyedFlag,
  type SyncRatingRecord,
  type SyncSourceRecord,
  type SyncWatchProgress,
  VAULT_SCHEMA_VERSION,
  type VaultSnapshot,
} from '@elv/sync';

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

/**
 * Bridges `tv-mobile`'s local SQLite {@link CatalogService} and encrypted {@link SecretStore}
 * with `@elv/sync`'s {@link VaultSnapshot} export and merge-apply lifecycle (`#26`).
 * Credentials are read from and written strictly via `SecretStore` (through `CatalogService.addSource`);
 * secrets never enter SQLite.
 */
export function createTvMobileCatalogSnapshotBridge(
  deps: TvMobileCatalogSnapshotDeps,
): TvMobileCatalogSnapshotBridge {
  const now = (): number => (deps.clock ? deps.clock() : Date.now());

  return {
    async getLocalSnapshot(): Promise<VaultSnapshot> {
      const catalog = await deps.getCatalog();
      const [
        sourceRows,
        favoriteRows,
        progressRows,
        overrideRows,
        customGroupRows,
        collectionRows,
        ratingRows,
      ] = await Promise.all([
        catalog.listSources().catch(() => []),
        catalog
          .listFavorites?.(500, undefined, { includeHidden: true, parentalUnlocked: true })
          .catch(() => []) ?? Promise.resolve([]),
        catalog
          .listContinueWatching?.(200, undefined, { parentalUnlocked: true })
          .catch(() => []) ?? Promise.resolve([]),
        catalog.listChannelOverrides?.().catch(() => []) ?? Promise.resolve([]),
        catalog
          .listCustomGroups?.(undefined, { includeHidden: true, parentalUnlocked: true })
          .catch(() => []) ?? Promise.resolve([]),
        catalog.listCollections?.(undefined, { parentalUnlocked: true }).catch(() => []) ??
          Promise.resolve([]),
        catalog.listRatings?.({ limit: 250, parentalUnlocked: true }).catch(() => []) ??
          Promise.resolve([]),
      ]);

      const sources: SyncSourceRecord[] = [];
      for (const row of sourceRows) {
        const rawUrlVars = await deps.secretStore
          .get(secretKey(row.id, 'urlvars'))
          .catch(() => undefined);
        const epgUrl = parseGuideUrlFromUrlVars(rawUrlVars);

        if (row.kind === 'xtream') {
          const rawSecret = await deps.secretStore
            .get(secretKey(row.id, 'xtream'))
            .catch(() => undefined);
          const parsed = parseXtreamSecret(rawSecret);
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

      const collections: SyncCollection[] = [];
      for (const col of collectionRows) {
        const items =
          (await catalog
            .listCollectionItems?.(col.id, { parentalUnlocked: true })
            .catch(() => [])) ?? [];
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
      };
    },

    async applyMergedSnapshot(snapshot: VaultSnapshot): Promise<void> {
      const catalog = await deps.getCatalog();
      let changed = false;

      // 1. Sources (credentials strictly through SecretStore via CatalogService.addSource)
      const existingSources = await catalog.listSources().catch(() => []);
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
            const removed = await catalog.removeSource(src.id).catch(() => null);
            if (removed?.ok) {
              existingById.delete(src.id);
              changed = true;
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
          const added = await catalog
            .addSource({
              kind: 'xtream',
              name: src.name,
              server: src.url,
              username: src.username,
              password: src.password,
              ...(src.epgUrl ? { guideUrl: src.epgUrl } : {}),
            })
            .catch(() => null);
          if (added?.ok) {
            existingFingerprints.add(fp);
            changed = true;
          }
        } else if (src.kind === 'm3u' && src.url.trim().length > 0) {
          const added = await catalog
            .addSource({
              kind: 'm3u',
              name: src.name,
              playlistUrl: src.url,
              ...(src.epgUrl ? { guideUrl: src.epgUrl } : {}),
            })
            .catch(() => null);
          if (added?.ok) {
            existingFingerprints.add(fp);
            changed = true;
          }
        }
      }

      // 2. Favorites
      if (catalog.setFavorite !== undefined) {
        const existingFavKeys = new Set((await catalog.listFavoriteKeys?.().catch(() => [])) ?? []);
        for (const fav of snapshot.favorites) {
          if (fav.deleted === true) {
            if (existingFavKeys.has(fav.key)) {
              const res = await catalog
                .setFavorite(
                  {
                    sourceId: sourceOfKey(fav.key) ?? 'sync',
                    itemKey: fav.key,
                    kind: inferItemKind(fav.key),
                    title: fav.key,
                  },
                  false,
                )
                .catch(() => null);
              if (res?.ok) {
                existingFavKeys.delete(fav.key);
                changed = true;
              }
            }
            continue;
          }
          if (existingFavKeys.has(fav.key)) continue;
          const detail =
            (await catalog.itemDetail?.(fav.key, { parentalUnlocked: true }).catch(() => null)) ??
            null;
          const sourceId = detail?.sourceId ?? sourceOfKey(fav.key);
          if (sourceId === undefined) continue;
          const res = await catalog
            .setFavorite(
              {
                sourceId,
                itemKey: fav.key,
                kind: detail?.kind ?? inferItemKind(fav.key),
                title: detail?.name ?? fav.key,
                logo: detail?.logo ?? null,
                year: detail?.year ?? null,
                rating: detail?.rating ?? null,
              },
              true,
            )
            .catch(() => null);
          if (res?.ok) {
            existingFavKeys.add(fav.key);
            changed = true;
          }
        }
      }

      // 3. Hidden channels
      if (catalog.setChannelOverride !== undefined) {
        const existingOverrides = (await catalog.listChannelOverrides?.().catch(() => [])) ?? [];
        const overrideByKey = new Map(existingOverrides.map((ov) => [ov.itemKey, ov]));
        for (const hidden of snapshot.hiddenChannels) {
          const existing = overrideByKey.get(hidden.key);
          const sourceId = existing?.sourceId ?? sourceOfKey(hidden.key);
          if (sourceId === undefined) continue;
          if (hidden.deleted === true) {
            if (existing?.isHidden) {
              const res = await catalog
                .setChannelOverride({ itemKey: hidden.key, sourceId, isHidden: false })
                .catch(() => null);
              if (res?.ok) changed = true;
            }
          } else if (!existing?.isHidden) {
            const res = await catalog
              .setChannelOverride({ itemKey: hidden.key, sourceId, isHidden: true })
              .catch(() => null);
            if (res?.ok) changed = true;
          }
        }
      }

      // 4. Custom groups
      if (catalog.listCustomGroups !== undefined && catalog.createCustomGroup !== undefined) {
        const existingGroups = await catalog
          .listCustomGroups(undefined, { includeHidden: true, parentalUnlocked: true })
          .catch(() => []);
        const groupById = new Map(existingGroups.map((g) => [g.id, g]));
        const groupByName = new Map(existingGroups.map((g) => [g.name.toLowerCase(), g]));
        for (const grp of snapshot.customGroups) {
          const existing = groupById.get(grp.id) ?? groupByName.get(grp.name.toLowerCase());
          if (grp.deleted === true) {
            if (existing !== undefined && catalog.deleteCustomGroup !== undefined) {
              const res = await catalog.deleteCustomGroup(existing.id).catch(() => null);
              if (res?.ok) changed = true;
            }
            continue;
          }
          let targetGroupId = existing?.id;
          if (existing === undefined) {
            const created = await catalog
              .createCustomGroup({ name: grp.name, sortOrder: grp.sortOrder })
              .catch(() => null);
            if (created?.ok) {
              targetGroupId = created.value.id;
              changed = true;
            }
          } else if (
            (existing.name !== grp.name || existing.sortOrder !== grp.sortOrder) &&
            grp.updatedAt > existing.updatedAt &&
            catalog.updateCustomGroup !== undefined
          ) {
            const updated = await catalog
              .updateCustomGroup(existing.id, { name: grp.name, sortOrder: grp.sortOrder })
              .catch(() => null);
            if (updated?.ok) changed = true;
          }
          if (
            targetGroupId !== undefined &&
            grp.channelKeys.length > 0 &&
            catalog.setCustomGroupItems !== undefined
          ) {
            const items = grp.channelKeys
              .map((itemKey) => {
                const sid = sourceOfKey(itemKey);
                return sid !== undefined ? { itemKey, sourceId: sid } : null;
              })
              .filter((item): item is { itemKey: string; sourceId: string } => item !== null);
            if (items.length > 0) {
              const res = await catalog.setCustomGroupItems(targetGroupId, items).catch(() => null);
              if (res?.ok) changed = true;
            }
          }
        }
      }

      // 5. VOD collections
      if (catalog.listCollections !== undefined && catalog.createCollection !== undefined) {
        const existingCols = await catalog
          .listCollections(undefined, { parentalUnlocked: true })
          .catch(() => []);
        const colById = new Map(existingCols.map((c) => [c.id, c]));
        const colByName = new Map(existingCols.map((c) => [c.name.toLowerCase(), c]));
        for (const col of snapshot.collections) {
          const existing = colById.get(col.id) ?? colByName.get(col.name.toLowerCase());
          if (col.deleted === true) {
            if (existing !== undefined && catalog.deleteCollection !== undefined) {
              const res = await catalog.deleteCollection(existing.id).catch(() => null);
              if (res?.ok) changed = true;
            }
            continue;
          }
          let targetColId = existing?.id;
          if (existing === undefined) {
            const created = await catalog
              .createCollection({ id: col.id, name: col.name })
              .catch(() => null);
            if (created?.ok) {
              targetColId = created.value.id;
              changed = true;
            }
          } else if (
            existing.name !== col.name &&
            col.updatedAt > existing.updatedAt &&
            catalog.renameCollection !== undefined
          ) {
            const renamed = await catalog.renameCollection(existing.id, col.name).catch(() => null);
            if (renamed?.ok) changed = true;
          }
          if (
            targetColId !== undefined &&
            col.itemKeys.length > 0 &&
            catalog.addItemToCollection !== undefined
          ) {
            for (const itemKey of col.itemKeys) {
              if (sourceOfKey(itemKey) === undefined) continue;
              const detail =
                (await catalog
                  .itemDetail?.(itemKey, { parentalUnlocked: true })
                  .catch(() => null)) ?? null;
              const kind =
                detail?.kind === 'movie' || detail?.kind === 'series'
                  ? detail.kind
                  : inferVodKind(itemKey);
              if (kind === undefined) continue;
              const res = await catalog
                .addItemToCollection(targetColId, itemKey, kind)
                .catch(() => null);
              if (res?.ok) changed = true;
            }
          }
        }
      }

      // 6. Watch progress (LWW)
      if (catalog.saveProgress !== undefined) {
        for (const prog of snapshot.watchProgress) {
          if (prog.deleted === true) {
            const cleared = await catalog.clearProgress?.(prog.key).catch(() => null);
            if (cleared?.ok) changed = true;
            continue;
          }
          const existing = (await catalog.getProgress?.(prog.key).catch(() => null)) ?? null;
          if (existing !== null && prog.updatedAt <= existing.updatedAt) continue;
          const detail =
            existing !== null
              ? null
              : ((await catalog
                  .itemDetail?.(prog.key, { parentalUnlocked: true })
                  .catch(() => null)) ?? null);
          const sourceId = existing?.sourceId ?? detail?.sourceId ?? sourceOfKey(prog.key);
          if (sourceId === undefined) continue;
          const res = await catalog
            .saveProgress({
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
            })
            .catch(() => null);
          if (res?.ok) changed = true;
        }
      }

      // 7. Ratings (Movies & Series Like/Dislike, LWW + tombstones)
      if (
        snapshot.ratings !== undefined &&
        snapshot.ratings.length > 0 &&
        catalog.setRating !== undefined
      ) {
        const existingRatings =
          (await catalog.listRatings?.({ limit: 250, parentalUnlocked: true }).catch(() => [])) ??
          [];
        const existingByKey = new Map(existingRatings.map((r) => [r.itemKey, r]));
        for (const rec of snapshot.ratings) {
          const existing = existingByKey.get(rec.key);
          if (rec.deleted === true) {
            if (existing !== undefined && rec.updatedAt >= existing.updatedAt) {
              const cleared = await catalog
                .setRating(
                  {
                    sourceId: existing.sourceId,
                    itemKey: existing.itemKey,
                    kind: existing.kind,
                    title: existing.title,
                  },
                  null,
                )
                .catch(() => null);
              if (cleared?.ok) changed = true;
            }
            continue;
          }
          if (existing !== undefined && rec.updatedAt <= existing.updatedAt) continue;
          const res = await catalog
            .setRating(
              {
                sourceId: rec.sourceId,
                itemKey: rec.key,
                kind: rec.kind,
                title: rec.title,
                logo: rec.logo ?? null,
                year: rec.year ?? null,
                rating: rec.rating ?? null,
              },
              rec.value,
            )
            .catch(() => null);
          if (res?.ok) changed = true;
        }
      }

      if (changed) {
        await catalog.flushPendingWrites?.().catch(() => undefined);
        deps.onApplied?.();
      }
    },
  };
}
