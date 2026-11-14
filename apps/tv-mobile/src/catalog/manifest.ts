import { SOURCE_ID, type SourceKind } from '@elv/data';
import type { SqlDriver } from '@elv/domain';

/**
 * One string in persistent key-value storage that survives a purge of the caches (`NSUserDefaults` on Apple
 * platforms). `read` and `write` may throw; the manifest functions treat that as no manifest.
 */
export interface ManifestStore {
  read(): string | undefined;
  write(value: string): void;
}

/** A `sources` row as the manifest keeps it. Never a credential: those live in the secret store. */
export interface ManifestEntry {
  id: string;
  kind: SourceKind;
  name: string;
  createdAt: number;
  /** `settings_json` as stored; it holds no credential by construction (`@elv/data`). */
  settingsJson: string;
}

const VERSION = 1;

const isObjectJson = (text: unknown): boolean => {
  if (typeof text !== 'string') return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
};

function isEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    SOURCE_ID.test(e.id) &&
    (e.kind === 'xtream' || e.kind === 'm3u') &&
    typeof e.name === 'string' &&
    typeof e.createdAt === 'number' &&
    Number.isFinite(e.createdAt) &&
    isObjectJson(e.settingsJson)
  );
}

/** The stored form: `{"v":1,"sources":[…]}`. */
export function encodeManifest(entries: readonly ManifestEntry[]): string {
  return JSON.stringify({
    v: VERSION,
    sources: entries.map(({ id, kind, name, createdAt, settingsJson }) => ({
      id,
      kind,
      name,
      createdAt,
      settingsJson,
    })),
  });
}

/** The valid entries of a stored manifest; nothing for a missing, foreign or broken value. */
export function decodeManifest(text: string | undefined): ManifestEntry[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const m = parsed as { v?: unknown; sources?: unknown } | null;
  if (m === null || typeof m !== 'object' || m.v !== VERSION || !Array.isArray(m.sources))
    return [];
  return m.sources.filter(isEntry);
}

async function sourceEntries(db: SqlDriver): Promise<ManifestEntry[]> {
  const rows = await db.all<{
    id: string;
    kind: SourceKind;
    name: string;
    created_at: number;
    settings_json: string;
  }>('SELECT id, kind, name, created_at, settings_json FROM sources ORDER BY created_at, id');
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    createdAt: r.created_at,
    settingsJson: r.settings_json,
  }));
}

/** Writes every source of `db` to `store`; a failure is ignored (the manifest is a recovery aid). */
export async function saveManifest(db: SqlDriver, store: ManifestStore): Promise<void> {
  try {
    store.write(encodeManifest(await sourceEntries(db)));
  } catch {
    // the catalog works without a manifest
  }
}

function readManifest(store: ManifestStore): ManifestEntry[] {
  try {
    return decodeManifest(store.read());
  } catch {
    return [];
  }
}

/**
 * Run once after `openCatalog`. A database without sources but a manifest with some (the OS purged the caches) gets
 * those sources back with the same ids, so content keys and secret keys match again; they have no catalog yet, so
 * `listSources` reports `needsImport` until they are imported. A database with sources rewrites the manifest from it.
 * Returns the restored ids.
 */
export async function reconcileManifest(db: SqlDriver, store: ManifestStore): Promise<string[]> {
  const present = await sourceEntries(db);
  if (present.length > 0) {
    await saveManifest(db, store);
    return [];
  }
  const entries = readManifest(store);
  if (entries.length === 0) return [];
  await db.transaction(async (tx) => {
    for (const e of entries) {
      await tx.run(
        'INSERT OR IGNORE INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
        [e.id, e.kind, e.name, e.createdAt, e.settingsJson],
      );
    }
  });
  return [...new Set(entries.map((e) => e.id))];
}
