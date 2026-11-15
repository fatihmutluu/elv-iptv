import type { SecretStore } from '@elv/domain';
import * as SecureStore from 'expo-secure-store';

const CHUNK_BYTES = 1800;
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const COUNT_PATTERN = /^(0|[1-9][0-9]{0,5})$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('secret key must match [A-Za-z0-9._-]+');
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/** Splits at code point boundaries so every chunk is at most CHUNK_BYTES of UTF-8. */
function chunkValue(value: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let size = 0;
  let index = 0;
  for (const char of value) {
    const width = utf8Length(char.codePointAt(0) ?? 0);
    if (size + width > CHUNK_BYTES) {
      chunks.push(value.slice(start, index));
      start = index;
      size = 0;
    }
    size += width;
    index += char.length;
  }
  if (index > start) chunks.push(value.slice(start, index));
  return chunks;
}

async function readCount(key: string): Promise<number | undefined> {
  const raw = await SecureStore.getItemAsync(`${key}.n`);
  return raw !== null && COUNT_PATTERN.test(raw) ? Number(raw) : undefined;
}

async function readPrior(
  key: string,
): Promise<{ count: number; validChunks: string[] | undefined }> {
  let count: number | undefined;
  try {
    count = await readCount(key);
  } catch {
    return { count: 0, validChunks: undefined };
  }
  if (count === undefined) return { count: 0, validChunks: undefined };
  try {
    const chunks: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const chunk = await SecureStore.getItemAsync(`${key}.${i}`);
      if (chunk === null) return { count, validChunks: undefined };
      chunks.push(chunk);
    }
    return { count, validChunks: chunks };
  } catch {
    return { count, validChunks: undefined };
  }
}

async function deleteChunks(key: string, from: number, to: number): Promise<void> {
  for (let i = from; i < to; i += 1) await SecureStore.deleteItemAsync(`${key}.${i}`);
}

function serialize<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const result = prev.then(fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return result;
}

/**
 * `SecretStore` over the platform secure store (Keychain, Keystore). Values are split into chunks of at most
 * 1,800 UTF-8 bytes under `<key>.<i>` with the count under `<key>.n`, because the stores cap one entry's size.
 * Calls for the same key are serialized through an async queue so concurrent writes and reads never observe torn chunks.
 * A missing chunk, a bad index or a store error reads as no secret; values are never logged.
 */
export function createSecureSecretStore(): SecretStore {
  const queues = new Map<string, Promise<unknown>>();

  return {
    async get(key) {
      assertKey(key);
      return serialize(queues, key, async () => {
        try {
          const count = await readCount(key);
          if (count === undefined) return undefined;
          let value = '';
          for (let i = 0; i < count; i += 1) {
            const chunk = await SecureStore.getItemAsync(`${key}.${i}`);
            if (chunk === null) return undefined;
            value += chunk;
          }
          return value;
        } catch {
          return undefined;
        }
      });
    },

    async set(key, value) {
      assertKey(key);
      return serialize(queues, key, async () => {
        const prior = await readPrior(key);
        const previous = prior.count;
        const chunks = chunkValue(value);
        try {
          // The index goes first and last so a crash midway never leaves a mixed secret.
          await SecureStore.deleteItemAsync(`${key}.n`);
          for (const [i, chunk] of chunks.entries())
            await SecureStore.setItemAsync(`${key}.${i}`, chunk);
          await deleteChunks(key, chunks.length, previous);
          await SecureStore.setItemAsync(`${key}.n`, String(chunks.length));
        } catch (error) {
          const bound = Math.max(chunks.length, previous);
          if (prior.validChunks !== undefined) {
            try {
              await SecureStore.deleteItemAsync(`${key}.n`);
              for (const [i, chunk] of prior.validChunks.entries()) {
                await SecureStore.setItemAsync(`${key}.${i}`, chunk);
              }
              await deleteChunks(key, prior.validChunks.length, bound);
              await SecureStore.setItemAsync(`${key}.n`, String(prior.validChunks.length));
              throw error;
            } catch (restoreErr) {
              if (restoreErr === error) throw error;
            }
          }
          await SecureStore.deleteItemAsync(`${key}.n`).catch(() => undefined);
          for (let i = 0; i < bound; i += 1) {
            await SecureStore.deleteItemAsync(`${key}.${i}`).catch(() => undefined);
          }
          throw error;
        }
      });
    },

    async delete(key) {
      assertKey(key);
      return serialize(queues, key, async () => {
        const count = (await readCount(key).catch(() => undefined)) ?? 0;
        await deleteChunks(key, 0, count);
        let misses = 0;
        for (let i = count; misses < 4; i += 1) {
          const orphan = await SecureStore.getItemAsync(`${key}.${i}`);
          if (orphan === null) {
            misses += 1;
          } else {
            misses = 0;
            await SecureStore.deleteItemAsync(`${key}.${i}`);
          }
        }
        await SecureStore.deleteItemAsync(`${key}.n`);
      });
    },
  };
}
