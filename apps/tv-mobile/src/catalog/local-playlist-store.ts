import { type LocalPlaylistStore, SOURCE_ID } from '@elv/data';
import type { SqlDriver } from '@elv/domain';

/** Maximum local M3U playlist payload size accepted by mobile sandboxed storage (64 MiB, `#51`). */
const MAX_MOBILE_LOCAL_PLAYLIST_BYTES = 64 * 1024 * 1024;

const TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS local_playlists (source_id TEXT PRIMARY KEY, payload TEXT NOT NULL)';
const CHUNK_BYTES = 64 * 1024;
/** Exact multiple of 3 (12 KiB -> 16,384 chars) to avoid per-byte string OOM and stay below apply limits. */
const B64_ENCODE_CHUNK_BYTES = 12 * 1024;
const B64_EQ_CODE = 61;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = new Uint8Array(64);
const B64_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i += 1) {
  const code = B64_ALPHABET.charCodeAt(i);
  B64_CODES[i] = code;
  B64_TABLE[code] = i;
}

function encodeBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  if (len === 0) return '';
  const chunks: string[] = [];
  const codes: number[] = [];
  for (let offset = 0; offset < len; offset += B64_ENCODE_CHUNK_BYTES) {
    const end = Math.min(len, offset + B64_ENCODE_CHUNK_BYTES);
    let outIdx = 0;
    for (let i = offset; i < end; i += 3) {
      const b0 = bytes[i] ?? 0;
      const has1 = i + 1 < end;
      const has2 = i + 2 < end;
      const b1 = has1 ? (bytes[i + 1] ?? 0) : 0;
      const b2 = has2 ? (bytes[i + 2] ?? 0) : 0;
      const triplet = (b0 << 16) | (b1 << 8) | b2;
      codes[outIdx++] = B64_CODES[(triplet >> 18) & 63] ?? B64_EQ_CODE;
      codes[outIdx++] = B64_CODES[(triplet >> 12) & 63] ?? B64_EQ_CODE;
      codes[outIdx++] = has1 ? (B64_CODES[(triplet >> 6) & 63] ?? B64_EQ_CODE) : B64_EQ_CODE;
      codes[outIdx++] = has2 ? (B64_CODES[triplet & 63] ?? B64_EQ_CODE) : B64_EQ_CODE;
    }
    codes.length = outIdx;
    chunks.push(String.fromCharCode.apply(null, codes));
  }
  return chunks.join('');
}

function decodeBase64(input: string): Uint8Array {
  let cleanLen = 0;
  let padding = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 61) {
      padding += 1;
      cleanLen += 1;
      continue;
    }
    if (code >= 128 || B64_TABLE[code] === -1) continue;
    cleanLen += 1;
  }
  if (cleanLen === 0 || cleanLen % 4 !== 0) return new Uint8Array(0);
  const out = new Uint8Array((cleanLen / 4) * 3 - padding);
  let outIdx = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 61 || code >= 128) continue;
    const val = B64_TABLE[code] ?? -1;
    if (val === -1) continue;
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outIdx < out.length) out[outIdx++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

function assertValidSourceId(sourceId: string): void {
  if (!SOURCE_ID.test(sourceId)) {
    throw new Error('invalid source id');
  }
}

/**
 * Creates a zero-permission, app-private {@link LocalPlaylistStore} backed by a lazily opened
 * SQLite database (`local-playlists.db`) so local M3U files persist safely inside app storage and
 * are cleaned up on `removeSource` (`#51`).
 */
export function createMobileLocalPlaylistStore(
  openDb: () => Promise<SqlDriver>,
): LocalPlaylistStore {
  let dbPromise: Promise<SqlDriver> | undefined;

  const ensureDb = (): Promise<SqlDriver> => {
    dbPromise ??= openDb()
      .then(async (db) => {
        await db.run(TABLE_SQL);
        return db;
      })
      .catch((error: unknown) => {
        dbPromise = undefined;
        throw error;
      });
    return dbPromise;
  };

  return {
    async write(sourceId: string, bytes: Uint8Array): Promise<void> {
      assertValidSourceId(sourceId);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_MOBILE_LOCAL_PLAYLIST_BYTES) {
        throw new Error('local playlist byte length out of bounds');
      }
      const db = await ensureDb();
      await db.run('INSERT OR REPLACE INTO local_playlists (source_id, payload) VALUES (?, ?)', [
        sourceId,
        encodeBase64(bytes),
      ]);
    },

    async openRead(sourceId: string): Promise<AsyncIterable<Uint8Array> | undefined> {
      assertValidSourceId(sourceId);
      const db = await ensureDb();
      const rows = await db.all<{ payload: string }>(
        'SELECT payload FROM local_playlists WHERE source_id = ?',
        [sourceId],
      );
      const first = rows[0];
      if (first === undefined) return undefined;
      const bytes = decodeBase64(first.payload);
      return {
        async *[Symbol.asyncIterator]() {
          for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
            yield bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_BYTES));
          }
        },
      };
    },

    async remove(sourceId: string): Promise<void> {
      if (!SOURCE_ID.test(sourceId)) return;
      const db = await ensureDb();
      await db.run('DELETE FROM local_playlists WHERE source_id = ?', [sourceId]);
    },
  };
}
