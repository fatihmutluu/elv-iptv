import {
  guideSecret,
  type SourceCategorySelection,
  type SourceRecord,
  type SourceRow,
  type SourceSettings,
  secretKey,
} from '@elv/data';
import type { Result, SecretStore, TransportSettings } from '@elv/domain';
import type { SyncSourceRecord, SyncSourceSettings } from '@elv/sync';
import type { CatalogRpcMethodCall } from '../../shared/catalog-ipc.ts';

const SAFE_SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Parsed Xtream credential JSON read from `SecretStore` (`source.<id>.xtream`). */
interface ParsedXtreamSecret {
  readonly server: string;
  readonly username: string;
  readonly password: string;
  readonly backupServers?: readonly string[];
}

/** Parsed Stalker credential JSON read from `SecretStore` (`source.<id>.stalker`). */
interface ParsedStalkerSecret {
  readonly portalUrl: string;
  readonly mac: string;
  readonly serialNumber?: string;
}

/** Parses Xtream credentials and optional failover `backupServers` from `SecretStore` JSON. */
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
    const backupServers = Array.isArray(rec.backupServers)
      ? rec.backupServers
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .map((v) => v.trim())
      : undefined;
    return {
      server: rec.server.trim(),
      username: rec.username.trim(),
      password: rec.password,
      ...(backupServers !== undefined && backupServers.length > 0 ? { backupServers } : {}),
    };
  } catch {
    return null;
  }
}

/** Parses Stalker / Ministra portal credentials from `SecretStore` JSON. */
function parseStalkerSecret(raw: string | undefined): ParsedStalkerSecret | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (
      typeof rec.portalUrl !== 'string' ||
      rec.portalUrl.trim().length === 0 ||
      typeof rec.mac !== 'string' ||
      rec.mac.trim().length === 0
    ) {
      return null;
    }
    const serialNumber =
      typeof rec.serialNumber === 'string' && rec.serialNumber.trim().length > 0
        ? rec.serialNumber.trim()
        : undefined;
    return {
      portalUrl: rec.portalUrl.trim(),
      mac: rec.mac.trim(),
      ...(serialNumber !== undefined ? { serialNumber } : {}),
    };
  } catch {
    return null;
  }
}

/** Extracts the user-configured XMLTV guide URL (`g:url`) from `source.<id>.urlvars` JSON. */
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

/** Computes a deterministic deduplication fingerprint for an M3U, Xtream, or Stalker source. */
export function sourceFingerprint(
  kind: 'm3u' | 'xtream' | 'stalker',
  url: string,
  username?: string,
  mac?: string,
): string {
  const normalizedUrl = url.trim().replace(/\/+$/, '').toLowerCase();
  if (kind === 'xtream') {
    return `xtream|${normalizedUrl}|${(username ?? '').trim().toLowerCase()}`;
  }
  if (kind === 'stalker') {
    return `stalker|${normalizedUrl}|${(mac ?? '').trim().toUpperCase()}`;
  }
  return `m3u|${normalizedUrl}`;
}

function parseJsonObject<T>(raw: string | undefined): T | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {
    // Ignore malformed JSON.
  }
  return undefined;
}

/** Builds optional {@link SyncSourceSettings} from SQLite `SourceSettings` + Xtream `backupServers`. */
function buildSyncSourceSettings(
  settings: SourceSettings | undefined,
  backupServers?: readonly string[],
): SyncSourceSettings | undefined {
  const out: {
    excludedProfileIds?: readonly string[];
    epgShiftMs?: number;
    xmltvTimezone?: string;
    categorySelectionJson?: string;
    transportJson?: string;
    backupServers?: readonly string[];
  } = {};
  if (settings?.excludedProfileIds !== undefined && settings.excludedProfileIds.length > 0) {
    out.excludedProfileIds = [...settings.excludedProfileIds];
  }
  if (typeof settings?.epgShiftMs === 'number' && Number.isFinite(settings.epgShiftMs)) {
    out.epgShiftMs = settings.epgShiftMs;
  }
  if (typeof settings?.xmltvTimezone === 'string' && settings.xmltvTimezone.trim().length > 0) {
    out.xmltvTimezone = settings.xmltvTimezone.trim();
  }
  if (
    settings?.categorySelection !== undefined &&
    Object.keys(settings.categorySelection).length > 0
  ) {
    out.categorySelectionJson = JSON.stringify(settings.categorySelection);
  }
  if (settings?.transport !== undefined && Object.keys(settings.transport).length > 0) {
    out.transportJson = JSON.stringify(settings.transport);
  }
  if (backupServers !== undefined && backupServers.length > 0) {
    out.backupServers = [...backupServers];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type RpcCaller = <R>(rpc: CatalogRpcMethodCall) => Promise<R>;

interface LoadedSourceEntry {
  readonly id: string;
  readonly kind: 'm3u' | 'xtream' | 'stalker';
  readonly name: string;
  readonly createdAt: number;
  readonly isLocalPlaylist: boolean;
  readonly settings: SourceSettings;
}

async function loadExistingSources(call: RpcCaller): Promise<LoadedSourceEntry[]> {
  const [rawRecords, rawRows] = await Promise.all([
    call<unknown>({ method: 'listSourceRecords' }).catch(() => []),
    call<unknown>({ method: 'listSources' }).catch(() => []),
  ]);
  const records = Array.isArray(rawRecords) ? (rawRecords as SourceRecord[]) : [];
  const rows = Array.isArray(rawRows) ? (rawRows as SourceRow[]) : [];
  if (records.length > 0) {
    return records.map((rec) => ({
      id: rec.id,
      kind: rec.kind,
      name: rec.name,
      createdAt: rec.createdAt,
      isLocalPlaylist: rec.settings.isLocalPlaylist === true,
      settings: rec.settings,
    }));
  }
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.createdAt,
    isLocalPlaylist: row.isLocalPlaylist === true,
    settings: {
      ...(row.excludedProfileIds !== undefined && row.excludedProfileIds.length > 0
        ? { excludedProfileIds: row.excludedProfileIds }
        : {}),
      ...(row.xmltvTimezone !== undefined ? { xmltvTimezone: row.xmltvTimezone } : {}),
    },
  }));
}

/** Exports all non-local M3U, Xtream, and Stalker sources reading secrets strictly from `SecretStore`. */
export async function exportDesktopSources(
  call: RpcCaller,
  secretStore: Pick<SecretStore, 'get'>,
): Promise<SyncSourceRecord[]> {
  const entries = await loadExistingSources(call);
  const sources: SyncSourceRecord[] = [];

  for (const entry of entries) {
    const rawUrlVars = await secretStore.get(secretKey(entry.id, 'urlvars')).catch(() => undefined);
    const epgUrl = parseGuideUrlFromUrlVars(rawUrlVars);

    if (entry.kind === 'xtream') {
      const parsed = parseXtreamSecret(
        await secretStore.get(secretKey(entry.id, 'xtream')).catch(() => undefined),
      );
      if (parsed === null) continue;
      const syncSettings = buildSyncSourceSettings(entry.settings, parsed.backupServers);
      sources.push({
        id: entry.id,
        kind: 'xtream',
        name: entry.name,
        url: parsed.server,
        username: parsed.username,
        password: parsed.password,
        ...(epgUrl !== undefined ? { epgUrl } : {}),
        ...(syncSettings !== undefined ? { settings: syncSettings } : {}),
        updatedAt: entry.createdAt,
      });
    } else if (entry.kind === 'stalker') {
      const parsed = parseStalkerSecret(
        await secretStore.get(secretKey(entry.id, 'stalker')).catch(() => undefined),
      );
      if (parsed === null) continue;
      const syncSettings = buildSyncSourceSettings(entry.settings);
      sources.push({
        id: entry.id,
        kind: 'stalker',
        name: entry.name,
        url: parsed.portalUrl,
        portalUrl: parsed.portalUrl,
        mac: parsed.mac,
        ...(parsed.serialNumber !== undefined ? { serialNumber: parsed.serialNumber } : {}),
        ...(epgUrl !== undefined ? { epgUrl } : {}),
        ...(syncSettings !== undefined ? { settings: syncSettings } : {}),
        updatedAt: entry.createdAt,
      });
    } else if (entry.kind === 'm3u' && !entry.isLocalPlaylist) {
      const rawPlaylist = await secretStore
        .get(secretKey(entry.id, 'playlist'))
        .catch(() => undefined);
      const playlistUrl = rawPlaylist?.trim() ?? '';
      if (playlistUrl.length === 0) continue;
      const syncSettings = buildSyncSourceSettings(entry.settings);
      sources.push({
        id: entry.id,
        kind: 'm3u',
        name: entry.name,
        url: playlistUrl,
        ...(epgUrl !== undefined ? { epgUrl } : {}),
        ...(syncSettings !== undefined ? { settings: syncSettings } : {}),
        updatedAt: entry.createdAt,
      });
    }
  }

  return sources;
}

/** Applies synced M3U, Xtream, and Stalker sources (adds, tombstones, and LWW updates on existing sources). */
export async function applyDesktopSources(
  sources: readonly SyncSourceRecord[],
  call: RpcCaller,
  secretStore: Pick<SecretStore, 'get' | 'set' | 'delete'>,
): Promise<boolean> {
  let mutated = false;
  const entries = await loadExistingSources(call);
  const existingById = new Map<string, LoadedSourceEntry>();
  const existingByFp = new Map<string, LoadedSourceEntry>();

  for (const entry of entries) {
    existingById.set(entry.id, entry);
    if (entry.kind === 'xtream') {
      const parsed = parseXtreamSecret(
        await secretStore.get(secretKey(entry.id, 'xtream')).catch(() => undefined),
      );
      if (parsed !== null) {
        existingByFp.set(sourceFingerprint('xtream', parsed.server, parsed.username), entry);
      }
    } else if (entry.kind === 'stalker') {
      const parsed = parseStalkerSecret(
        await secretStore.get(secretKey(entry.id, 'stalker')).catch(() => undefined),
      );
      if (parsed !== null) {
        existingByFp.set(
          sourceFingerprint('stalker', parsed.portalUrl, undefined, parsed.mac),
          entry,
        );
      }
    } else if (entry.kind === 'm3u' && !entry.isLocalPlaylist) {
      const url = await secretStore.get(secretKey(entry.id, 'playlist')).catch(() => undefined);
      if (url && url.trim().length > 0) {
        existingByFp.set(sourceFingerprint('m3u', url), entry);
      }
    }
  }

  for (const src of sources) {
    const fp = sourceFingerprint(src.kind, src.portalUrl ?? src.url, src.username, src.mac);
    const existing = existingById.get(src.id) ?? existingByFp.get(fp);

    if (src.deleted === true) {
      if (existing !== undefined && src.updatedAt >= existing.createdAt) {
        const removed = await call<Result<void>>({ method: 'removeSource', id: existing.id }).catch(
          () => null,
        );
        if (removed?.ok) {
          existingById.delete(existing.id);
          existingByFp.delete(fp);
          mutated = true;
        }
      }
      continue;
    }

    const transport = parseJsonObject<TransportSettings>(src.settings?.transportJson);
    const categorySelection = parseJsonObject<SourceCategorySelection>(
      src.settings?.categorySelectionJson,
    );

    if (existing === undefined) {
      const explicitId = SAFE_SOURCE_ID_RE.test(src.id.trim()) ? { id: src.id.trim() } : {};
      let addedId: string | undefined;
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
            ...explicitId,
            kind: 'xtream',
            name: src.name,
            server: src.url,
            username: src.username,
            password: src.password,
            ...(src.epgUrl ? { guideUrl: src.epgUrl } : {}),
            ...(src.settings?.backupServers?.length
              ? { backupServers: [...src.settings.backupServers] }
              : {}),
            ...(src.settings?.xmltvTimezone ? { xmltvTimezone: src.settings.xmltvTimezone } : {}),
            ...(transport !== undefined ? { transport } : {}),
          },
        }).catch(() => null);
        if (added?.ok) addedId = added.value.id;
      } else if (
        src.kind === 'stalker' &&
        (src.portalUrl ?? src.url).trim().length > 0 &&
        typeof src.mac === 'string' &&
        src.mac.trim().length > 0
      ) {
        const added = await call<Result<SourceRow>>({
          method: 'addSource',
          input: {
            ...explicitId,
            kind: 'stalker',
            name: src.name,
            portalUrl: (src.portalUrl ?? src.url).trim(),
            mac: src.mac.trim(),
            ...(src.serialNumber ? { serialNumber: src.serialNumber } : {}),
            ...(src.epgUrl ? { guideUrl: src.epgUrl } : {}),
            ...(src.settings?.xmltvTimezone ? { xmltvTimezone: src.settings.xmltvTimezone } : {}),
            ...(transport !== undefined ? { transport } : {}),
          },
        }).catch(() => null);
        if (added?.ok) addedId = added.value.id;
      } else if (src.kind === 'm3u' && src.url.trim().length > 0) {
        const added = await call<Result<SourceRow>>({
          method: 'addSource',
          input: {
            ...explicitId,
            kind: 'm3u',
            name: src.name,
            playlistUrl: src.url,
            ...(src.epgUrl ? { guideUrl: src.epgUrl } : {}),
            ...(src.settings?.xmltvTimezone ? { xmltvTimezone: src.settings.xmltvTimezone } : {}),
            ...(transport !== undefined ? { transport } : {}),
          },
        }).catch(() => null);
        if (added?.ok) addedId = added.value.id;
      }

      if (addedId !== undefined) {
        mutated = true;
        const addedEntry: LoadedSourceEntry = {
          id: addedId,
          kind: src.kind,
          name: src.name,
          createdAt: src.updatedAt,
          isLocalPlaylist: false,
          settings: {},
        };
        existingById.set(addedId, addedEntry);
        existingByFp.set(fp, addedEntry);
        if (src.settings?.excludedProfileIds?.length) {
          await call<Result<SourceRow>>({
            method: 'setSourceExcludedProfiles',
            sourceId: addedId,
            excludedProfileIds: [...src.settings.excludedProfileIds],
          }).catch(() => null);
        }
        const postPatch: Partial<SourceSettings> = {};
        if (src.settings?.epgShiftMs !== undefined) postPatch.epgShiftMs = src.settings.epgShiftMs;
        if (categorySelection !== undefined) postPatch.categorySelection = categorySelection;
        if (Object.keys(postPatch).length > 0) {
          await call<Result<void>>({
            method: 'updateSourceSettings',
            sourceId: addedId,
            patch: postPatch,
          }).catch(() => null);
        }
      }
      continue;
    }

    // Apply LWW field diffs on existing sources regardless of local createdAt skew across devices.
    if (src.name.trim().length > 0 && src.name !== existing.name) {
      const renamed = await call<Result<SourceRow>>({
        method: 'renameSource',
        sourceId: existing.id,
        name: src.name,
      }).catch(() => null);
      if (renamed?.ok) mutated = true;
    }

    const nextExcluded = src.settings?.excludedProfileIds ?? [];
    const prevExcluded = existing.settings.excludedProfileIds ?? [];
    if (!arraysEqual(nextExcluded, prevExcluded)) {
      const updated = await call<Result<SourceRow>>({
        method: 'setSourceExcludedProfiles',
        sourceId: existing.id,
        excludedProfileIds: [...nextExcluded],
      }).catch(() => null);
      if (updated?.ok) mutated = true;
    }

    const settingsPatch: Partial<SourceSettings> = {};
    const nextEpgShift = src.settings?.epgShiftMs ?? 0;
    const prevEpgShift = existing.settings.epgShiftMs ?? 0;
    if (nextEpgShift !== prevEpgShift) {
      settingsPatch.epgShiftMs = nextEpgShift;
    }
    if (
      src.settings?.xmltvTimezone !== undefined &&
      src.settings.xmltvTimezone !== existing.settings.xmltvTimezone
    ) {
      settingsPatch.xmltvTimezone = src.settings.xmltvTimezone;
    }
    if (
      categorySelection !== undefined &&
      JSON.stringify(categorySelection) !== JSON.stringify(existing.settings.categorySelection)
    ) {
      settingsPatch.categorySelection = categorySelection;
    }
    if (
      transport !== undefined &&
      JSON.stringify(transport) !== JSON.stringify(existing.settings.transport)
    ) {
      settingsPatch.transport = transport;
    }

    // Credentials & backupServers updated strictly inside SecretStore
    if (
      src.kind === 'xtream' &&
      src.url.trim().length > 0 &&
      typeof src.username === 'string' &&
      typeof src.password === 'string'
    ) {
      const prevSecret = parseXtreamSecret(
        await secretStore.get(secretKey(existing.id, 'xtream')).catch(() => undefined),
      );
      const nextBackups = src.settings?.backupServers ?? [];
      const prevBackups = prevSecret?.backupServers ?? [];
      if (
        prevSecret === null ||
        prevSecret.server !== src.url ||
        prevSecret.username !== src.username ||
        prevSecret.password !== src.password ||
        !arraysEqual(nextBackups, prevBackups)
      ) {
        await secretStore.set(
          secretKey(existing.id, 'xtream'),
          JSON.stringify({
            server: src.url,
            username: src.username,
            password: src.password,
            ...(nextBackups.length > 0 ? { backupServers: [...nextBackups] } : {}),
          }),
        );
        mutated = true;
      }
    } else if (src.kind === 'stalker' && src.mac) {
      const prevSecret = parseStalkerSecret(
        await secretStore.get(secretKey(existing.id, 'stalker')).catch(() => undefined),
      );
      const nextPortal = (src.portalUrl ?? src.url).trim();
      if (
        prevSecret === null ||
        prevSecret.portalUrl !== nextPortal ||
        prevSecret.mac !== src.mac ||
        prevSecret.serialNumber !== src.serialNumber
      ) {
        await secretStore.set(
          secretKey(existing.id, 'stalker'),
          JSON.stringify({
            portalUrl: nextPortal,
            mac: src.mac,
            ...(src.serialNumber ? { serialNumber: src.serialNumber } : {}),
          }),
        );
        mutated = true;
      }
    } else if (src.kind === 'm3u' && src.url.trim().length > 0) {
      const prevUrl = await secretStore
        .get(secretKey(existing.id, 'playlist'))
        .catch(() => undefined);
      if (prevUrl !== src.url) {
        await secretStore.set(secretKey(existing.id, 'playlist'), src.url);
        mutated = true;
      }
    }

    const prevRawVars = await secretStore
      .get(secretKey(existing.id, 'urlvars'))
      .catch(() => undefined);
    const prevEpgUrl = parseGuideUrlFromUrlVars(prevRawVars);
    if (src.epgUrl !== undefined && src.epgUrl !== prevEpgUrl) {
      const g = guideSecret(src.epgUrl);
      const vars = parseJsonObject<Record<string, string>>(prevRawVars) ?? {};
      await secretStore.set(
        secretKey(existing.id, 'urlvars'),
        JSON.stringify({ ...vars, ...g.vars }),
      );
      settingsPatch.guideUrl = g.template;
      mutated = true;
    }

    if (Object.keys(settingsPatch).length > 0) {
      const patched = await call<Result<void>>({
        method: 'updateSourceSettings',
        sourceId: existing.id,
        patch: settingsPatch,
      }).catch(() => null);
      if (patched?.ok) mutated = true;
    }
  }

  return mutated;
}
