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
  /** Guide URL templates found in the playlist header (`{{g:...}}` values live in `source:<id>:urlvars`). */
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
  /** User guide override, stored like an M3U guide URL (templated against the source's credentials). */
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

/**
 * Adds an Xtream source: server, username and password go to the secret store, never to the database. A guide
 * override is templated (credential values to `source:<id>:urlvars` under `g:` names) before it reaches `settings_json`.
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
    const credentials = `username=${encodeURIComponent(input.username)}&password=${encodeURIComponent(input.password)}`;
    const g = templateGuide(input.guideUrl, `${input.server}/get.php?${credentials}`);
    settings.guideUrl = g.template;
    secrets.push([secretKey(id, 'urlvars'), JSON.stringify(g.vars)]);
  }
  return persist(deps, record, secrets);
}

const URL_HEAD = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function playlistFacts(
  url: string,
): { host: string; segments: string[]; username?: string; password?: string } | undefined {
  const m = URL_HEAD.exec(url);
  if (m === null) return undefined;
  const authority = m[1] ?? '';
  const facts: { host: string; segments: string[]; username?: string; password?: string } = {
    host: authority.slice(authority.lastIndexOf('@') + 1).toLowerCase(),
    segments: (m[2] ?? '').slice(1).split('/'),
  };
  for (const pair of (m[3] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).toLowerCase();
    const value = decodeParam(pair.slice(eq + 1));
    if (name === 'username' || name === 'user') facts.username = value;
    if (name === 'password' || name === 'pass' || name === 'pwd') facts.password = value;
  }
  return facts;
}

/**
 * Templates a guide URL for `settings_json`. On the playlist's host the playlist's credentials and path
 * segments it shares (the account token) become placeholders; on another host the whole URL is a secret
 * (`{{g:url}}`). Variable names carry a `g:` prefix so they cannot clash with entry URL values.
 */
export function templateGuide(
  guideUrl: string,
  playlistUrl: string,
): { template: string; vars: UrlVars } {
  const playlist = playlistFacts(playlistUrl);
  const guide = playlistFacts(guideUrl);
  if (playlist === undefined || guide === undefined || playlist.host !== guide.host) {
    return { template: '{{g:url}}', vars: { 'g:url': guideUrl } };
  }
  const rules: SegmentRule[] = [];
  guide.segments.slice(0, -1).forEach((segment, position) => {
    if (segment.length >= 8 && segment === playlist.segments[position]) {
      rules.push({ host: guide.host, position, name: `v${position}` });
    }
  });
  const t = toTemplate(guideUrl, rules, playlist);
  const vars: UrlVars = {};
  for (const [name, value] of Object.entries(t.vars)) vars[`g:${name}`] = value;
  const template = t.template.replace(/\{\{([^{}]+)\}\}/g, (whole, name: string) =>
    name === '(' ? whole : `{{g:${name}}}`,
  );
  return { template, vars };
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
    const g = templateGuide(input.guideUrl, input.playlistUrl);
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

/**
 * Deletes a source and every catalog and guide row that belongs to it, then its secrets. The rows are gone even
 * when the result is `storage/secret-delete-failed`; the caller can retry {@link removeSecrets}.
 */
export async function removeSource(
  id: string,
  deps: { db: SqlDriver; secrets: SecretStore },
): Promise<Result<void>> {
  await deps.db.transaction(async (tx) => {
    for (const table of TABLES_BY_SOURCE) {
      await tx.run(`DELETE FROM ${table} WHERE source_id = ?`, [id]);
    }
    await tx.run('DELETE FROM sources WHERE id = ?', [id]);
  });
  return removeSecrets(id, deps.secrets);
}
