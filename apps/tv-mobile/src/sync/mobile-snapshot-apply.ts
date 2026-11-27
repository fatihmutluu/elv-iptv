import {
  type CatalogService,
  customGroupCategoryId,
  DEFAULT_PROFILE_ID,
  isProfileAvatarToken,
  isValidCustomGroupId,
  isValidProfileId,
  pinSecretKey,
  sourceOfKey,
  type UserItemKind,
} from '@elv/data';
import type { SecretStore } from '@elv/domain';
import { decodeEpisodeBitfield, type SyncProfileRecord, type VaultSnapshot } from '@elv/sync';
import { applyMobileSources } from './snapshot-source-helpers';

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

async function applyMobileProfiles(
  profiles: readonly SyncProfileRecord[] | undefined,
  catalog: CatalogService,
  secretStore: Pick<SecretStore, 'get' | 'set' | 'delete'>,
): Promise<boolean> {
  if (profiles === undefined || profiles.length === 0) return false;
  let changed = false;
  const existing = (await catalog.listProfiles?.().catch(() => [])) ?? [];
  const existingById = new Map(existing.map((p) => [p.id, p]));

  for (const prof of profiles) {
    if (!isValidProfileId(prof.id)) continue;
    const current = existingById.get(prof.id);
    if (prof.deleted === true) {
      if (current !== undefined && prof.updatedAt >= current.updatedAt) {
        const res = await catalog.deleteProfile?.(prof.id).catch(() => null);
        if (res?.ok) {
          existingById.delete(prof.id);
          await secretStore.delete(pinSecretKey(prof.id)).catch(() => undefined);
          changed = true;
        }
      }
      continue;
    }

    const safeAvatar = isProfileAvatarToken(prof.avatarToken) ? prof.avatarToken : 'crimson';
    if (current === undefined) {
      const created = await catalog
        .createProfile?.({
          id: prof.id,
          name: prof.name.trim() || 'Profile',
          avatarToken: safeAvatar,
          isKids: prof.isKids,
        })
        .catch(() => null);
      if (created?.ok) {
        existingById.set(prof.id, created.value);
        changed = true;
      }
    } else if (
      prof.updatedAt > current.updatedAt &&
      (current.name !== prof.name ||
        current.avatarToken !== safeAvatar ||
        current.isKids !== prof.isKids)
    ) {
      const updated = await catalog
        .updateProfile?.(prof.id, {
          name: prof.name.trim() || current.name,
          avatarToken: safeAvatar,
          isKids: prof.isKids,
        })
        .catch(() => null);
      if (updated?.ok) changed = true;
    }

    if (prof.parentalEnabled !== undefined || prof.parentalMaxRating !== undefined) {
      const currentParental =
        (await catalog.getParentalSettings?.(prof.id).catch(() => null)) ?? null;
      if (current === undefined || prof.updatedAt >= (currentParental?.updatedAt ?? 0)) {
        const nextMaxAge = parseMaxRatingAge(prof.parentalMaxRating);
        const nextEnabled = prof.parentalEnabled ?? currentParental?.enabled ?? false;
        const shouldUpdate =
          currentParental === null ||
          currentParental.enabled !== nextEnabled ||
          (nextMaxAge !== undefined && currentParental.maxRatingAge !== nextMaxAge);
        if (shouldUpdate) {
          const res = await catalog
            .updateParentalSettings?.(
              {
                enabled: nextEnabled,
                ...(nextMaxAge !== undefined ? { maxRatingAge: nextMaxAge } : {}),
              },
              prof.id,
            )
            .catch(() => null);
          if (res?.ok) changed = true;
        }
      }
    }

    if (prof.pinHash !== undefined) {
      const currentPin = await secretStore.get(pinSecretKey(prof.id)).catch(() => undefined);
      if (current === undefined || prof.updatedAt >= current.updatedAt) {
        if (typeof prof.pinHash === 'string' && prof.pinHash.trim().length > 0) {
          if (currentPin !== prof.pinHash) {
            await secretStore.set(pinSecretKey(prof.id), prof.pinHash);
            changed = true;
          }
        } else if (prof.pinHash === null && currentPin !== undefined) {
          await secretStore.delete(pinSecretKey(prof.id));
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Applies a full merged `VaultSnapshot` v2 payload onto Mobile's `CatalogService` and `SecretStore`. */
export async function applyMobileMergedSnapshot(
  snapshot: VaultSnapshot,
  catalog: CatalogService,
  secretStore: Pick<SecretStore, 'get' | 'set' | 'delete'>,
): Promise<boolean> {
  let changed = false;

  if (await applyMobileProfiles(snapshot.profiles, catalog, secretStore)) changed = true;
  if (await applyMobileSources(snapshot.sources, catalog, secretStore)) changed = true;

  // Favorites
  if (catalog.setFavorite !== undefined) {
    for (const [pid, favGroup] of groupByProfile(snapshot.favorites)) {
      const pidArg = pid === DEFAULT_PROFILE_ID ? undefined : pid;
      const existingFavKeys = new Set(
        (await catalog.listFavoriteKeys?.(pidArg).catch(() => [])) ?? [],
      );
      const existingFavRows =
        (await catalog
          .listFavorites?.(500, pidArg, { includeHidden: true, parentalUnlocked: true })
          .catch(() => [])) ?? [];
      for (const row of existingFavRows) existingFavKeys.add(row.itemKey);

      for (const fav of favGroup) {
        const explicitPid = fav.profileId !== undefined ? { profileId: fav.profileId } : {};
        if (fav.deleted === true) {
          if (existingFavKeys.has(fav.key)) {
            const res = await catalog
              .setFavorite(
                {
                  ...explicitPid,
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
              ...explicitPid,
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

      const activeOrdered = favGroup
        .filter((f) => f.deleted !== true && typeof f.sortOrder === 'number')
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.updatedAt - a.updatedAt)
        .map((f) => f.key);
      if (
        activeOrdered.length > 1 &&
        catalog.reorderFavorites !== undefined &&
        !sameStringOrder(
          existingFavRows.map((r) => r.itemKey),
          activeOrdered,
        )
      ) {
        const reord = await catalog.reorderFavorites(activeOrdered, pidArg).catch(() => null);
        if (reord?.ok) changed = true;
      }
    }
  }

  // Hidden channels
  if (catalog.setChannelOverride !== undefined) {
    for (const [pid, hiddenGroup] of groupByProfile(snapshot.hiddenChannels)) {
      const pidArg = pid === DEFAULT_PROFILE_ID ? undefined : pid;
      const existingOverrides =
        (await catalog.listChannelOverrides?.(pidArg).catch(() => [])) ?? [];
      const overrideByKey = new Map(existingOverrides.map((ov) => [ov.itemKey, ov]));
      for (const hidden of hiddenGroup) {
        const existing = overrideByKey.get(hidden.key);
        const sourceId = existing?.sourceId ?? sourceOfKey(hidden.key);
        if (sourceId === undefined) continue;
        const explicitPid = hidden.profileId !== undefined ? { profileId: hidden.profileId } : {};
        if (hidden.deleted === true) {
          if (existing?.isHidden) {
            const res = await catalog
              .setChannelOverride({
                ...explicitPid,
                itemKey: hidden.key,
                sourceId,
                isHidden: false,
              })
              .catch(() => null);
            if (res?.ok) changed = true;
          }
        } else if (!existing?.isHidden) {
          const res = await catalog
            .setChannelOverride({
              ...explicitPid,
              itemKey: hidden.key,
              sourceId,
              isHidden: true,
            })
            .catch(() => null);
          if (res?.ok) changed = true;
        }
      }
    }
  }

  // Custom groups
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
          .createCustomGroup({
            ...(isValidCustomGroupId(grp.id.trim()) ? { id: grp.id.trim() } : {}),
            name: grp.name,
            sortOrder: grp.sortOrder,
          })
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
        (existing === undefined || grp.updatedAt >= existing.updatedAt) &&
        catalog.setCustomGroupItems !== undefined
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
            : (
                await catalog
                  .items(customGroupCategoryId(targetGroupId), 0, 500, {
                    includeHidden: true,
                    parentalUnlocked: true,
                  })
                  .catch(() => [])
              ).map((item) => item.key);
        const desiredKeys = items.map((item) => item.itemKey);
        if (!sameStringOrder(existingKeys, desiredKeys)) {
          const res = await catalog.setCustomGroupItems(targetGroupId, items).catch(() => null);
          if (res?.ok) changed = true;
        }
      }
    }
  }

  // VOD collections
  if (catalog.listCollections !== undefined) {
    for (const [pid, colGroup] of groupByProfile(snapshot.collections)) {
      const pidArg = pid === DEFAULT_PROFILE_ID ? undefined : pid;
      const existingCols = await catalog
        .listCollections(pidArg, { parentalUnlocked: true })
        .catch(() => []);
      const colById = new Map(existingCols.map((c) => [c.id, c]));
      const colByName = new Map(existingCols.map((c) => [c.name.toLowerCase(), c]));
      for (const col of colGroup) {
        const existing = colById.get(col.id) ?? colByName.get(col.name.toLowerCase());
        if (col.deleted === true) {
          if (
            existing !== undefined &&
            col.updatedAt >= existing.updatedAt &&
            catalog.deleteCollection !== undefined
          ) {
            const res = await catalog.deleteCollection(existing.id, pid).catch(() => null);
            if (res?.ok) changed = true;
          }
          continue;
        }
        let targetColId = existing?.id;
        if (existing === undefined && catalog.createCollection !== undefined) {
          const created = await catalog
            .createCollection({
              id: col.id,
              name: col.name,
              ...(pidArg !== undefined ? { profileId: pidArg } : {}),
            })
            .catch(() => null);
          if (created?.ok) {
            targetColId = created.value.id;
            changed = true;
          }
        } else if (
          existing !== undefined &&
          existing.name !== col.name &&
          col.updatedAt > existing.updatedAt &&
          catalog.renameCollection !== undefined
        ) {
          const renamed = await catalog
            .renameCollection(existing.id, col.name, pid)
            .catch(() => null);
          if (renamed?.ok) changed = true;
        }
        if (
          targetColId !== undefined &&
          (existing === undefined || col.updatedAt >= existing.updatedAt)
        ) {
          const currentKeys =
            (await catalog.listCollectionRawItemKeys?.(targetColId, pidArg).catch(() => [])) ?? [];
          const desiredSet = new Set(col.itemKeys);
          const currentSet = new Set(currentKeys);

          if (catalog.removeItemFromCollection !== undefined) {
            for (const staleKey of currentKeys) {
              if (desiredSet.has(staleKey)) continue;
              const rem = await catalog
                .removeItemFromCollection(targetColId, staleKey, pid)
                .catch(() => null);
              if (rem?.ok) changed = true;
            }
          }
          if (catalog.addItemToCollection !== undefined) {
            for (const itemKey of col.itemKeys) {
              if (currentSet.has(itemKey) || sourceOfKey(itemKey) === undefined) continue;
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
                .addItemToCollection(targetColId, itemKey, kind, pid)
                .catch(() => null);
              if (res?.ok) changed = true;
            }
          }
          if (
            col.itemKeys.length > 1 &&
            catalog.reorderCollectionItems !== undefined &&
            !sameStringOrder(currentKeys, col.itemKeys)
          ) {
            const reord = await catalog
              .reorderCollectionItems(targetColId, [...col.itemKeys], pid)
              .catch(() => null);
            if (reord?.ok) changed = true;
          }
        }
      }

      const activeOrderedCols = colGroup
        .filter((c) => c.deleted !== true && typeof c.sortOrder === 'number')
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.updatedAt - b.updatedAt)
        .map((c) => c.id);
      if (
        activeOrderedCols.length > 1 &&
        catalog.reorderCollections !== undefined &&
        !sameStringOrder(
          existingCols.map((c) => c.id),
          activeOrderedCols,
        )
      ) {
        const reord = await catalog.reorderCollections(activeOrderedCols, pidArg).catch(() => null);
        if (reord?.ok) changed = true;
      }
    }
  }

  // Watch progress
  if (catalog.saveProgress !== undefined) {
    for (const prog of snapshot.watchProgress) {
      const explicitPid = prog.profileId !== undefined ? { profileId: prog.profileId } : {};
      const existing =
        (prog.profileId !== undefined
          ? await catalog.getProgress?.(prog.key, prog.profileId).catch(() => null)
          : await catalog.getProgress?.(prog.key).catch(() => null)) ?? null;
      if (prog.deleted === true) {
        if (existing !== null && prog.updatedAt >= existing.updatedAt) {
          const cleared =
            prog.profileId !== undefined
              ? await catalog.clearProgress?.(prog.key, prog.profileId).catch(() => null)
              : await catalog.clearProgress?.(prog.key).catch(() => null);
          if (cleared?.ok) changed = true;
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
          : ((await catalog.itemDetail?.(prog.key, { parentalUnlocked: true }).catch(() => null)) ??
            null);
      const sourceId = existing?.sourceId ?? detail?.sourceId ?? sourceOfKey(prog.key);
      if (sourceId === undefined) continue;
      const res = await catalog
        .saveProgress({
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
        })
        .catch(() => null);
      if (res?.ok) changed = true;
    }
  }

  // Watched episode bitfields
  if (catalog.applyWatchedEpisodeBitfield !== undefined) {
    for (const bf of snapshot.watchedEpisodesBitfields) {
      if (bf.deleted === true || bf.bitsB64.length === 0) continue;
      const episodeIndices = decodeEpisodeBitfield(bf.bitsB64);
      if (episodeIndices.length === 0) continue;
      const res = await catalog
        .applyWatchedEpisodeBitfield({
          ...(bf.profileId !== undefined ? { profileId: bf.profileId } : {}),
          seriesKey: bf.seriesKey,
          ...(bf.season !== undefined ? { season: bf.season } : {}),
          episodeIndices,
          updatedAt: bf.updatedAt,
        })
        .catch(() => null);
      if (res?.ok && res.value > 0) changed = true;
    }
  }

  // Continue Watching dismissals (diffed before write so no-op syncs never trigger UI refreshes)
  if (
    catalog.setContinueWatchingDismissal !== undefined &&
    snapshot.continueWatchingDismissals &&
    snapshot.continueWatchingDismissals.length > 0
  ) {
    for (const [pid, disGroup] of groupByProfile(snapshot.continueWatchingDismissals)) {
      const existingDismissals =
        (await catalog.listContinueWatchingDismissals?.(pid).catch(() => [])) ?? [];
      const existingBySeries = new Map(existingDismissals.map((row) => [row.seriesKey, row]));
      for (const dis of disGroup) {
        const existing = existingBySeries.get(dis.seriesKey);
        if (dis.deleted) {
          if (existing === undefined || dis.dismissedAt < existing.dismissedAt) continue;
        } else if (existing !== undefined && existing.dismissedAt >= dis.dismissedAt) {
          continue;
        }
        const res = await catalog
          .setContinueWatchingDismissal(
            {
              profileId: dis.profileId,
              seriesKey: dis.seriesKey,
              sourceId: dis.sourceId,
              dismissedAt: dis.dismissedAt,
            },
            dis.deleted,
          )
          .catch(() => null);
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
          changed = true;
        }
      }
    }
  }

  // Ratings
  if (
    snapshot.ratings !== undefined &&
    snapshot.ratings.length > 0 &&
    catalog.setRating !== undefined
  ) {
    for (const [pid, ratingGroup] of groupByProfile(snapshot.ratings)) {
      const pidOpt = pid === DEFAULT_PROFILE_ID ? {} : { profileId: pid };
      const existingRatings =
        (await catalog
          .listRatings?.({ limit: 250, ...pidOpt, parentalUnlocked: true })
          .catch(() => [])) ?? [];
      const existingByKey = new Map(existingRatings.map((r) => [r.itemKey, r]));
      for (const rec of ratingGroup) {
        const existing = existingByKey.get(rec.key);
        const explicitPid = rec.profileId !== undefined ? { profileId: rec.profileId } : {};
        if (rec.deleted === true) {
          if (existing !== undefined && rec.updatedAt >= existing.updatedAt) {
            const cleared = await catalog
              .setRating(
                {
                  ...explicitPid,
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
              ...explicitPid,
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
  }

  if (changed) {
    await catalog.flushPendingWrites?.().catch(() => undefined);
  }
  return changed;
}
