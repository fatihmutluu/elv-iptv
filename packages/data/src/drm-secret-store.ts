import {
  type DrmClearKeyPair,
  type DrmConfig,
  type DrmScheme,
  elvError,
  err,
  ok,
  type Result,
  type SecretStore,
  setSafeHeader,
} from '@elv/domain';
import { isSecretKeyRotatedError } from './secret-errors';

const utf8 = new TextEncoder();
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_SCHEMES: ReadonlySet<string> = new Set(['clearkey', 'widevine', 'playready']);

/** @internal Per-item DRM specifications stored strictly in `SecretStore`, never SQLite (`#272`). */
export type DrmSpecMap = Record<string, DrmConfig>;

/** Maximum UTF-8 byte length of a single serialized `drm_specs` shard (below 64 KiB keychain and 128 KiB Desktop ceilings). */
const DRM_SPECS_CHUNK_BYTES = 60_000;

/** Maximum number of shards permitted for one source's `drm_specs` (~15 MiB safe total ceiling). */
const MAX_DRM_SPECS_CHUNKS = 256;

/** Options for tuning DRM secret shard limits (primarily in unit tests). */
export interface DrmSecretStoreOptions {
  readonly chunkBytes?: number;
  readonly maxChunks?: number;
}

const drmRootKey = (sourceId: string): string => `source.${sourceId}.drm_specs`;
const drmShardKey = (sourceId: string, index: number): string =>
  `source.${sourceId}.drm_specs.${index}`;

function utf8Bytes(text: string): number {
  return utf8.encode(text).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeDrmConfig(raw: unknown): DrmConfig | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.scheme !== 'string' || !VALID_SCHEMES.has(raw.scheme)) return undefined;
  const scheme = raw.scheme as DrmScheme;

  let licenseUrl: string | undefined;
  if (typeof raw.licenseUrl === 'string' && raw.licenseUrl.length > 0) {
    licenseUrl = raw.licenseUrl;
  }

  let licenseHeaders: Record<string, string> | undefined;
  if (isPlainObject(raw.licenseHeaders)) {
    const clean: Record<string, string> = {};
    let count = 0;
    for (const key of Object.keys(raw.licenseHeaders)) {
      if (PROTO_KEYS.has(key.toLowerCase())) continue;
      const val = raw.licenseHeaders[key];
      if (typeof val !== 'string' || val.length === 0) continue;
      setSafeHeader(clean, key, val);
      count += 1;
    }
    if (count > 0) licenseHeaders = clean;
  }

  let clearKeys: DrmClearKeyPair[] | undefined;
  if (Array.isArray(raw.clearKeys) && raw.clearKeys.length > 0) {
    const pairs: DrmClearKeyPair[] = [];
    for (const item of raw.clearKeys) {
      if (!isPlainObject(item)) return undefined;
      if (
        typeof item.kid !== 'string' ||
        item.kid.length === 0 ||
        typeof item.key !== 'string' ||
        item.key.length === 0
      ) {
        return undefined;
      }
      pairs.push({ kid: item.kid, key: item.key });
    }
    if (pairs.length > 0) clearKeys = pairs;
  }

  if (licenseUrl === undefined && clearKeys === undefined) return undefined;

  return {
    scheme,
    ...(licenseUrl === undefined ? {} : { licenseUrl }),
    ...(licenseHeaders === undefined ? {} : { licenseHeaders }),
    ...(clearKeys === undefined ? {} : { clearKeys }),
    ...(typeof raw.multiSession === 'boolean' ? { multiSession: raw.multiSession } : {}),
  };
}

function copySafeDrmSpecs(src: Record<string, unknown>, dst: DrmSpecMap): void {
  for (const [k, v] of Object.entries(src)) {
    if (PROTO_KEYS.has(k)) continue;
    const clean = sanitizeDrmConfig(v);
    if (clean !== undefined) dst[k] = clean;
  }
}

function parseManifest(parsed: Record<string, unknown>): { isManifest: boolean; count?: number } {
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== '__chunks' || typeof parsed.__chunks !== 'number') {
    return { isManifest: false };
  }
  const n = parsed.__chunks;
  if (!Number.isInteger(n) || n < 1 || n > MAX_DRM_SPECS_CHUNKS) {
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
  const raw = await safeGet(secrets, drmRootKey(sourceId), false);
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

/** Partitions a DRM spec map into JSON shards each strictly `<= chunkBytes` UTF-8 bytes. */
export function partitionDrmSpecs(
  map: DrmSpecMap,
  opts?: DrmSecretStoreOptions,
): string[] | undefined {
  const chunkBytes = opts?.chunkBytes ?? DRM_SPECS_CHUNK_BYTES;
  const maxChunks = opts?.maxChunks ?? MAX_DRM_SPECS_CHUNKS;
  const safe: DrmSpecMap = Object.create(null) as DrmSpecMap;
  copySafeDrmSpecs(map, safe);
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
 * Loads the per-source DRM spec map from `SecretStore`, transparently reading both single-blob JSON
 * and sharded manifest entries (`source.<id>.drm_specs.0..N-1`).
 */
export async function loadDrmSpecs(secrets: SecretStore, sourceId: string): Promise<DrmSpecMap> {
  const raw = await safeGet(secrets, drmRootKey(sourceId), true);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const manifest = parseManifest(parsed);
  const out: DrmSpecMap = {};
  if (!manifest.isManifest) {
    copySafeDrmSpecs(parsed, out);
    return out;
  }
  if (manifest.count === undefined) return {};
  const shards = await Promise.all(
    Array.from({ length: manifest.count }, (_, i) =>
      safeGet(secrets, drmShardKey(sourceId, i), true),
    ),
  );
  for (const shard of shards) {
    if (shard === undefined) continue;
    try {
      const obj: unknown = JSON.parse(shard);
      if (!isPlainObject(obj)) continue;
      copySafeDrmSpecs(obj, out);
    } catch {
      // Ignore corrupt shard rather than breaking every other DRM item in the source
    }
  }
  return out;
}

/**
 * Persists the per-source DRM spec map strictly inside `SecretStore`, sharding across
 * `source.<id>.drm_specs.0..N-1` when the serialized JSON exceeds `60_000` UTF-8 bytes and
 * cleaning up any trailing shards left over from a larger previous write.
 */
export async function saveDrmSpecs(
  secrets: SecretStore,
  sourceId: string,
  map: DrmSpecMap,
  opts?: DrmSecretStoreOptions,
): Promise<Result<void>> {
  const chunks = partitionDrmSpecs(map, opts);
  if (chunks === undefined) {
    return err(elvError('storage', 'secret-store-failed'));
  }
  const prevChunks = await readChunkCount(secrets, sourceId);
  const rootKey = drmRootKey(sourceId);
  let writtenShards = 0;
  try {
    if (chunks.length === 1) {
      await secrets.set(rootKey, chunks[0] as string);
      for (let i = 0; i < prevChunks; i += 1) {
        await safeDelete(secrets, drmShardKey(sourceId, i));
      }
      return ok(undefined);
    }
    for (let i = 0; i < chunks.length; i += 1) {
      await secrets.set(drmShardKey(sourceId, i), chunks[i] as string);
      writtenShards = i + 1;
    }
    await secrets.set(rootKey, JSON.stringify({ __chunks: chunks.length }));
    for (let i = chunks.length; i < prevChunks; i += 1) {
      await safeDelete(secrets, drmShardKey(sourceId, i));
    }
    return ok(undefined);
  } catch {
    for (let i = prevChunks; i < writtenShards; i += 1) {
      await safeDelete(secrets, drmShardKey(sourceId, i));
    }
    return err(elvError('storage', 'secret-store-failed'));
  }
}

/**
 * Deletes every shard key (`source.<id>.drm_specs.0..N-1`) referenced by the manifest first,
 * then deletes `source.<id>.drm_specs` only after all shards succeed so retries can finish
 * cleanup on partial failure.
 */
export async function deleteDrmSpecs(
  secrets: SecretStore,
  sourceId: string,
): Promise<Result<void>> {
  const prevChunks = await readChunkCount(secrets, sourceId);
  if (prevChunks > 0) {
    const shardResults = await Promise.allSettled(
      Array.from({ length: prevChunks }, (_, i) => secrets.delete(drmShardKey(sourceId, i))),
    );
    if (shardResults.some((r) => r.status === 'rejected')) {
      return err(elvError('storage', 'secret-delete-failed'));
    }
  }
  try {
    await secrets.delete(drmRootKey(sourceId));
    return ok(undefined);
  } catch {
    return err(elvError('storage', 'secret-delete-failed'));
  }
}
