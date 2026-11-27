import {
  type ChannelOverrideRecord,
  type ContinueWatchingDismissalRow,
  type CustomGroupRecord,
  customGroupCategoryId,
  DEFAULT_PROFILE_ID,
  type FavoriteRow,
  type ItemDetailRow,
  type ItemRow,
  isProfileAvatarToken,
  isValidCustomGroupId,
  isValidProfileId,
  type ParentalSettings,
  type ProfileRecord,
  pinSecretKey,
  type RatingRow,
  type RatingValue,
  sourceOfKey,
  type UserItemKind,
  type VodCollectionRecord,
  type WatchProgressRow,
} from '@elv/data';
import type { Result, SecretStore } from '@elv/domain';
import { decodeEpisodeBitfield, type SyncProfileRecord, type VaultSnapshot } from '@elv/sync';
import type { CatalogRpcMethodCall } from '../../shared/catalog-ipc.ts';
import { applyDesktopSources } from './snapshot-source-helpers.ts';

/** RPC caller callback used by desktop snapshot export and apply helpers. */
export type DesktopSnapshotRpcCaller = <R>(rpc: CatalogRpcMethodCall) => Promise<R>;

/** Narrowing helper returning `value` as an array or `[]`. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Narrowing helper returning `ParentalSettings` when present on an RPC reply. */
export function asParentalSettings(value: unknown): ParentalSettings | null {
  if (typeof value !== 'object' || value === null || !('enabled' in value)) return null;
  return value as ParentalSettings;
}

function parseMaxRatingAge(raw: string | null | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw.trim() === '') return null;
  const match = /\d+/.exec(raw);
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 21 ? parsed : undefined;
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

function groupByProfile<T extends { readonly profileId?: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const pid = item.profileId && item.profileId.length > 0 ? item.profileId : DEFAULT_PROFILE_ID;
    const bucket = out.get(pid);
    if (bucket === undefined) out.set(pid, [item]);
    else bucket.push(item);
  }
  return out;
}

function sameStringOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function applyProfiles(
  profiles: readonly SyncProfileRecord[] | undefined,
  call: DesktopSnapshotRpcCaller,
  secretStore: Pick<SecretStore, 'get' | 'set' | 'delete'>,
): Promise<boolean> {
  if (profiles === undefined || profiles.length === 0) return false;
  let mutated = false;
  const existing = asArray<ProfileRecord>(
    await call<unknown>({ method: 'listProfiles' }).catch(() => []),
  );
  const existingById = new Map(existing.map((p) => [p.id, p]));

  for (const prof of profiles) {
    if (!isValidProfileId(prof.id)) continue;
    const current = existingById.get(prof.id);
    if (prof.deleted === true) {
      if (current !== undefined && prof.updatedAt >= current.updatedAt) {
        const res = await call<Result<void>>({ method: 'deleteProfile', id: prof.id }).catch(
          () => null,
        );
        if (res?.ok) {
          existingById.delete(prof.id);
          await secretStore.delete(pinSecretKey(prof.id)).catch(() => undefined);
          mutated = true;
        }
      }
      continue;
    }

    const safeAvatar = isProfileAvatarToken(prof.avatarToken) ? prof.avatarToken : 'crimson';
    if (current === undefined) {
      const created = await call<Result<ProfileRecord>>({
        method: 'createProfile',
        input: {
          id: prof.id,
          name: prof.name.trim() || 'Profile',
          avatarToken: safeAvatar,
          isKids: prof.isKids,
        },
      }).catch(() => null);
      if (created?.ok) {
        existingById.set(prof.id, created.value);
        mutated = true;
      }
    } else if (
      prof.updatedAt > current.updatedAt &&
      (current.name !== prof.name ||
        current.avatarToken !== safeAvatar ||
        current.isKids !== prof.isKids)
    ) {
      const updated = await call<Result<ProfileRecord>>({
        method: 'updateProfile',
        id: prof.id,
        patch: {
          name: prof.name.trim() || current.name,
          avatarToken: safeAvatar,
          isKids: prof.isKids,
        },
      }).catch(() => null);
      if (updated?.ok) mutated = true;
    }

    if (prof.parentalEnabled !== undefined || prof.parentalMaxRating !== undefined) {
      const currentParental = asParentalSettings(
        await call<unknown>({ method: 'getParentalSettings', profileId: prof.id }).catch(
          () => null,
        ),
      );
      if (current === undefined || prof.updatedAt >= (currentParental?.updatedAt ?? 0)) {
        const nextMaxAge = parseMaxRatingAge(prof.parentalMaxRating);
        const nextEnabled = prof.parentalEnabled ?? currentParental?.enabled ?? false;
        const shouldUpdate =
          currentParental === null ||
          currentParental.enabled !== nextEnabled ||
          (nextMaxAge !== undefined && currentParental.maxRatingAge !== nextMaxAge);
        if (shouldUpdate) {
          const res = await call<Result<ParentalSettings>>({
            method: 'updateParentalSettings',
            profileId: prof.id,
            patch: {
              enabled: nextEnabled,
              ...(nextMaxAge !== undefined ? { maxRatingAge: nextMaxAge } : {}),
            },
          }).catch(() => null);
          if (res?.ok) mutated = true;
        }
      }
    }

    if (prof.pinHash !== undefined) {
      const currentPin = await secretStore.get(pinSecretKey(prof.id)).catch(() => undefined);
      if (current === undefined || prof.updatedAt >= current.updatedAt) {
        if (typeof prof.pinHash === 'string' && prof.pinHash.trim().length > 0) {
          if (currentPin !== prof.pinHash) {
            await secretStore.set(pinSecretKey(prof.id), prof.pinHash);
            mutated = true;
          }
        } else if (prof.pinHash === null && currentPin !== undefined) {
          await secretStore.delete(pinSecretKey(prof.id));
          mutated = true;
        }
      }
    }
  }
  return mutated;
}

/** Applies a full merged `VaultSnapshot` v2 payload onto Desktop's catalog worker and `SecretStore`. */
export async function applyDesktopMergedSnapshot(
  snapshot: VaultSnapshot,
  call: DesktopSnapshotRpcCaller,
  secretStore: Pick<SecretStore, 'get' | 'set' | 'delete'>,
): Promise<boolean> {
  let mutated = false;

  if (await applyProfiles(snapshot.profiles, call, secretStore)) mutated = true;
  if (await applyDesktopSources(snapshot.sources, call, secretStore)) mutated = true;

  // Favorites (per-profile additions, deletions, and sortOrder)
  for (const [pid, favGroup] of groupByProfile(snapshot.favorites)) {
    const pidCallOpt = pid === DEFAULT_PROFILE_ID ? {} : { profileId: pid };
    const existingFavKeys = new Set(
      asArray<string>(
        await call<unknown>({ method: 'listFavoriteKeys', ...pidCallOpt }).catch(() => []),
      ),
    );
    const existingFavRows = asArray<FavoriteRow>(
      await call<unknown>({
        method: 'listFavorites',
        limit: 500,
        ...pidCallOpt,
        opts: { includeHidden: true, parentalUnlocked: true },
      }).catch(() => []),
    );
    for (const row of existingFavRows) existingFavKeys.add(row.itemKey);

    for (const fav of favGroup) {
      const explicitPid = fav.profileId !== undefined ? { profileId: fav.profileId } : {};
      if (fav.deleted === true) {
        if (existingFavKeys.has(fav.key)) {
          const res = await call<Result<boolean>>({
            method: 'setFavorite',
            input: {
              ...explicitPid,
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
          ...explicitPid,
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

    const activeOrdered = favGroup
      .filter((f) => f.deleted !== true && typeof f.sortOrder === 'number')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.updatedAt - a.updatedAt)
      .map((f) => f.key);
    if (
      activeOrdered.length > 1 &&
      !sameStringOrder(
        existingFavRows.map((r) => r.itemKey),
        activeOrdered,
      )
    ) {
      const reordered = await call<Result<void>>({
        method: 'reorderFavorites',
        orderedItemKeys: activeOrdered,
        ...pidCallOpt,
      }).catch(() => null);
      if (reordered?.ok) mutated = true;
    }
  }

  // Hidden channels
  for (const [pid, hiddenGroup] of groupByProfile(snapshot.hiddenChannels)) {
    const pidCallOpt = pid === DEFAULT_PROFILE_ID ? {} : { profileId: pid };
    const existingOverrides = asArray<ChannelOverrideRecord>(
      await call<unknown>({ method: 'listChannelOverrides', ...pidCallOpt }).catch(() => []),
    );
    const overrideByKey = new Map(existingOverrides.map((ov) => [ov.itemKey, ov]));
    for (const hidden of hiddenGroup) {
      const existing = overrideByKey.get(hidden.key);
      const sourceId = existing?.sourceId ?? sourceOfKey(hidden.key);
      if (sourceId === undefined) continue;
      const explicitPid = hidden.profileId !== undefined ? { profileId: hidden.profileId } : {};
      if (hidden.deleted === true) {
        if (existing?.isHidden) {
          const res = await call<Result<ChannelOverrideRecord>>({
            method: 'setChannelOverride',
            input: { ...explicitPid, itemKey: hidden.key, sourceId, isHidden: false },
          }).catch(() => null);
          if (res?.ok) mutated = true;
        }
      } else if (!existing?.isHidden) {
        const res = await call<Result<ChannelOverrideRecord>>({
          method: 'setChannelOverride',
          input: { ...explicitPid, itemKey: hidden.key, sourceId, isHidden: true },
        }).catch(() => null);
        if (res?.ok) mutated = true;
      }
    }
  }

  // Custom groups
  if (snapshot.customGroups.length > 0) {
    const existingGroups = asArray<CustomGroupRecord>(
      await call<unknown>({
        method: 'listCustomGroups',
        opts: { includeHidden: true, parentalUnlocked: true },
      }).catch(() => []),
    );
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
          input: {
            ...(isValidCustomGroupId(grp.id.trim()) ? { id: grp.id.trim() } : {}),
            name: grp.name,
            sortOrder: grp.sortOrder,
          },
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
      if (
        targetGroupId !== undefined &&
        (existing === undefined || grp.updatedAt >= existing.updatedAt)
      ) {
        const items = grp.channelKeys
          .map((itemKey) => {
            const sid = sourceOfKey(itemKey);
            return sid !== undefined ? { itemKey, sourceId: sid } : null;
          })
          .filter((item): item is { itemKey: string; sourceId: string } => item !== null);
        const existingKeys =
          existing === undefined
            ? []
            : asArray<ItemRow>(
                await call<unknown>({
                  method: 'items',
                  categoryId: customGroupCategoryId(targetGroupId),
                  offset: 0,
                  limit: 500,
                  opts: { includeHidden: true, parentalUnlocked: true },
                }).catch(() => []),
              ).map((item) => item.key);
        const desiredKeys = items.map((item) => item.itemKey);
        if (!sameStringOrder(existingKeys, desiredKeys)) {
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

  // VOD collections (reconciling additions, removals, empty folders, and ordering)
  for (const [pid, colGroup] of groupByProfile(snapshot.collections)) {
    const pidCallOpt = pid === DEFAULT_PROFILE_ID ? {} : { profileId: pid };
    const existingCols = asArray<VodCollectionRecord>(
      await call<unknown>({
        method: 'listCollections',
        ...pidCallOpt,
        opts: { parentalUnlocked: true },
      }).catch(() => []),
    );
    const colById = new Map(existingCols.map((c) => [c.id, c]));
    const colByName = new Map(existingCols.map((c) => [c.name.toLowerCase(), c]));

    for (const col of colGroup) {
      const existing = colById.get(col.id) ?? colByName.get(col.name.toLowerCase());
      if (col.deleted === true) {
        if (existing !== undefined && col.updatedAt >= existing.updatedAt) {
          const res = await call<Result<void>>({
            method: 'deleteCollection',
            id: existing.id,
            ...pidCallOpt,
          }).catch(() => null);
          if (res?.ok) mutated = true;
        }
        continue;
      }
      let targetColId = existing?.id;
      if (existing === undefined) {
        const created = await call<Result<VodCollectionRecord>>({
          method: 'createCollection',
          input: { id: col.id, name: col.name, ...pidCallOpt },
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
          ...pidCallOpt,
        }).catch(() => null);
        if (renamed?.ok) mutated = true;
      }
      if (
        targetColId !== undefined &&
        (existing === undefined || col.updatedAt >= existing.updatedAt)
      ) {
        const currentKeys = asArray<string>(
          await call<unknown>({
            method: 'listCollectionRawItemKeys',
            collectionId: targetColId,
            ...pidCallOpt,
          }).catch(() => []),
        );
        const desiredSet = new Set(col.itemKeys);
        const currentSet = new Set(currentKeys);

        for (const staleKey of currentKeys) {
          if (desiredSet.has(staleKey)) continue;
          const rem = await call<Result<void>>({
            method: 'removeItemFromCollection',
            collectionId: targetColId,
            itemKey: staleKey,
            ...pidCallOpt,
          }).catch(() => null);
          if (rem?.ok) mutated = true;
        }
        for (const itemKey of col.itemKeys) {
          if (currentSet.has(itemKey) || sourceOfKey(itemKey) === undefined) continue;
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
            ...pidCallOpt,
          }).catch(() => null);
          if (res?.ok) mutated = true;
        }
        if (col.itemKeys.length > 1 && !sameStringOrder(currentKeys, col.itemKeys)) {
          const reord = await call<Result<void>>({
            method: 'reorderCollectionItems',
            collectionId: targetColId,
            orderedItemKeys: [...col.itemKeys],
            ...pidCallOpt,
          }).catch(() => null);
          if (reord?.ok) mutated = true;
        }
      }
    }

    const activeOrderedCols = colGroup
      .filter((c) => c.deleted !== true && typeof c.sortOrder === 'number')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.updatedAt - b.updatedAt)
      .map((c) => c.id);
    if (
      activeOrderedCols.length > 1 &&
      !sameStringOrder(
        existingCols.map((c) => c.id),
        activeOrderedCols,
      )
    ) {
      const reord = await call<Result<VodCollectionRecord[]>>({
        method: 'reorderCollections',
        orderedIds: activeOrderedCols,
        ...pidCallOpt,
      }).catch(() => null);
      if (reord?.ok) mutated = true;
    }
  }

  // Watch progress (in-progress + completed)
  for (const prog of snapshot.watchProgress) {
    const explicitPid = prog.profileId !== undefined ? { profileId: prog.profileId } : {};
    const existing = await call<WatchProgressRow | null>({
      method: 'getProgress',
      itemKey: prog.key,
      ...explicitPid,
    }).catch(() => null);
    if (prog.deleted === true) {
      if (existing !== null && prog.updatedAt >= existing.updatedAt) {
        const cleared = await call<Result<void>>({
          method: 'clearProgress',
          itemKey: prog.key,
          ...explicitPid,
        }).catch(() => null);
        if (cleared?.ok) mutated = true;
      }
      continue;
    }
    const completed = prog.completed || prog.watched === true;
    if (
      existing !== null &&
      prog.updatedAt <= existing.updatedAt &&
      !(completed && !existing.watched && prog.updatedAt >= existing.updatedAt)
    ) {
      continue;
    }
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
        ...explicitPid,
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
        watched: completed,
      },
    }).catch(() => null);
    if (res?.ok) mutated = true;
  }

  // Watched episode bitfields
  for (const bf of snapshot.watchedEpisodesBitfields) {
    if (bf.deleted === true || bf.bitsB64.length === 0) continue;
    const episodeIndices = decodeEpisodeBitfield(bf.bitsB64);
    if (episodeIndices.length === 0) continue;
    const res = await call<Result<number>>({
      method: 'applyWatchedEpisodeBitfield',
      input: {
        ...(bf.profileId !== undefined ? { profileId: bf.profileId } : {}),
        seriesKey: bf.seriesKey,
        ...(bf.season !== undefined ? { season: bf.season } : {}),
        episodeIndices,
        updatedAt: bf.updatedAt,
      },
    }).catch(() => null);
    if (res?.ok && res.value > 0) mutated = true;
  }

  // Continue Watching dismissals (diffed before write so no-op syncs never trigger UI refreshes)
  if (
    snapshot.continueWatchingDismissals !== undefined &&
    snapshot.continueWatchingDismissals.length > 0
  ) {
    for (const [pid, disGroup] of groupByProfile(snapshot.continueWatchingDismissals)) {
      const existingDismissals = asArray<ContinueWatchingDismissalRow>(
        await call<unknown>({
          method: 'listContinueWatchingDismissals',
          profileId: pid,
        }).catch(() => []),
      );
      const existingBySeries = new Map(existingDismissals.map((row) => [row.seriesKey, row]));
      for (const dis of disGroup) {
        const existing = existingBySeries.get(dis.seriesKey);
        if (dis.deleted) {
          if (existing === undefined || dis.dismissedAt < existing.dismissedAt) continue;
        } else if (existing !== undefined && existing.dismissedAt >= dis.dismissedAt) {
          continue;
        }
        const res = await call<Result<void>>({
          method: 'setContinueWatchingDismissal',
          input: {
            profileId: dis.profileId,
            seriesKey: dis.seriesKey,
            sourceId: dis.sourceId,
            dismissedAt: dis.dismissedAt,
          },
          deleted: dis.deleted,
        }).catch(() => null);
        if (res?.ok) {
          if (dis.deleted) existingBySeries.delete(dis.seriesKey);
          else {
            existingBySeries.set(dis.seriesKey, {
              profileId: dis.profileId,
              seriesKey: dis.seriesKey,
              sourceId: dis.sourceId,
              dismissedAt: dis.dismissedAt,
            });
          }
          mutated = true;
        }
      }
    }
  }

  // Ratings
  if (snapshot.ratings !== undefined && snapshot.ratings.length > 0) {
    for (const [pid, ratingGroup] of groupByProfile(snapshot.ratings)) {
      const pidOpt = pid === DEFAULT_PROFILE_ID ? {} : { profileId: pid };
      const existingRatings = asArray<RatingRow>(
        await call<unknown>({
          method: 'listRatings',
          opts: { limit: 250, ...pidOpt, parentalUnlocked: true },
        }).catch(() => []),
      );
      const existingByKey = new Map(existingRatings.map((r) => [r.itemKey, r]));
      for (const rec of ratingGroup) {
        const existing = existingByKey.get(rec.key);
        const explicitPid = rec.profileId !== undefined ? { profileId: rec.profileId } : {};
        if (rec.deleted === true) {
          if (existing !== undefined && rec.updatedAt >= existing.updatedAt) {
            const cleared = await call<Result<RatingValue | null>>({
              method: 'setRating',
              input: {
                ...explicitPid,
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
            ...explicitPid,
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
  }

  if (mutated) {
    await call<void>({ method: 'flushPendingWrites' }).catch(() => undefined);
  }
  return mutated;
}
