import {
  type ElvError,
  elvError,
  err,
  normalizeDnsFamily,
  normalizeMacAddress,
  ok,
  type Result,
  type Scheduler,
  type SecretStore,
  type SourceKind,
  type SqlDriver,
  type TransportSettings,
  validateHostOverride,
} from '@elv/domain';
import { normalizeStalkerPortalUrl } from '@elv/sources';
import { fingerprintStalkerCredentials } from './credential-fingerprint';
import { pruneSourceFailoverMembersInTx } from './failover-groups-repo';
import { deleteStalkerCmdMap } from './stalker-cmds-store';
import type { SegmentRule, UrlVars } from './templates';
import { deleteUrlVars } from './urlvars-store';

/** Kind of source a user can add. */
export type { SourceKind };

/** Non-secret HTTP cache validators stored per opaque slot for conditional GET requests. */
export interface HttpCacheValidator {
  etag?: string;
  lastModified?: string;
}

/** Non-secret HTTP cache validators keyed strictly by opaque slot names (never URLs or credentials). */
export interface SourceHttpCache {
  playlist?: HttpCacheValidator;
  guide?: Record<string, HttpCacheValidator>;
}

/** Non-secret Xtream account lifecycle metadata persisted for expiry/trial/connection indicators (`#170`, `#87`). */
export interface SourceAccountMeta {
  isTrial?: boolean;
  expiresAt?: number;
  /** Normalized maximum concurrent streams allowed by the source (`>= 1`, default `1`, `#87`). */
  maxConnections?: number;
  /** Last provider-reported active connection count when supplied by Xtream `user_info.active_cons` (`#87`). */
  activeConnections?: number;
}

const STRICT_NUMERIC_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Coerces a provider-reported `max_connections` value into a safe integer `>= 1` (`#87`).
 * Missing, `0`, negative, empty, non-finite, or non-numeric values default conservatively to `1`
 * (M3U sources also default to `1`).
 */
export function normalizeMaxConnections(raw: unknown): number {
  let num: number;
  if (typeof raw === 'number') {
    num = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!STRICT_NUMERIC_RE.test(trimmed)) return 1;
    num = Number(trimmed);
  } else {
    return 1;
  }
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.floor(num));
}

/**
 * Parses an optional provider-reported `active_cons` count (`>= 0`) without ever guessing when
 * missing, empty, negative, or non-numeric (`#87`).
 */
export function normalizeActiveConnections(raw: unknown): number | undefined {
  let num: number;
  if (typeof raw === 'number') {
    num = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!STRICT_NUMERIC_RE.test(trimmed)) return undefined;
    num = Number(trimmed);
  } else {
    return undefined;
  }
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.floor(num);
}

/** Per-source category allowlist and pending-new-category tracking (`#39`). */
export interface SourceCategorySelection {
  readonly live?: readonly string[];
  readonly movie?: readonly string[];
  readonly series?: readonly string[];
  readonly knownLive?: readonly string[];
  readonly knownMovie?: readonly string[];
  readonly knownSeries?: readonly string[];
  readonly pendingLive?: readonly string[];
  readonly pendingMovie?: readonly string[];
  readonly pendingSeries?: readonly string[];
}

/** Sandboxed local M3U playlist byte storage keyed strictly by `sourceId` (never raw host paths, `#51`). */
export interface LocalPlaylistStore {
  write(sourceId: string, bytes: Uint8Array): Promise<void>;
  openRead(sourceId: string): Promise<AsyncIterable<Uint8Array> | undefined>;
  remove(sourceId: string): Promise<void>;
}

/** Non-secret, per-source settings stored as JSON in the `sources` table. */
export interface SourceSettings {
  transport?: TransportSettings;
  /** User guide URL override: only the placeholder `{{g:url}}`; the URL lives in `source.<id>.urlvars`. */
  guideUrl?: string;
  vodPlaylist?: boolean;
  segmentRules?: SegmentRule[];
  guideWindow?: { daysBack: number; daysForward: number };
  /** Guide URLs found in the playlist header, as placeholders `{{g:d<n>}}` whose URLs live in `source.<id>.urlvars`. */
  discoveredGuideUrls?: string[];
  /** Allowed live output formats advertised by an Xtream panel's `user_info` (`ts`, `m3u8`). */
  outputFormats?: string[];
  /** Non-secret HTTP cache validators keyed strictly by opaque slot names. */
  httpCache?: SourceHttpCache;
  /** When true, keep provider offline/separator placeholder live channels during catalog import. */
  includePlaceholderChannels?: boolean;
  /** Non-secret Xtream account trial/expiry metadata persisted for Sources UI warnings (`#170`). */
  accountMeta?: SourceAccountMeta;
  /** Non-reversible SHA-256 credential fingerprint (`fp:<64-hex>`) for cross-source pooling (`#265`). */
  credentialFingerprint?: string;
  /** Optional source-wide EPG time shift in milliseconds applied at query time (`#121`). */
  epgShiftMs?: number;
  /** Optional default IANA timezone (e.g. `Europe/Berlin`) for offset-less XMLTV timestamps (`#182`). */
  xmltvTimezone?: string;
  /** Optional IANA timezone reported by Xtream `server_info.timezone` for play-time catch-up URL formatting (`#220`). */
  serverTimezone?: string;
  /** Optional pre-import category selection & pending-category tracking (`#39`). */
  categorySelection?: SourceCategorySelection;
  /** Marks a local sandboxed M3U source whose bytes are stored in {@link LocalPlaylistStore} (`#51`). */
  isLocalPlaylist?: boolean;
}

/** A row of the `sources` table. */
export interface SourceRecord {
  id: string;
  kind: SourceKind;
  name: string;
  createdAt: number;
  settings: SourceSettings;
}

/** Input for {@link addXtreamSource}. */
export interface XtreamSourceInput {
  name: string;
  server: string;
  /** Optional ordered failover mirror URLs stored strictly in SecretStore (`#317`). */
  readonly backupServers?: readonly string[];
  username: string;
  password: string;
  transport?: TransportSettings;
  /** User guide override, stored whole as a secret like an M3U guide URL. */
  guideUrl?: string;
  /** Optional default IANA timezone for offset-less XMLTV timestamps (`#182`). */
  readonly xmltvTimezone?: string;
}

/** Input for {@link addM3uSource}. */
export interface M3uSourceInput {
  name: string;
  playlistUrl: string;
  guideUrl?: string;
  vodPlaylist?: boolean;
  transport?: TransportSettings;
  /** Optional default IANA timezone for offset-less XMLTV timestamps (`#182`). */
  readonly xmltvTimezone?: string;
}

/** Input for {@link addLocalM3uSource} (`#51`). */
export interface LocalM3uSourceInput {
  name: string;
  bytes: Uint8Array;
  guideUrl?: string;
  vodPlaylist?: boolean;
  transport?: TransportSettings;
  /** Optional default IANA timezone for offset-less XMLTV timestamps (`#182`). */
  readonly xmltvTimezone?: string;
}

/** Input for {@link addStalkerSource} (`#29`). */
export interface StalkerSourceInput {
  name: string;
  portalUrl: string;
  mac: string;
  serialNumber?: string;
  transport?: TransportSettings;
  /** Optional custom XMLTV guide URL override stored strictly in `SecretStore`. */
  guideUrl?: string;
  /** Optional default IANA timezone for offset-less XMLTV timestamps (`#182`). */
  readonly xmltvTimezone?: string;
}

/** Collaborators for adding a source; `newId` and `clock` are injected so tests stay deterministic. */
export interface AddSourceDeps {
  db: SqlDriver;
  secrets: SecretStore;
  clock: () => number;
  /** A new unique id made of {@link SOURCE_ID} characters (a UUID fits); others are `storage/invalid-source-id`. */
  newId: () => string;
}

/** Staging tables populated during catalog import before atomic commit (`#418`). */
export const STAGED_CATALOG_TABLES = [
  'categories_next',
  'live_next',
  'movies_next',
  'series_next',
  'episodes_next',
  'placements_next',
] as const;

/** Default maximum rows deleted per transaction during budgeted source removal (`#138`). */
export const DEFAULT_DELETE_CHUNK_SIZE = 2_000;

interface BulkDeleteSpec {
  readonly table: string;
  readonly sql: string;
  readonly repeatId: boolean;
}

const ROWID_DELETE_TABLES = ['import_runs', 'live', 'movies', 'series', 'episodes'] as const;

const WITHOUT_ROWID_DELETE_SPECS: readonly (readonly [string, string])[] = [
  ['categories', '(kind, provider_id)'],
  ['categories_next', '(kind, provider_id)'],
  ['live_next', 'key'],
  ['movies_next', 'key'],
  ['series_next', 'key'],
  ['episodes_next', 'key'],
  ['placements', '(kind, category_id, item_key)'],
  ['placements_next', '(kind, category_id, item_key)'],
  ['guide_channels', 'guide_id'],
  ['channel_guide', 'channel_key'],
  ['channel_guide_overrides', 'channel_key'],
  ['programmes', '(guide_id, start)'],
  ['programmes_next', '(guide_id, start)'],
];

const BULK_DELETE_SPECS: readonly BulkDeleteSpec[] = [
  ...ROWID_DELETE_TABLES.map((table) => ({
    table,
    sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE source_id = ? LIMIT ?)`,
    repeatId: false,
  })),
  ...WITHOUT_ROWID_DELETE_SPECS.map(([table, cols]) => {
    const inner = cols.startsWith('(') ? cols.slice(1, -1) : cols;
    return {
      table,
      sql: `DELETE FROM ${table} WHERE source_id = ? AND ${cols} IN (SELECT ${inner} FROM ${table} WHERE source_id = ? LIMIT ?)`,
      repeatId: true,
    };
  }),
];

/** Every table with a `source_id` column; {@link removeSource} clears them all (no foreign keys). */
export const TABLES_BY_SOURCE: readonly string[] = [
  ...ROWID_DELETE_TABLES,
  ...WITHOUT_ROWID_DELETE_SPECS.map(([table]) => table),
  'programmes_fts',
  'watch_progress',
  'favorites',
  'track_preferences',
  'recent_channels',
  'parental_locks',
  'channel_overrides',
  'custom_group_items',
  'guide_sources',
  'programme_reminders',
  'failover_group_members',
  'vod_enrichment',
  'vod_collection_items',
];
const NON_SHARDED_PARTS = ['xtream', 'playlist', 'stalker'] as const;

/** Characters a source id may use: the set every platform secret store accepts in a key. */
export const SOURCE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Secret keys: `source.<id>.xtream` (JSON server, username, password), `.playlist`, `.urlvars` (JSON
 * {@link UrlVars}), `.stalker` (JSON portalUrl, mac, optional serialNumber), `.stalker_cmds` (JSON
 * opaque Stalker command map). Only letters, digits, `.`, `-` and `_`, the set the strictest platform
 * secret store allows.
 */
export function secretKey(
  id: string,
  part: 'xtream' | 'playlist' | 'urlvars' | 'stalker' | 'stalker_cmds',
): string {
  return `source.${id}.${part}`;
}

const invalid = (): Result<never> => err(elvError('source-format', 'invalid-source'));

function sanitizeTransportSettings(
  transport: TransportSettings | undefined,
): Result<TransportSettings | undefined> {
  if (transport === undefined) return ok(undefined);
  const hostRes = validateHostOverride(transport.hostOverride);
  if (!hostRes.ok) return hostRes;
  const dnsFamily = normalizeDnsFamily(transport.dnsFamily);
  const cleaned: {
    userAgent?: string;
    referer?: string;
    xtreamFormat?: 'ts' | 'm3u8';
    allowLegacyTls?: boolean;
    dnsFamily?: ReturnType<typeof normalizeDnsFamily>;
    hostOverride?: string;
  } = {};
  if (transport.userAgent !== undefined) cleaned.userAgent = transport.userAgent;
  if (transport.referer !== undefined) cleaned.referer = transport.referer;
  if (transport.xtreamFormat !== undefined) cleaned.xtreamFormat = transport.xtreamFormat;
  if (typeof transport.allowLegacyTls === 'boolean') {
    cleaned.allowLegacyTls = transport.allowLegacyTls;
  }
  if (dnsFamily !== undefined) cleaned.dnsFamily = dnsFamily;
  if (hostRes.value !== undefined) cleaned.hostOverride = hostRes.value;
  return ok(Object.keys(cleaned).length > 0 ? (cleaned as TransportSettings) : undefined);
}

function normalizeBackupServers(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function persist(
  deps: AddSourceDeps,
  record: SourceRecord,
  secrets: readonly (readonly [string, string])[],
): Promise<Result<SourceRecord>> {
  if (!SOURCE_ID.test(record.id)) return err(elvError('storage', 'invalid-source-id'));
  const written: string[] = [];
  const rollback = async (error: ElvError): Promise<Result<never>> => {
    for (const key of written) await deps.secrets.delete(key).catch(() => undefined);
    return err(error);
  };
  try {
    for (const [key, value] of secrets) {
      await deps.secrets.set(key, value);
      written.push(key);
    }
  } catch {
    return rollback(elvError('storage', 'secret-store-failed'));
  }
  try {
    await deps.db.run(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [record.id, record.kind, record.name, record.createdAt, JSON.stringify(record.settings)],
    );
  } catch {
    return rollback(elvError('storage', 'source-write-failed'));
  }
  return ok(record);
}

/**
 * Adds an Xtream source: server, username and password go to the secret store, never to the database. A guide
 * override is stored whole in `source.<id>.urlvars` ({@link guideSecret}).
 */
export async function addXtreamSource(
  input: XtreamSourceInput,
  deps: AddSourceDeps,
): Promise<Result<SourceRecord>> {
  if ([input.name, input.server, input.username, input.password].some((v) => v.trim() === '')) {
    return invalid();
  }
  const transportRes = sanitizeTransportSettings(input.transport);
  if (!transportRes.ok) return transportRes;
  const id = deps.newId();
  const settings: SourceSettings =
    transportRes.value === undefined ? {} : { transport: transportRes.value };
  if (typeof input.xmltvTimezone === 'string' && input.xmltvTimezone.trim() !== '') {
    settings.xmltvTimezone = input.xmltvTimezone.trim();
  }
  const record: SourceRecord = {
    id,
    kind: 'xtream',
    name: input.name,
    createdAt: deps.clock(),
    settings,
  };
  const backupServers = normalizeBackupServers(input.backupServers);
  const secret = JSON.stringify({
    server: input.server,
    username: input.username,
    password: input.password,
    ...(backupServers.length > 0 ? { backupServers } : {}),
  });
  const secrets: [string, string][] = [[secretKey(id, 'xtream'), secret]];
  if (input.guideUrl !== undefined && input.guideUrl.trim() !== '') {
    const g = guideSecret(input.guideUrl);
    settings.guideUrl = g.template;
    secrets.push([secretKey(id, 'urlvars'), JSON.stringify(g.vars)]);
  }
  return persist(deps, record, secrets);
}

/**
 * A guide URL as `settings_json` stores it: only the placeholder `{{g:<name>}}`, the whole URL being a secret in
 * `source.<id>.urlvars`. Guide URLs carry tokens in too many shapes to template them part by part; the `g:`
 * prefix keeps the name apart from entry URL values.
 */
export function guideSecret(guideUrl: string, name = 'url'): { template: string; vars: UrlVars } {
  return { template: `{{g:${name}}}`, vars: { [`g:${name}`]: guideUrl } };
}

/**
 * Adds an M3U source. The playlist URL is a secret. A guide URL is stored whole in `source.<id>.urlvars`
 * ({@link guideSecret}); `settings_json` holds only its placeholder.
 */
export async function addM3uSource(
  input: M3uSourceInput,
  deps: AddSourceDeps,
): Promise<Result<SourceRecord>> {
  if (input.name.trim() === '' || input.playlistUrl.trim() === '') return invalid();
  const transportRes = sanitizeTransportSettings(input.transport);
  if (!transportRes.ok) return transportRes;
  const id = deps.newId();
  const settings: SourceSettings = {};
  const vars: UrlVars = {};
  if (transportRes.value !== undefined) settings.transport = transportRes.value;
  if (input.vodPlaylist !== undefined) settings.vodPlaylist = input.vodPlaylist;
  if (typeof input.xmltvTimezone === 'string' && input.xmltvTimezone.trim() !== '') {
    settings.xmltvTimezone = input.xmltvTimezone.trim();
  }
  if (input.guideUrl !== undefined && input.guideUrl.trim() !== '') {
    const g = guideSecret(input.guideUrl);
    settings.guideUrl = g.template;
    Object.assign(vars, g.vars);
  }
  const record: SourceRecord = {
    id,
    kind: 'm3u',
    name: input.name,
    createdAt: deps.clock(),
    settings,
  };
  return persist(deps, record, [
    [secretKey(id, 'playlist'), input.playlistUrl],
    [secretKey(id, 'urlvars'), JSON.stringify(vars)],
  ]);
}

/**
 * Adds a local sandboxed M3U source (`#51`): writes playlist bytes to `localPlaylistStore` keyed by `sourceId`
 * and marks `settings.isLocalPlaylist = true` without ever storing filesystem paths in SQLite or `SecretStore`.
 */
export async function addLocalM3uSource(
  input: LocalM3uSourceInput,
  deps: AddSourceDeps & { localPlaylistStore?: LocalPlaylistStore },
): Promise<Result<SourceRecord>> {
  if (input.name.trim() === '' || input.bytes.byteLength === 0) return invalid();
  if (deps.localPlaylistStore === undefined) {
    return err(elvError('storage', 'local-playlist-unsupported'));
  }
  const transportRes = sanitizeTransportSettings(input.transport);
  if (!transportRes.ok) return transportRes;
  const id = deps.newId();
  if (!SOURCE_ID.test(id)) return err(elvError('storage', 'invalid-source-id'));
  const settings: SourceSettings = { isLocalPlaylist: true };
  const vars: UrlVars = {};
  if (transportRes.value !== undefined) settings.transport = transportRes.value;
  if (input.vodPlaylist !== undefined) settings.vodPlaylist = input.vodPlaylist;
  if (typeof input.xmltvTimezone === 'string' && input.xmltvTimezone.trim() !== '') {
    settings.xmltvTimezone = input.xmltvTimezone.trim();
  }
  if (input.guideUrl !== undefined && input.guideUrl.trim() !== '') {
    const g = guideSecret(input.guideUrl);
    settings.guideUrl = g.template;
    Object.assign(vars, g.vars);
  }
  try {
    await deps.localPlaylistStore.write(id, input.bytes);
  } catch {
    return err(elvError('storage', 'local-playlist-write-failed'));
  }
  const record: SourceRecord = {
    id,
    kind: 'm3u',
    name: input.name,
    createdAt: deps.clock(),
    settings,
  };
  const persisted = await persist(deps, record, [[secretKey(id, 'urlvars'), JSON.stringify(vars)]]);
  if (!persisted.ok) {
    await deps.localPlaylistStore.remove(id).catch(() => undefined);
  }
  return persisted;
}

/**
 * Adds a Stalker / Ministra MAC portal source (`#29`, ADR 0015): portal URL, normalized MAC address,
 * and optional serial number go strictly to `SecretStore` (`source.<id>.stalker`), never to SQLite.
 * Only a non-reversible SHA-256 `credentialFingerprint` and non-secret transport metadata enter `sources`.
 */
export async function addStalkerSource(
  input: StalkerSourceInput,
  deps: AddSourceDeps,
): Promise<Result<SourceRecord>> {
  if (input.name.trim() === '') return invalid();
  const portalRes = normalizeStalkerPortalUrl(input.portalUrl);
  if (!portalRes.ok) return portalRes;
  const macRes = normalizeMacAddress(input.mac);
  if (!macRes.ok) return macRes;
  const transportRes = sanitizeTransportSettings(input.transport);
  if (!transportRes.ok) return transportRes;

  const id = deps.newId();
  const fingerprint = fingerprintStalkerCredentials(portalRes.value.endpoint, macRes.value);
  const settings: SourceSettings = {
    ...(transportRes.value === undefined ? {} : { transport: transportRes.value }),
    ...(fingerprint === undefined ? {} : { credentialFingerprint: fingerprint }),
  };
  if (typeof input.xmltvTimezone === 'string' && input.xmltvTimezone.trim() !== '') {
    settings.xmltvTimezone = input.xmltvTimezone.trim();
  }

  const serialNumber = input.serialNumber?.trim();
  const secret = JSON.stringify({
    portalUrl: input.portalUrl.trim(),
    mac: macRes.value,
    ...(serialNumber !== undefined && serialNumber !== '' ? { serialNumber } : {}),
  });
  const secrets: [string, string][] = [[secretKey(id, 'stalker'), secret]];
  if (input.guideUrl !== undefined && input.guideUrl.trim() !== '') {
    const g = guideSecret(input.guideUrl);
    settings.guideUrl = g.template;
    secrets.push([secretKey(id, 'urlvars'), JSON.stringify(g.vars)]);
  }
  const record: SourceRecord = {
    id,
    kind: 'stalker',
    name: input.name,
    createdAt: deps.clock(),
    settings,
  };
  return persist(deps, record, secrets);
}

/** Reads one active source; `undefined` when the id is unknown or marked `deleting = 1`. */
export async function getSource(db: SqlDriver, id: string): Promise<SourceRecord | undefined> {
  const rows = await db.all<{
    id: string;
    kind: SourceKind;
    name: string;
    created_at: number;
    settings_json: string;
  }>(
    'SELECT id, kind, name, created_at, settings_json FROM sources WHERE id = ? AND deleting = 0',
    [id],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.created_at,
    settings: JSON.parse(row.settings_json) as SourceSettings,
  };
}

/** Replaces the stored settings of a source, validating `transport.dnsFamily` and `transport.hostOverride` (`#172`). */
export async function updateSourceSettings(
  db: SqlDriver,
  id: string,
  settings: SourceSettings,
): Promise<Result<void>> {
  const transportRes = sanitizeTransportSettings(settings.transport);
  if (!transportRes.ok) return transportRes;
  const sanitized: SourceSettings = { ...settings };
  if (transportRes.value === undefined) delete sanitized.transport;
  else sanitized.transport = transportRes.value;
  await db.run('UPDATE sources SET settings_json = ? WHERE id = ?', [
    JSON.stringify(sanitized),
    id,
  ]);
  return ok(undefined);
}

/** Updates optional Xtream failover backup mirror URLs strictly inside `SecretStore` (never SQLite, `#317`). */
export async function updateXtreamBackupServers(
  id: string,
  backupServers: readonly string[],
  deps: { secrets: SecretStore },
): Promise<Result<void>> {
  const raw = await deps.secrets.get(secretKey(id, 'xtream')).catch(() => undefined);
  if (raw === undefined) return err(elvError('storage', 'secret-missing'));
  let parsed: { server?: unknown; username?: unknown; password?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return err(elvError('storage', 'secret-missing'));
  }
  if (
    typeof parsed.server !== 'string' ||
    typeof parsed.username !== 'string' ||
    typeof parsed.password !== 'string'
  ) {
    return err(elvError('storage', 'secret-missing'));
  }
  const normalized = normalizeBackupServers(backupServers);
  const next = JSON.stringify({
    server: parsed.server,
    username: parsed.username,
    password: parsed.password,
    ...(normalized.length > 0 ? { backupServers: normalized } : {}),
  });
  try {
    await deps.secrets.set(secretKey(id, 'xtream'), next);
    return ok(undefined);
  } catch {
    return err(elvError('storage', 'secret-store-failed'));
  }
}

/** Deletes the secrets of a source (including all `urlvars` and `stalker_cmds` shards); reports `storage/secret-delete-failed` on failure. */
export async function removeSecrets(id: string, secrets: SecretStore): Promise<Result<void>> {
  const [partResults, urlvarsResult, stalkerCmdsResult] = await Promise.all([
    Promise.allSettled(NON_SHARDED_PARTS.map((part) => secrets.delete(secretKey(id, part)))),
    deleteUrlVars(secrets, id),
    deleteStalkerCmdMap(secrets, id),
  ]);
  return partResults.some((r) => r.status === 'rejected') ||
    !urlvarsResult.ok ||
    !stalkerCmdsResult.ok
    ? err(elvError('storage', 'secret-delete-failed'))
    : ok(undefined);
}

/** Deletes staged catalog rows from all 6 `*_next` tables (for `sourceId`, or all rows when omitted). */
export async function purgeStagedCatalog(db: SqlDriver, sourceId?: string): Promise<number> {
  let purged = 0;
  for (const table of STAGED_CATALOG_TABLES) {
    const r =
      sourceId === undefined
        ? await db.run(`DELETE FROM ${table}`)
        : await db.run(`DELETE FROM ${table} WHERE source_id = ?`, [sourceId]);
    purged += r.changes;
  }
  return purged;
}

/** Deletes every row of a source in the tables of {@link TABLES_BY_SOURCE} except `keep` (never the `sources` row). */
export async function purgeSourceRows(
  tx: SqlDriver,
  id: string,
  keep: readonly string[] = [],
): Promise<void> {
  for (const table of TABLES_BY_SOURCE) {
    if (!keep.includes(table)) await tx.run(`DELETE FROM ${table} WHERE source_id = ?`, [id]);
  }
}

/**
 * Purges catalog, guide, staging, and run rows of a `deleting = 1` source in bounded chunked transactions,
 * then deletes `watch_progress`, `favorites`, and the `sources` row atomically last (`#138`).
 */
export async function finishDeletingSource(
  db: SqlDriver,
  id: string,
  opts?: { chunkSize?: number; scheduler?: Scheduler; localPlaylistStore?: LocalPlaylistStore },
): Promise<void> {
  const chunkSize = Math.max(1, Math.floor(opts?.chunkSize ?? DEFAULT_DELETE_CHUNK_SIZE));
  for (const spec of BULK_DELETE_SPECS) {
    const params = spec.repeatId ? [id, id, chunkSize] : [id, chunkSize];
    for (;;) {
      const { changes } = await db.transaction((tx) => tx.run(spec.sql, params));
      if (changes < chunkSize) break;
      await opts?.scheduler?.yieldNow();
    }
  }
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM programmes_fts WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM watch_progress WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM favorites WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM track_preferences WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM recent_channels WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM parental_locks WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM channel_overrides WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM custom_group_items WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM guide_sources WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM programme_reminders WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM vod_enrichment WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM vod_collection_items WHERE source_id = ?', [id]);
    await pruneSourceFailoverMembersInTx(tx, id);
    await tx.run('DELETE FROM sources WHERE id = ?', [id]);
  });
  await opts?.localPlaylistStore?.remove(id).catch(() => undefined);
}

/**
 * Marks `sources.deleting = 1` immediately (refusing with `storage/import-in-progress` while a run is active),
 * purges bulk catalog/EPG/staging tables in bounded chunks, atomically commits user-state and `sources` row
 * deletion last, then deletes secrets. If secret deletion fails, rows are already gone and the caller can retry
 * {@link removeSecrets}.
 */
export async function removeSource(
  id: string,
  deps: {
    db: SqlDriver;
    secrets: SecretStore;
    scheduler?: Scheduler;
    localPlaylistStore?: LocalPlaylistStore;
  },
  opts?: { chunkSize?: number },
): Promise<Result<void>> {
  const busy = await deps.db.transaction(async (tx) => {
    const running = await tx.all(
      "SELECT 1 FROM import_runs WHERE source_id = ? AND status = 'running' LIMIT 1",
      [id],
    );
    if (running.length > 0) return true;
    await tx.run('UPDATE sources SET deleting = 1 WHERE id = ?', [id]);
    return false;
  });
  if (busy) return err(elvError('storage', 'import-in-progress'));
  await finishDeletingSource(deps.db, id, {
    ...(opts?.chunkSize === undefined ? {} : { chunkSize: opts.chunkSize }),
    ...(deps.scheduler === undefined ? {} : { scheduler: deps.scheduler }),
    ...(deps.localPlaylistStore === undefined
      ? {}
      : { localPlaylistStore: deps.localPlaylistStore }),
  });
  return removeSecrets(id, deps.secrets);
}
