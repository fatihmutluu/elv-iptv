import type {
  SyncCollection,
  SyncContinueWatchingDismissal,
  SyncCustomGroup,
  SyncEpisodeBitfield,
  SyncKeyedFlag,
  SyncProfileRecord,
  SyncRatingRecord,
  SyncSourceRecord,
  SyncWatchProgress,
  VaultSnapshot,
} from '@elv/sync';
import { VAULT_SCHEMA_VERSION } from '@elv/sync';
import { sourceFingerprint } from './snapshot-source-helpers.ts';

const TOMBSTONE_RETENTION_MS = 90 * 86_400_000;

function profileScope(profileId: string | undefined): string {
  return profileId !== undefined && profileId.length > 0 ? profileId : 'default';
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function isRetainedTombstone(ts: number, nowMs: number): boolean {
  return nowMs <= ts + TOMBSTONE_RETENTION_MS;
}

function reconcileKeyedItems<T extends { readonly updatedAt: number; readonly deleted?: boolean }>(
  fresh: readonly T[],
  previous: readonly T[],
  keyOf: (item: T) => string,
  contentSignature: (item: T) => string,
  nowMs: number,
): T[] {
  const prevMap = new Map<string, T>();
  for (const item of previous) {
    prevMap.set(keyOf(item), item);
  }
  const seen = new Set<string>();
  const out: T[] = [];

  for (const item of fresh) {
    const key = keyOf(item);
    seen.add(key);
    const prev = prevMap.get(key);
    if (prev !== undefined && prev.deleted !== true) {
      const changed = contentSignature(item) !== contentSignature(prev);
      if (changed && item.updatedAt <= prev.updatedAt) {
        out.push({ ...item, updatedAt: Math.max(nowMs, prev.updatedAt + 1) });
        continue;
      }
      if (!changed && item.updatedAt < prev.updatedAt) {
        out.push({ ...item, updatedAt: prev.updatedAt });
        continue;
      }
    } else if (prev !== undefined && prev.deleted === true && item.updatedAt <= prev.updatedAt) {
      out.push({ ...item, updatedAt: Math.max(nowMs, prev.updatedAt + 1) });
      continue;
    }
    out.push(item);
  }

  for (const [key, prev] of prevMap.entries()) {
    if (seen.has(key)) continue;
    if (prev.deleted === true) {
      if (isRetainedTombstone(prev.updatedAt, nowMs)) {
        out.push(prev);
      }
      continue;
    }
    out.push({
      ...prev,
      deleted: true,
      updatedAt: Math.max(nowMs, prev.updatedAt + 1),
    });
  }

  return out;
}

function sourceSig(s: SyncSourceRecord): string {
  return stableJson({
    kind: s.kind,
    name: s.name,
    url: s.url,
    username: s.username ?? null,
    password: s.password ?? null,
    portalUrl: s.portalUrl ?? null,
    mac: s.mac ?? null,
    serialNumber: s.serialNumber ?? null,
    epgUrl: s.epgUrl ?? null,
    headers: s.headers ?? null,
    settings: s.settings ?? null,
  });
}

function reconcileSources(
  fresh: readonly SyncSourceRecord[],
  previous: readonly SyncSourceRecord[],
  nowMs: number,
): SyncSourceRecord[] {
  const prevById = new Map<string, SyncSourceRecord>();
  const prevByFp = new Map<string, SyncSourceRecord>();
  for (const s of previous) {
    prevById.set(s.id, s);
    const fp = sourceFingerprint(s.kind, s.portalUrl ?? s.url, s.username, s.mac);
    if (!prevByFp.has(fp)) prevByFp.set(fp, s);
  }

  const matchedPrevIds = new Set<string>();
  const out: SyncSourceRecord[] = [];
  for (const item of fresh) {
    const fp = sourceFingerprint(item.kind, item.portalUrl ?? item.url, item.username, item.mac);
    const prev = prevById.get(item.id) ?? prevByFp.get(fp);
    if (prev !== undefined) {
      matchedPrevIds.add(prev.id);
      if (prev.deleted !== true) {
        const changed = sourceSig(item) !== sourceSig(prev);
        if (changed && item.updatedAt <= prev.updatedAt) {
          out.push({ ...item, updatedAt: Math.max(nowMs, prev.updatedAt + 1) });
          continue;
        }
        if (!changed && item.updatedAt < prev.updatedAt) {
          out.push({ ...item, updatedAt: prev.updatedAt });
          continue;
        }
      } else if (item.updatedAt <= prev.updatedAt) {
        out.push({ ...item, updatedAt: Math.max(nowMs, prev.updatedAt + 1) });
        continue;
      }
    }
    out.push(item);
  }

  for (const prev of previous) {
    if (matchedPrevIds.has(prev.id)) continue;
    if (prev.deleted === true) {
      if (isRetainedTombstone(prev.updatedAt, nowMs)) out.push(prev);
      continue;
    }
    out.push({
      ...prev,
      deleted: true,
      updatedAt: Math.max(nowMs, prev.updatedAt + 1),
    });
  }

  return out;
}

function reconcileDismissals(
  fresh: readonly SyncContinueWatchingDismissal[],
  previous: readonly SyncContinueWatchingDismissal[],
  nowMs: number,
): SyncContinueWatchingDismissal[] {
  const prevMap = new Map<string, SyncContinueWatchingDismissal>();
  for (const d of previous) {
    prevMap.set(`${profileScope(d.profileId)}\u0000${d.seriesKey}`, d);
  }
  const seen = new Set<string>();
  const out: SyncContinueWatchingDismissal[] = [];
  for (const d of fresh) {
    const key = `${profileScope(d.profileId)}\u0000${d.seriesKey}`;
    seen.add(key);
    const prev = prevMap.get(key);
    if (prev?.deleted && d.dismissedAt <= prev.dismissedAt) {
      out.push({ ...d, dismissedAt: Math.max(nowMs, prev.dismissedAt + 1) });
    } else {
      out.push(d);
    }
  }
  for (const [key, prev] of prevMap.entries()) {
    if (seen.has(key)) continue;
    if (prev.deleted) {
      if (isRetainedTombstone(prev.dismissedAt, nowMs)) out.push(prev);
      continue;
    }
    out.push({
      ...prev,
      deleted: true,
      dismissedAt: Math.max(nowMs, prev.dismissedAt + 1),
    });
  }
  return out;
}

function reconcileProfiles(
  fresh: readonly SyncProfileRecord[] | undefined,
  previous: readonly SyncProfileRecord[] | undefined,
  nowMs: number,
): SyncProfileRecord[] | undefined {
  if (fresh === undefined && previous === undefined) return undefined;
  return reconcileKeyedItems(
    fresh ?? [],
    previous ?? [],
    (p) => p.id,
    (p) =>
      stableJson({
        name: p.name,
        avatarToken: p.avatarToken,
        isKids: p.isKids,
        isDefault: p.isDefault,
        pinHash: p.pinHash ?? null,
        parentalEnabled: p.parentalEnabled ?? false,
        parentalMaxRating: p.parentalMaxRating ?? null,
      }),
    nowMs,
  );
}

/**
 * Compares a freshly exported local {@link VaultSnapshot} against the last synced baseline snapshot
 * to synthesize `deleted: true` tombstones for rows removed from SQLite and bump LWW timestamps
 * when non-timestamped local mutations occur (source renames, settings edits, favorite reorders,
 * collection item removals, or profile PIN changes).
 */
export function reconcileLocalSnapshotWithBaseline(
  fresh: VaultSnapshot,
  previous: VaultSnapshot | undefined,
  nowMs: number,
): VaultSnapshot {
  if (previous === undefined || previous.updatedAt === 0) {
    return fresh;
  }

  const flagKey = (f: SyncKeyedFlag): string => `${profileScope(f.profileId)}\u0000${f.key}`;
  const flagSig = (f: SyncKeyedFlag): string => stableJson({ sortOrder: f.sortOrder ?? null });

  const sources = reconcileSources(fresh.sources, previous.sources, nowMs);
  const favorites = reconcileKeyedItems(
    fresh.favorites,
    previous.favorites,
    flagKey,
    flagSig,
    nowMs,
  );
  const hiddenChannels = reconcileKeyedItems(
    fresh.hiddenChannels,
    previous.hiddenChannels,
    flagKey,
    flagSig,
    nowMs,
  );
  const pinnedChannels = reconcileKeyedItems(
    fresh.pinnedChannels,
    previous.pinnedChannels,
    flagKey,
    flagSig,
    nowMs,
  );
  const customGroups = reconcileKeyedItems<SyncCustomGroup>(
    fresh.customGroups,
    previous.customGroups,
    (g) => g.id,
    (g) => stableJson({ name: g.name, sortOrder: g.sortOrder, channelKeys: g.channelKeys }),
    nowMs,
  );
  const collections = reconcileKeyedItems<SyncCollection>(
    fresh.collections,
    previous.collections,
    (c) => c.id,
    (c) =>
      stableJson({
        name: c.name,
        profileId: profileScope(c.profileId),
        sortOrder: c.sortOrder ?? null,
        itemKeys: c.itemKeys,
      }),
    nowMs,
  );
  const watchProgress = reconcileKeyedItems<SyncWatchProgress>(
    fresh.watchProgress,
    previous.watchProgress,
    (w) => `${profileScope(w.profileId)}\u0000${w.key}`,
    (w) =>
      stableJson({
        positionMs: w.positionMs,
        durationMs: w.durationMs,
        completed: w.completed || w.watched === true,
      }),
    nowMs,
  );
  const watchedEpisodesBitfields = reconcileKeyedItems<SyncEpisodeBitfield>(
    fresh.watchedEpisodesBitfields,
    previous.watchedEpisodesBitfields,
    (b) => `${profileScope(b.profileId)}\u0000${b.seriesKey}\u0000${b.season ?? ''}`,
    (b) => b.bitsB64,
    nowMs,
  );
  const dismissals = reconcileDismissals(
    fresh.continueWatchingDismissals ?? [],
    previous.continueWatchingDismissals ?? [],
    nowMs,
  );
  const ratings = reconcileKeyedItems<SyncRatingRecord>(
    fresh.ratings ?? [],
    previous.ratings ?? [],
    (r) => `${profileScope(r.profileId)}\u0000${r.key}`,
    (r) => stableJson({ value: r.value, title: r.title }),
    nowMs,
  );
  const profiles = reconcileProfiles(fresh.profiles, previous.profiles, nowMs);

  return {
    ...fresh,
    schemaVersion: VAULT_SCHEMA_VERSION,
    updatedAt: Math.max(fresh.updatedAt, nowMs),
    sources,
    favorites,
    hiddenChannels,
    pinnedChannels,
    customGroups,
    collections,
    watchProgress,
    watchedEpisodesBitfields,
    ...(dismissals.length > 0 ? { continueWatchingDismissals: dismissals } : {}),
    ...(ratings.length > 0 ? { ratings } : {}),
    ...(profiles !== undefined && profiles.length > 0 ? { profiles } : {}),
  };
}
