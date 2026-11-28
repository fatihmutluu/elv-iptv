import { elvError, err, ok, type Result, type SecretStore } from '@elv/domain';
import { isSecretKeyRotatedError } from './secret-errors';
import type { UrlVars } from './templates';

const utf8 = new TextEncoder();
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function emptyUrlVars(): UrlVars {
  return Object.create(null) as UrlVars;
}

function copySafeUrlVars(src: Record<string, unknown>, dst: UrlVars): void {
  for (const [k, v] of Object.entries(src)) {
    if (PROTO_KEYS.has(k) || typeof v !== 'string') continue;
    dst[k] = v;
  }
}

/** Maximum UTF-8 byte length of a single serialized `urlvars` secret value (below 64 KiB keychain ceilings). */
export const URLVARS_CHUNK_BYTES = 60_000;

/** Maximum number of shards permitted for one source's `urlvars` (~15 MiB safe total ceiling). */
export const MAX_URLVARS_CHUNKS = 256;

/** Maximum total serialized byte budget for one source's `urlvars`. */
export const MAX_URLVARS_TOTAL_BYTES = URLVARS_CHUNK_BYTES * MAX_URLVARS_CHUNKS;

/** Options for tuning shard limits (primarily in unit tests). */
export interface UrlVarsStoreOptions {
  readonly chunkBytes?: number;
  readonly maxChunks?: number;
}

const urlvarsRootKey = (sourceId: string): string => `source.${sourceId}.urlvars`;
const urlvarsShardKey = (sourceId: string, index: number): string =>
  `source.${sourceId}.urlvars.${index}`;

function utf8Bytes(text: string): number {
  return utf8.encode(text).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(parsed: Record<string, unknown>): { isManifest: boolean; count?: number } {
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== '__chunks' || typeof parsed.__chunks !== 'number') {
    return { isManifest: false };
  }
  const n = parsed.__chunks;
  if (!Number.isInteger(n) || n < 1 || n > MAX_URLVARS_CHUNKS) {
    return { isManifest: true };
  }
  return { isManifest: true, count: n };
}

async function safeGet(
  secrets: SecretStore,
  key: string,
  propagateKeyRotated: boolean,
): Promise<string | undefined> {
  try {
    return await secrets.get(key);
  } catch (error) {
    if (propagateKeyRotated && isSecretKeyRotatedError(error)) throw error;
    return undefined;
  }
}

async function safeDelete(secrets: SecretStore, key: string): Promise<void> {
  try {
    await secrets.delete(key);
  } catch {
    // Best-effort cleanup of stale or orphaned shards
  }
}

async function readChunkCount(secrets: SecretStore, sourceId: string): Promise<number> {
  const raw = await safeGet(secrets, urlvarsRootKey(sourceId), false);
  if (raw === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return 0;
    const manifest = parseManifest(parsed);
    return manifest.isManifest && manifest.count !== undefined ? manifest.count : 0;
  } catch {
    return 0;
  }
}

/**
 * Splits `vars` into one single-key JSON string (when `<= chunkBytes`) or `2..maxChunks` JSON shard
 * strings each `<= chunkBytes` UTF-8 bytes. Returns `undefined` when any single entry exceeds `chunkBytes`
 * or more than `maxChunks` shards would be required.
 */
export function partitionUrlVars(vars: UrlVars, opts?: UrlVarsStoreOptions): string[] | undefined {
  const chunkBytes = opts?.chunkBytes ?? URLVARS_CHUNK_BYTES;
  const maxChunks = opts?.maxChunks ?? MAX_URLVARS_CHUNKS;
  const safe = emptyUrlVars();
  copySafeUrlVars(vars, safe);
  const full = JSON.stringify(safe);
  if (utf8Bytes(full) <= chunkBytes) return [full];

  const chunks: string[] = [];
  let entries: string[] = [];
  let currentBytes = 2;

  for (const [k, v] of Object.entries(safe)) {
    const entry = `${JSON.stringify(k)}:${JSON.stringify(v)}`;
    const entryBytes = utf8Bytes(entry);
    if (entryBytes + 2 > chunkBytes) return undefined;
    const needed = (entries.length === 0 ? 0 : 1) + entryBytes;
    if (currentBytes + needed > chunkBytes) {
      chunks.push(`{${entries.join(',')}}`);
      if (chunks.length >= maxChunks) return undefined;
      entries = [entry];
      currentBytes = 2 + entryBytes;
    } else {
      entries.push(entry);
      currentBytes += needed;
    }
  }
  if (entries.length > 0) chunks.push(`{${entries.join(',')}}`);
  return chunks.length <= maxChunks ? chunks : undefined;
}

/**
 * Reads the `urlvars` secret map of a source, transparently reassembling sharded keys
 * (`source.<id>.urlvars.0..N-1`) when `source.<id>.urlvars` holds a `{"__chunks": N}` manifest.
 * A missing, unreadable, or corrupt payload yields an empty null-prototype object (or partial valid shards).
 */
export async function readUrlVars(
  deps: { secrets: SecretStore },
  sourceId: string,
): Promise<UrlVars> {
  const raw = await safeGet(deps.secrets, urlvarsRootKey(sourceId), true);
  if (raw === undefined) return emptyUrlVars();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyUrlVars();
  }
  if (!isPlainObject(parsed)) return emptyUrlVars();
  const manifest = parseManifest(parsed);
  if (!manifest.isManifest) {
    const out = emptyUrlVars();
    copySafeUrlVars(parsed, out);
    return out;
  }
  if (manifest.count === undefined) return emptyUrlVars();
  const out = emptyUrlVars();
  const shards = await Promise.all(
    Array.from({ length: manifest.count }, (_, i) =>
      safeGet(deps.secrets, urlvarsShardKey(sourceId, i), true),
    ),
  );
  for (const shard of shards) {
    if (shard === undefined) continue;
    try {
      const obj: unknown = JSON.parse(shard);
      if (!isPlainObject(obj)) continue;
      copySafeUrlVars(obj, out);
    } catch {
      // Ignore corrupt shard rather than failing every other stream in the source
    }
  }
  return out;
}

/**
 * Persists `vars` into `source.<id>.urlvars` (single key when `<= URLVARS_CHUNK_BYTES`, otherwise
 * sharded across `source.<id>.urlvars.0..N-1` with manifest `{"__chunks": N}` written last) and
 * deletes any trailing shards left over from a larger previous write.
 */
export async function writeUrlVars(
  secrets: SecretStore,
  sourceId: string,
  vars: UrlVars,
  opts?: UrlVarsStoreOptions,
): Promise<Result<void>> {
  const chunks = partitionUrlVars(vars, opts);
  if (chunks === undefined) {
    return err(elvError('source-format', 'urlvars-too-large'));
  }
  const prevChunks = await readChunkCount(secrets, sourceId);
  const rootKey = urlvarsRootKey(sourceId);
  let writtenShards = 0;
  try {
    if (chunks.length === 1) {
      await secrets.set(rootKey, chunks[0] as string);
      for (let i = 0; i < prevChunks; i += 1) {
        await safeDelete(secrets, urlvarsShardKey(sourceId, i));
      }
      return ok(undefined);
    }
    for (let i = 0; i < chunks.length; i += 1) {
      await secrets.set(urlvarsShardKey(sourceId, i), chunks[i] as string);
      writtenShards = i + 1;
    }
    await secrets.set(rootKey, JSON.stringify({ __chunks: chunks.length }));
    for (let i = chunks.length; i < prevChunks; i += 1) {
      await safeDelete(secrets, urlvarsShardKey(sourceId, i));
    }
    return ok(undefined);
  } catch {
    for (let i = prevChunks; i < writtenShards; i += 1) {
      await safeDelete(secrets, urlvarsShardKey(sourceId, i));
    }
    return err(elvError('storage', 'secret-write-failed'));
  }
}

/**
 * Deletes every shard key (`source.<id>.urlvars.0..N-1`) referenced by the manifest first, then
 * deletes `source.<id>.urlvars` only after all shards succeed so retries can finish cleanup on
 * partial failure. Returns `storage/secret-delete-failed` if any deletion fails.
 */
export async function deleteUrlVars(secrets: SecretStore, sourceId: string): Promise<Result<void>> {
  const prevChunks = await readChunkCount(secrets, sourceId);
  if (prevChunks > 0) {
    const shardResults = await Promise.allSettled(
      Array.from({ length: prevChunks }, (_, i) => secrets.delete(urlvarsShardKey(sourceId, i))),
    );
    if (shardResults.some((r) => r.status === 'rejected')) {
      return err(elvError('storage', 'secret-delete-failed'));
    }
  }
  try {
    await secrets.delete(urlvarsRootKey(sourceId));
    return ok(undefined);
  } catch {
    return err(elvError('storage', 'secret-delete-failed'));
  }
}
