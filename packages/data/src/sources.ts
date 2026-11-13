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
import { type SegmentRule, toTemplate, type UrlVars } from './templates';

/** Kind of source a user can add. */
export type SourceKind = 'xtream' | 'm3u';

/** Non-secret, per-source settings stored as JSON in the `sources` table. */
export interface SourceSettings {
  transport?: TransportSettings;
  /** User guide URL override; for M3U sources a template whose `{{g:...}}` values live in `source:<id>:urlvars`. */
  guideUrl?: string;
  vodPlaylist?: boolean;
  segmentRules?: SegmentRule[];
  guideWindow?: { daysBack: number; daysForward: number };
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
  newId: () => string;
}

const TABLES_BY_SOURCE = [
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
];
const PARTS = ['xtream', 'playlist', 'urlvars'] as const;

/** Secret keys: `source:<id>:xtream` (JSON server, username, password), `:playlist`, `:urlvars` (JSON {@link UrlVars}). */
export function secretKey(id: string, part: 'xtream' | 'playlist' | 'urlvars'): string {
  return `source:${id}:${part}`;
}

const invalid = (): Result<never> => err(elvError('source-format', 'invalid-source'));

async function persist(
  deps: AddSourceDeps,
  record: SourceRecord,
  secrets: readonly (readonly [string, string])[],
): Promise<Result<SourceRecord>> {
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

/** Adds an Xtream source: server, username and password go to the secret store, never to the database. */
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
  return persist(deps, record, [[secretKey(id, 'xtream'), secret]]);
}

/**
 * Adds an M3U source. The playlist URL is a secret. A guide URL is templated: its credential values move to
 * `source:<id>:urlvars` under `g:`-prefixed names so they cannot clash with entry URL values.
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
    const t = toTemplate(input.guideUrl, [], {});
    settings.guideUrl = t.template.replace(/\{\{([^{}]+)\}\}/g, '{{g:$1}}');
    for (const [name, value] of Object.entries(t.vars)) vars[`g:${name}`] = value;
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

/** Deletes a source, every catalog and guide row that belongs to it, and its secrets. */
export async function removeSource(
  id: string,
  deps: { db: SqlDriver; secrets: SecretStore },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    for (const table of TABLES_BY_SOURCE) {
      await tx.run(`DELETE FROM ${table} WHERE source_id = ?`, [id]);
    }
    await tx.run('DELETE FROM sources WHERE id = ?', [id]);
  });
  for (const part of PARTS) await deps.secrets.delete(secretKey(id, part));
}
