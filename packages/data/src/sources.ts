import {
  type ElvError,
  elvError,
  err,
  ok,
  type Result,
  type SecretStore,
  type SqlDriver,
  type TransportSettings,
} from '@elv/domain';
import type { SegmentRule, UrlVars } from './templates';

/** Kind of source a user can add. */
export type SourceKind = 'xtream' | 'm3u';

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

/** Every table with a `source_id` column; {@link removeSource} clears them all (no foreign keys). */
export const TABLES_BY_SOURCE: readonly string[] = [
  'import_runs',
  'categories',
  'live',
  'movies',
  'series',
  'episodes',
  'placements',
  'guide_channels',
  'channel_guide',
  'programmes',
  'programmes_next',
];
const PARTS = ['xtream', 'playlist', 'urlvars'] as const;

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

/** Reads one source; `undefined` when the id is unknown. */
export async function getSource(db: SqlDriver, id: string): Promise<SourceRecord | undefined> {
  const rows = await db.all<{
    id: string;
    kind: SourceKind;
    name: string;
    created_at: number;
    settings_json: string;
  }>('SELECT id, kind, name, created_at, settings_json FROM sources WHERE id = ?', [id]);
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

/** Deletes the three secrets of a source; reports `storage/secret-delete-failed` when any deletion failed. */
export async function removeSecrets(id: string, secrets: SecretStore): Promise<Result<void>> {
  const results = await Promise.allSettled(
    PARTS.map((part) => secrets.delete(secretKey(id, part))),
  );
  return results.some((r) => r.status === 'rejected')
    ? err(elvError('storage', 'secret-delete-failed'))
    : ok(undefined);
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
 * Deletes a source and every catalog and guide row that belongs to it, then its secrets. While an import of the
 * source is running nothing is deleted and the result is `storage/import-in-progress`. The rows are gone even when
 * the result is `storage/secret-delete-failed`; the caller can retry {@link removeSecrets}.
 */
export async function removeSource(
  id: string,
  deps: { db: SqlDriver; secrets: SecretStore },
): Promise<Result<void>> {
  const busy = await deps.db.transaction(async (tx) => {
    const running = await tx.all(
      "SELECT 1 FROM import_runs WHERE source_id = ? AND status = 'running' LIMIT 1",
      [id],
    );
    if (running.length > 0) return true;
    await purgeSourceRows(tx, id);
    await tx.run('DELETE FROM sources WHERE id = ?', [id]);
    return false;
  });
  if (busy) return err(elvError('storage', 'import-in-progress'));
  return removeSecrets(id, deps.secrets);
}
