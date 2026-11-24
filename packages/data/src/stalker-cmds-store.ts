import { elvError, err, ok, type Result, type SecretStore } from '@elv/domain';

const utf8 = new TextEncoder();
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** @internal Opaque per-item Stalker `cmd` strings stored strictly in `SecretStore`. */
export type StalkerCmdMap = Record<string, string>;

/** Maximum UTF-8 byte length of a single serialized `stalker_cmds` shard (below 64 KiB keychain and 128 KiB Desktop ceilings). */
const STALKER_CMDS_CHUNK_BYTES = 60_000;

/** Maximum number of shards permitted for one source's `stalker_cmds` (~15 MiB safe total ceiling). */
const MAX_STALKER_CMDS_CHUNKS = 256;

/** Options for tuning Stalker command shard limits (primarily in unit tests). */
export interface StalkerCmdsStoreOptions {
  readonly chunkBytes?: number;
  readonly maxChunks?: number;
}

const cmdsRootKey = (sourceId: string): string => `source.${sourceId}.stalker_cmds`;
const cmdsShardKey = (sourceId: string, index: number): string =>
  `source.${sourceId}.stalker_cmds.${index}`;

function utf8Bytes(text: string): number {
  return utf8.encode(text).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copySafeCmds(src: Record<string, unknown>, dst: StalkerCmdMap): void {
  for (const [k, v] of Object.entries(src)) {
    if (PROTO_KEYS.has(k) || typeof v !== 'string' || v === '') continue;
    dst[k] = v;
  }
}

function parseManifest(parsed: Record<string, unknown>): { isManifest: boolean; count?: number } {
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== '__chunks' || typeof parsed.__chunks !== 'number') {
    return { isManifest: false };
  }
  const n = parsed.__chunks;
  if (!Number.isInteger(n) || n < 1 || n > MAX_STALKER_CMDS_CHUNKS) {
    return { isManifest: true };
  }
  return { isManifest: true, count: n };
}

async function safeGet(secrets: SecretStore, key: string): Promise<string | undefined> {
  try {
    return await secrets.get(key);
  } catch {
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
  const raw = await safeGet(secrets, cmdsRootKey(sourceId));
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

function partitionCmdMap(map: StalkerCmdMap, opts?: StalkerCmdsStoreOptions): string[] | undefined {
  const chunkBytes = opts?.chunkBytes ?? STALKER_CMDS_CHUNK_BYTES;
  const maxChunks = opts?.maxChunks ?? MAX_STALKER_CMDS_CHUNKS;
  const safe: StalkerCmdMap = Object.create(null) as StalkerCmdMap;
  copySafeCmds(map, safe);
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
 * Loads the per-source Stalker play-time command map from `SecretStore`, transparently reading
 * both legacy single-blob JSON and sharded manifest entries (`source.<id>.stalker_cmds.0..N-1`).
 */
export async function loadStalkerCmdMap(
  secrets: SecretStore,
  sourceId: string,
): Promise<StalkerCmdMap> {
  const raw = await safeGet(secrets, cmdsRootKey(sourceId));
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const manifest = parseManifest(parsed);
  const out: StalkerCmdMap = {};
  if (!manifest.isManifest) {
    copySafeCmds(parsed, out);
    return out;
  }
  if (manifest.count === undefined) return {};
  const shards = await Promise.all(
    Array.from({ length: manifest.count }, (_, i) => safeGet(secrets, cmdsShardKey(sourceId, i))),
  );
  for (const shard of shards) {
    if (shard === undefined) continue;
    try {
      const obj: unknown = JSON.parse(shard);
      if (!isPlainObject(obj)) continue;
      copySafeCmds(obj, out);
    } catch {
      // Ignore corrupt shard rather than breaking every other item in the source
    }
  }
  return out;
}

/**
 * Persists the per-source Stalker play-time command map into `SecretStore`, sharding across
 * `source.<id>.stalker_cmds.0..N-1` when the serialized JSON exceeds `60_000` UTF-8 bytes and
 * cleaning up any trailing shards left over from a larger previous write.
 */
export async function saveStalkerCmdMap(
  secrets: SecretStore,
  sourceId: string,
  map: StalkerCmdMap,
  opts?: StalkerCmdsStoreOptions,
): Promise<Result<void>> {
  const chunks = partitionCmdMap(map, opts);
  if (chunks === undefined) {
    return err(elvError('storage', 'secret-store-failed'));
  }
  const prevChunks = await readChunkCount(secrets, sourceId);
  const rootKey = cmdsRootKey(sourceId);
  let writtenShards = 0;
  try {
    if (chunks.length === 1) {
      await secrets.set(rootKey, chunks[0] as string);
      for (let i = 0; i < prevChunks; i += 1) {
        await safeDelete(secrets, cmdsShardKey(sourceId, i));
      }
      return ok(undefined);
    }
    for (let i = 0; i < chunks.length; i += 1) {
      await secrets.set(cmdsShardKey(sourceId, i), chunks[i] as string);
      writtenShards = i + 1;
    }
    await secrets.set(rootKey, JSON.stringify({ __chunks: chunks.length }));
    for (let i = chunks.length; i < prevChunks; i += 1) {
      await safeDelete(secrets, cmdsShardKey(sourceId, i));
    }
    return ok(undefined);
  } catch {
    for (let i = prevChunks; i < writtenShards; i += 1) {
      await safeDelete(secrets, cmdsShardKey(sourceId, i));
    }
    return err(elvError('storage', 'secret-store-failed'));
  }
}

/** Merges additional Stalker command entries into `source.<id>.stalker_cmds` inside `SecretStore`. */
export async function mergeStalkerCmdMap(
  secrets: SecretStore,
  sourceId: string,
  additions: StalkerCmdMap,
  opts?: StalkerCmdsStoreOptions,
): Promise<Result<void>> {
  if (Object.keys(additions).length === 0) return ok(undefined);
  const existing = await loadStalkerCmdMap(secrets, sourceId);
  return saveStalkerCmdMap(secrets, sourceId, { ...existing, ...additions }, opts);
}

/**
 * Deletes every shard key (`source.<id>.stalker_cmds.0..N-1`) referenced by the manifest first,
 * then deletes `source.<id>.stalker_cmds` only after all shards succeed so retries can finish
 * cleanup on partial failure.
 */
export async function deleteStalkerCmdMap(
  secrets: SecretStore,
  sourceId: string,
): Promise<Result<void>> {
  const prevChunks = await readChunkCount(secrets, sourceId);
  if (prevChunks > 0) {
    const shardResults = await Promise.allSettled(
      Array.from({ length: prevChunks }, (_, i) => secrets.delete(cmdsShardKey(sourceId, i))),
    );
    if (shardResults.some((r) => r.status === 'rejected')) {
      return err(elvError('storage', 'secret-delete-failed'));
    }
  }
  try {
    await secrets.delete(cmdsRootKey(sourceId));
    return ok(undefined);
  } catch {
    return err(elvError('storage', 'secret-delete-failed'));
  }
}
