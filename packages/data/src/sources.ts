import {
  type ElvError,
  elvError,
  err,
  ok,
  type Result,
  type Scheduler,
  type SecretStore,
  type SqlDriver,
  type TransportSettings,
} from '@elv/domain';
import type { SegmentRule, UrlVars } from './templates';
import { deleteUrlVars } from './urlvars-store';

/** Kind of source a user can add. */
export type SourceKind = 'xtream' | 'm3u';

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
  username: string;
  password: string;
  transport?: TransportSettings;
  /** User guide override, stored whole as a secret like an M3U guide URL. */
  guideUrl?: string;
}

/** Input for {@link addM3uSource}. */
export interface M3uSourceInput {
  name: string;
  playlistUrl: string;
  guideUrl?: string;
  vodPlaylist?: boolean;
  transport?: TransportSettings;
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
  'watch_progress',
  'favorites',
];
const NON_URLVARS_PARTS = ['xtream', 'playlist'] as const;

/** Characters a source id may use: the set every platform secret store accepts in a key. */
export const SOURCE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Secret keys: `source.<id>.xtream` (JSON server, username, password), `.playlist`, `.urlvars` (JSON
 * {@link UrlVars}). Only letters, digits, `.`, `-` and `_`, the set the strictest platform secret store allows.
 */
export function secretKey(id: string, part: 'xtream' | 'playlist' | 'urlvars'): string {
  return `source.${id}.${part}`;
}

const invalid = (): Result<never> => err(elvError('source-format', 'invalid-source'));

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
  const id = deps.newId();
  const settings: SourceSettings =
    input.transport === undefined ? {} : { transport: input.transport };
  const record: SourceRecord = {
    id,
    kind: 'xtream',
    name: input.name,
    createdAt: deps.clock(),
    settings,
  };
  const secret = JSON.stringify({
    server: input.server,
    username: input.username,
    password: input.password,
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
  const id = deps.newId();
  const settings: SourceSettings = {};
  const vars: UrlVars = {};
  if (input.transport !== undefined) settings.transport = input.transport;
  if (input.vodPlaylist !== undefined) settings.vodPlaylist = input.vodPlaylist;
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

/** Replaces the stored settings of a source. */
export async function updateSourceSettings(
  db: SqlDriver,
  id: string,
  settings: SourceSettings,
): Promise<void> {
  await db.run('UPDATE sources SET settings_json = ? WHERE id = ?', [JSON.stringify(settings), id]);
}

/** Deletes the secrets of a source (including all `urlvars` shards); reports `storage/secret-delete-failed` on failure. */
export async function removeSecrets(id: string, secrets: SecretStore): Promise<Result<void>> {
  const [partResults, urlvarsResult] = await Promise.all([
    Promise.allSettled(NON_URLVARS_PARTS.map((part) => secrets.delete(secretKey(id, part)))),
    deleteUrlVars(secrets, id),
  ]);
  return partResults.some((r) => r.status === 'rejected') || !urlvarsResult.ok
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
  opts?: { chunkSize?: number; scheduler?: Scheduler },
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
    await tx.run('DELETE FROM watch_progress WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM favorites WHERE source_id = ?', [id]);
    await tx.run('DELETE FROM sources WHERE id = ?', [id]);
  });
}

/**
 * Marks `sources.deleting = 1` immediately (refusing with `storage/import-in-progress` while a run is active),
 * purges bulk catalog/EPG/staging tables in bounded chunks, atomically commits user-state and `sources` row
 * deletion last, then deletes secrets. If secret deletion fails, rows are already gone and the caller can retry
 * {@link removeSecrets}.
 */
export async function removeSource(
  id: string,
  deps: { db: SqlDriver; secrets: SecretStore; scheduler?: Scheduler },
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
  });
  return removeSecrets(id, deps.secrets);
}
